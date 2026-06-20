import { existsSync, realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { defineCommand } from "citty";
import { countTranscriptEntries } from "../core/claude-session.ts";
import {
  type JudgeJob,
  acquireJudgeLock,
  clearJudgeQueue,
  enqueueJudgeJob,
  readJudgeJobs,
  releaseJudgeLock,
  writeJudgeStatus,
} from "../core/insights/judge-queue.ts";
import {
  DEFAULT_MAX_JUDGE_CANDIDATES,
  JUDGMENTS_SCHEMA_VERSION,
  type JudgeRunner,
  defaultJudgeRunner,
  mergeJudgments,
  selectCandidatesToJudge,
} from "../core/insights/judgments.ts";
import {
  commitInsights,
  ensureInsightsStore,
  getOrComputeMetrics,
  readJudgment,
  writeJudgment,
} from "../core/insights/store.ts";
import { applyRootOverride, workspacesRoot } from "../core/paths.ts";
import { servantReinvokeArgv } from "../core/self-exec.ts";
import { detectWorkspaceNameFromCwd } from "../core/workspace.ts";

// The judgment pass (Tier 2 of the insights model) mirrors memory extraction: the SessionEnd hook
// enqueues a job (instant), a lockfile-serialized drainer runs a headless `claude -p` that reads
// only the anchored spans of the session's deterministic candidates and writes a per-session
// judgment record. Best-effort — it never blocks or fails the user's session.

// Same floor as extraction: a handful of turns rarely carries candidates worth a headless run.
const MIN_ENTRIES = 6;

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p.replace(/\/+$/, "");
  }
}

function isUnder(child: string, parent: string): boolean {
  const c = canonical(child);
  const p = canonical(parent);
  return c === p || c.startsWith(`${p}/`);
}

interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  reason?: string;
}

/**
 * `--from-hook`: instant, dumb enqueue from the SessionEnd payload. NEVER spawns claude and NEVER
 * blocks session close. The `SERVANT_INSIGHTS` guard is the re-entry stop: the drainer runs its
 * headless `claude -p` with it set, the hook subprocess inherits it, so the judging run's own
 * session end is ignored here. (`SERVANT_EXTRACTION` is also honored so the memory-extraction
 * headless run never triggers a judgment pass on itself either.)
 */
export async function runJudgeFromHook(
  stdin: string,
  opts: { kick?: boolean } = {},
): Promise<void> {
  if (process.env.SERVANT_INSIGHTS || process.env.SERVANT_EXTRACTION) return; // servant's own run

  let payload: HookPayload;
  try {
    payload = JSON.parse(stdin) as HookPayload;
  } catch {
    return; // malformed payload — silently ignore
  }

  const cwd = payload.cwd ?? "";
  const transcriptPath = payload.transcript_path ?? "";
  const sessionId = payload.session_id ?? "";
  if (!cwd || !isUnder(cwd, workspacesRoot())) return; // non-servant session
  if (!transcriptPath || !existsSync(transcriptPath)) return;
  if ((await countTranscriptEntries(transcriptPath)) < MIN_ENTRIES) return;

  await enqueueJudgeJob({
    session_id: sessionId,
    transcript_path: transcriptPath,
    workspace: detectWorkspaceNameFromCwd(cwd, workspacesRoot()),
    cwd,
    ts: Date.now(),
  });

  if (opts.kick !== false) kickDrainer();
}

/** Spawn a detached drainer. Best-effort — failure to kick just means it drains next time. */
function kickDrainer(): void {
  try {
    Bun.spawn([...servantReinvokeArgv(), "insights-judge", "--drain"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env },
    }).unref();
  } catch {
    // ignore — non-fatal
  }
}

/** Keep only the latest job per session (a burst of /clears enqueues the same session). */
function dedupeJobs(jobs: JudgeJob[]): JudgeJob[] {
  const bySession = new Map<string, JudgeJob>();
  for (const job of jobs) bySession.set(job.session_id, job);
  return [...bySession.values()];
}

/**
 * `--drain`: lockfile-serialized worker. For each queued session, judge only the candidates not
 * already judged, up to the per-session cap, and merge into the session's judgment record. A run
 * that has nothing new to judge for a session is a no-op for that session.
 */
export async function runJudgeDrain(
  opts: { runner?: JudgeRunner; maxCandidates?: number } = {},
): Promise<{ processed: number; judged: number; skipped: boolean }> {
  if (!(await acquireJudgeLock())) return { processed: 0, judged: 0, skipped: true };
  const runner = opts.runner ?? defaultJudgeRunner;
  const cap = opts.maxCandidates ?? DEFAULT_MAX_JUDGE_CANDIDATES;
  let processed = 0;
  let judged = 0;
  let firstError: string | undefined;
  try {
    await ensureInsightsStore();
    const jobs = dedupeJobs(await readJudgeJobs());
    await clearJudgeQueue();
    for (const job of jobs) {
      try {
        const { mtimeMs } = await stat(job.transcript_path);
        const record = await getOrComputeMetrics(job.transcript_path, mtimeMs);
        const existing = (await readJudgment(job.session_id))?.judgments ?? [];
        const toJudge = selectCandidatesToJudge(record.candidates, existing, cap);
        if (toJudge.length === 0) continue; // already judged (or no candidates) — idempotent no-op
        const { judgments } = await runner({ job, candidates: toJudge });
        const merged = mergeJudgments(existing, judgments);
        await writeJudgment({
          schema: JUDGMENTS_SCHEMA_VERSION,
          sessionId: job.session_id,
          judgments: merged,
        });
        judged += judgments.length;
        processed += 1;
      } catch (err) {
        if (!firstError) firstError = err instanceof Error ? err.message : String(err);
      }
    }
    if (processed > 0) {
      await commitInsights("insights: judge session candidates");
    }
  } finally {
    await releaseJudgeLock();
  }
  await writeJudgeStatus({
    ts: Date.now(),
    processed,
    ...(judged > 0 ? { judged } : {}),
    ...(firstError ? { error: firstError } : {}),
  });
  return { processed, judged, skipped: false };
}

export const insightsJudgeCommand = defineCommand({
  meta: {
    name: "insights-judge",
    description:
      "Qualitatively judge a session's deterministic insight candidates (Tier 2). Internal modes wire the SessionEnd hook (--from-hook enqueues, --drain runs the headless pass).",
  },
  args: {
    "from-hook": {
      type: "boolean",
      required: false,
      default: false,
      description:
        "Internal: SessionEnd hook entry. Reads the payload on stdin and enqueues a judgment job.",
    },
    drain: {
      type: "boolean",
      required: false,
      default: false,
      description: "Internal: drain the judgment queue (lockfile-serialized headless worker).",
    },
    root: {
      type: "string",
      required: false,
      description: "Servant root directory (default: ~/.ai_servant). For throwaway/test setups.",
    },
  },
  async run({ args }) {
    applyRootOverride(args.root);
    if (args["from-hook"]) {
      await runJudgeFromHook(await Bun.stdin.text());
      return;
    }
    if (args.drain) {
      await runJudgeDrain();
      return;
    }
    throw new Error(
      "servant insights-judge: internal command — rely on the SessionEnd hook (--from-hook / --drain).",
    );
  },
});
