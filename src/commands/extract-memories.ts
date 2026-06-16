import { existsSync, realpathSync } from "node:fs";
import { defineCommand } from "citty";
import { countTranscriptEntries } from "../core/claude-session.ts";
import { buildExtractionPrompt } from "../core/extract-prompt.ts";
import {
  type ExtractJob,
  acquireLock,
  clearQueue,
  enqueueJob,
  getMarker,
  readJobs,
  releaseLock,
  setMarker,
  writeDrainStatus,
} from "../core/extract-queue.ts";
import { commitKnowledge, reconcileAllIndexes } from "../core/knowledge.ts";
import { applyRootOverride, knowledgeRoot, workspacesRoot } from "../core/paths.ts";
import { detectWorkspaceNameFromCwd } from "../core/workspace.ts";

// Minimum transcript entries before a session is worth extracting from. A handful of
// turns rarely contains a durable fact and isn't worth a headless run.
const MIN_ENTRIES = 6;

// Resolve symlinks so a child reported as /private/var/... still matches a parent at
// /var/... (macOS reports the SessionEnd cwd realpath'd). Falls back to the raw path
// when it doesn't exist on disk.
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
 * `--from-hook`: instant, dumb enqueue. Reads the SessionEnd JSON payload on stdin,
 * applies the loop/cwd/size guards, appends a job, and kicks the drainer. NEVER spawns
 * claude and NEVER blocks session close — always resolves quickly.
 *
 * The single most important guard is `SERVANT_EXTRACTION`: the drainer runs its headless
 * `claude -p` with that env set, the hook subprocess inherits it, so the extraction's own
 * session end is ignored here — closing the capture loop without depending on CLI flags.
 */
export async function runFromHook(stdin: string, opts: { kick?: boolean } = {}): Promise<void> {
  if (process.env.SERVANT_EXTRACTION) return; // the extraction's own session — never re-enqueue

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

  await enqueueJob({
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
    const args = [process.argv[1] ?? "", "extract-memories", "--drain"];
    Bun.spawn([process.execPath, ...args], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env },
    }).unref();
  } catch {
    // ignore — non-fatal
  }
}

/**
 * Run headless `claude -p` for one job and return the agent's final summary line. Throws
 * on non-zero exit. Flags:
 * - `--dangerously-skip-permissions`: the extraction reads the transcript, writes notes,
 *   and runs `servant ... --reconcile` (Bash) unattended; in `-p` mode any tool needing
 *   approval is auto-DENIED (no way to prompt), which would silently produce zero notes.
 *   Bypassing is acceptable here — it only touches the servant's own knowledge store.
 * - `--add-dir <knowledge>`: bring the store (outside the workspace cwd) into tool scope.
 */
export type ExtractionRunner = (job: ExtractJob, prompt: string) => Promise<string>;

const defaultRunner: ExtractionRunner = async (job, prompt) => {
  const proc = Bun.spawn(
    [
      "claude",
      "-p",
      prompt,
      "--output-format",
      "text",
      "--dangerously-skip-permissions",
      "--add-dir",
      knowledgeRoot(),
    ],
    {
      cwd: job.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, SERVANT_EXTRACTION: "1" },
    },
  );
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`claude -p exited ${code}: ${err.trim().slice(0, 200)}`);
  }
  // The prompt asks the agent to end with a one-line summary ("added/updated N notes").
  const out = (await new Response(proc.stdout).text()).trim();
  const lastLine = out.split("\n").filter(Boolean).pop() ?? "";
  return lastLine.slice(0, 200);
};

/** Keep only the latest job per session (a burst of /clears enqueues the same session). */
function dedupeJobs(jobs: ExtractJob[]): ExtractJob[] {
  const bySession = new Map<string, ExtractJob>();
  for (const job of jobs) bySession.set(job.session_id, job);
  return [...bySession.values()];
}

/**
 * `--drain`: lockfile-serialized worker. Processes each queued job with a headless
 * extraction, advancing the per-session turn marker so only new turns are read. Only one
 * drainer ever runs; if the lock is held, this is a no-op.
 */
export async function runDrain(
  opts: { runner?: ExtractionRunner } = {},
): Promise<{ processed: number; skipped: boolean }> {
  if (!(await acquireLock())) return { processed: 0, skipped: true };
  const runner = opts.runner ?? defaultRunner;
  let processed = 0;
  let firstError: string | undefined;
  const summaries: string[] = [];
  try {
    const jobs = dedupeJobs(await readJobs());
    await clearQueue();
    for (const job of jobs) {
      try {
        const total = await countTranscriptEntries(job.transcript_path);
        const fromTurn = await getMarker(job.session_id);
        if (total - fromTurn < 1) continue; // nothing new since last extraction
        const prompt = buildExtractionPrompt({
          transcriptPath: job.transcript_path,
          fromTurn,
          cwd: job.cwd,
        });
        const summary = (await runner(job, prompt)) || "";
        if (summary) summaries.push(summary);
        await setMarker(job.session_id, total);
        processed += 1;
      } catch (err) {
        if (!firstError) firstError = err instanceof Error ? err.message : String(err);
      }
    }
    // Reconcile + commit in-process (NOT delegated to the headless agent): the drainer knows
    // the correct root, so indexes/commit always target the store the notes were written to.
    if (processed > 0) {
      await reconcileAllIndexes();
      await commitKnowledge("memory: extract session knowledge");
    }
  } finally {
    await releaseLock();
  }
  await writeDrainStatus({
    ts: Date.now(),
    processed,
    ...(summaries.length > 0 ? { summaries } : {}),
    ...(firstError ? { error: firstError } : {}),
  });
  return { processed, skipped: false };
}

/** `--reconcile`: rebuild every per-repo index + the thin master from notes on disk, then commit. */
export async function runReconcile(message?: string): Promise<void> {
  await reconcileAllIndexes();
  await commitKnowledge(message?.trim() || "memory: extract session knowledge");
}

export const extractMemoriesCommand = defineCommand({
  meta: {
    name: "extract-memories",
    description:
      "Capture durable knowledge from servant sessions into ~/.ai_servant/knowledge/. Internal modes wire the SessionEnd hook; --reconcile rebuilds indexes and commits.",
  },
  args: {
    "from-hook": {
      type: "boolean",
      required: false,
      default: false,
      description:
        "Internal: SessionEnd hook entry. Reads the payload on stdin and enqueues a job.",
    },
    drain: {
      type: "boolean",
      required: false,
      default: false,
      description: "Internal: drain the extraction queue (lockfile-serialized headless worker).",
    },
    reconcile: {
      type: "boolean",
      required: false,
      default: false,
      description: "Rebuild all knowledge indexes from notes on disk and git-commit the store.",
    },
    message: {
      type: "string",
      required: false,
      alias: "m",
      description: "With --reconcile: the git commit message.",
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
      await runFromHook(await Bun.stdin.text());
      return;
    }
    if (args.drain) {
      await runDrain();
      return;
    }
    if (args.reconcile) {
      await runReconcile(args.message);
      return;
    }
    throw new Error(
      "servant extract-memories: pass --reconcile (in-session) or rely on the SessionEnd hook (--from-hook / --drain).",
    );
  },
});
