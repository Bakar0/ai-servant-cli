import { stat } from "node:fs/promises";
import { defineCommand } from "citty";
import { DEFAULT_AGENT } from "../agents/index.ts";
import { type SessionMeta, type SessionSource, getSessionSource } from "../core/session-source.ts";
import { renderDashboard } from "../core/insights/dashboard.ts";
import {
  type Area,
  buildDigest,
  renderDigest,
  renderSessionTimeline,
} from "../core/insights/digest.ts";
import type { JudgmentRecord } from "../core/insights/judgments.ts";
import { readNoteFilesFrom, scanKnowledgeHealth } from "../core/insights/knowledge-health.ts";
import type { SessionMetrics } from "../core/insights/metrics.ts";
import {
  commitInsights,
  ensureInsightsStore,
  getOrComputeMetrics,
  readChanges,
  readJudgment,
  rebuildInsightsIndex,
  writeDashboard,
} from "../core/insights/store.ts";
import { openInDefaultApp } from "../core/open.ts";
import { applyRootOverride } from "../core/paths.ts";
import { readWorkspaceAgent, resolveWorkspaceName } from "../core/workspace.ts";
import { pickSession } from "../ui/resume-picker.ts";

// Backends whose session stores an unscoped digest unions over; also the search order for a bare
// `--session <id>` with no `--agent`.
const KNOWN_BACKENDS = ["claude-code", "codex"] as const;

/** The backend driving a workspace (its `.servant/agent` marker), defaulting to Claude. */
async function backendForWorkspace(workspace: string | undefined): Promise<string> {
  return (workspace ? await readWorkspaceAgent(workspace) : null) ?? DEFAULT_AGENT;
}

/** Locate a session id across the candidate backends' stores (explicit backend, else all). */
async function locateSession(
  id: string,
  explicitBackend: string | undefined,
): Promise<{ source: SessionSource; file: string } | null> {
  const backends = explicitBackend ? [explicitBackend] : [...KNOWN_BACKENDS];
  for (const backend of backends) {
    const source = getSessionSource(backend);
    try {
      source.validateSessionId(id);
    } catch {
      continue;
    }
    const file = await source.findSessionFile(id);
    if (file) return { source, file };
  }
  return null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 30;
const VALID_AREAS: Area[] = ["tokens", "instructions", "knowledge"];

/** Resolve the mtime window (maxAgeMs) and a human label from the window flags. */
function resolveWindow(
  args: { all?: boolean; days?: string; since?: string },
  now: number,
): { maxAgeMs: number; label: string } {
  if (args.all) return { maxAgeMs: Number.MAX_SAFE_INTEGER, label: "all time" };
  if (args.since) {
    const t = Date.parse(args.since);
    if (!Number.isNaN(t)) return { maxAgeMs: Math.max(0, now - t), label: `since ${args.since}` };
  }
  const days = Number.parseInt(args.days ?? "", 10);
  const n = Number.isFinite(days) && days > 0 ? days : DEFAULT_DAYS;
  return { maxAgeMs: n * DAY_MS, label: `last ${n}d` };
}

export const insightsCommand = defineCommand({
  meta: {
    name: "insights",
    description:
      "Transcript-driven observability across instructions, tokens, and the knowledge base. Aggregates servant sessions and segments by setup fingerprint for before/after comparison.",
  },
  args: {
    workspace: {
      type: "string",
      required: false,
      alias: "w",
      description: "Drill into one workspace (default: all servant workspaces).",
    },
    days: {
      type: "string",
      required: false,
      description: `Rolling window in days (default: ${DEFAULT_DAYS}).`,
    },
    since: {
      type: "string",
      required: false,
      description: "Window start date (e.g. 2026-06-01). Overrides --days.",
    },
    all: {
      type: "boolean",
      required: false,
      default: false,
      description: "Ignore the time window — aggregate every servant session.",
    },
    session: {
      type: "string",
      required: false,
      alias: "s",
      description:
        "Drill into one session id: show its context-growth curve, the biggest jumps, and what tools drove them.",
    },
    pick: {
      type: "boolean",
      required: false,
      default: false,
      description:
        "Pick a session interactively (fzf), previewing each session's metrics + candidate worklist. Scoped by --workspace, else auto-detected.",
    },
    preview: {
      type: "string",
      required: false,
      description: "(internal) Render the picker preview pane for a session id and exit.",
    },
    agent: {
      type: "string",
      required: false,
      description:
        "Backend whose sessions to read: claude-code | codex. Scopes --pick/--preview; a bare --session id is auto-located across both stores.",
    },
    area: {
      type: "string",
      required: false,
      description: "Focus one area: tokens | instructions | knowledge.",
    },
    json: {
      type: "boolean",
      required: false,
      default: false,
      description: "Emit the digest as JSON instead of text.",
    },
    deep: {
      type: "boolean",
      required: false,
      default: false,
      description:
        "Render a self-contained HTML dashboard (four story sections) from the same data, open it, and print its path. Deterministic: no agent, no model. Ignored when --json is also set.",
    },
    "no-open": {
      type: "boolean",
      required: false,
      default: false,
      description:
        "With --deep: write the dashboard and print its path, but don't open the browser.",
    },
    root: {
      type: "string",
      required: false,
      description: "Servant root directory (default: ~/.ai_servant). For throwaway/test setups.",
    },
  },
  async run({ args }) {
    applyRootOverride(args.root);
    const now = Date.now();

    const explicitBackend = (args.agent as string | undefined)?.trim() || undefined;

    // Internal: render the fzf preview pane for one session (used by `--pick`) and exit.
    if (typeof args.preview === "string" && args.preview.length > 0) {
      await renderSessionPreviewToStdout(args.preview, getSessionSource(explicitBackend));
      return;
    }

    // Single-session drill-down: the context-growth curve and what drove it, no aggregation.
    // With --pick (and no explicit id), choose a session via the fzf picker first.
    if (!args.session && args.pick) {
      const ws =
        (args.workspace as string | undefined) ??
        (await resolveWorkspaceName(undefined, { allowUnresolved: true })) ??
        undefined;
      const source = getSessionSource(explicitBackend ?? (await backendForWorkspace(ws)));
      const picked = await pickSession({
        workspaceName: ws,
        promptLabel: "insights> ",
        previewSubcommand: "insights",
        source,
      });
      if (!picked) return; // picker cancelled
      const file = await source.findSessionFile(picked);
      if (!file) throw new Error(`No transcript found for session "${picked}".`);
      const { mtimeMs } = await stat(file);
      const record = await getOrComputeMetrics(file, mtimeMs, { source, sessionId: picked });
      console.log(args.json ? JSON.stringify(record, null, 2) : renderSessionTimeline(record));
      return;
    }
    const sessionId = (args.session as string | undefined) ?? null;
    if (sessionId) {
      const located = await locateSession(sessionId, explicitBackend);
      if (!located) throw new Error(`No transcript found for session "${sessionId}".`);
      const { mtimeMs } = await stat(located.file);
      const record = await getOrComputeMetrics(located.file, mtimeMs, {
        source: located.source,
        sessionId,
      });
      console.log(args.json ? JSON.stringify(record, null, 2) : renderSessionTimeline(record));
      return;
    }

    const area = VALID_AREAS.includes(args.area as Area) ? (args.area as Area) : undefined;
    if (args.area && !area) {
      throw new Error(`Invalid --area "${args.area}" (expected: ${VALID_AREAS.join(" | ")}).`);
    }

    const { maxAgeMs, label: windowLabel } = resolveWindow(args, now);
    const workspaceLabel = args.workspace ? `workspace ${args.workspace}` : "all workspaces";

    // Scope to the workspace's backend when given, else union every backend's store so a
    // cross-workspace digest covers Claude and Codex sessions together.
    const sourceBackends = explicitBackend
      ? [explicitBackend]
      : args.workspace
        ? [await backendForWorkspace(args.workspace)]
        : [...KNOWN_BACKENDS];
    const sessions: { meta: SessionMeta; source: SessionSource }[] = [];
    for (const backend of sourceBackends) {
      const source = getSessionSource(backend);
      const metas = await source.listWorkspaceSessions({ workspaceName: args.workspace, maxAgeMs });
      for (const meta of metas) sessions.push({ meta, source });
    }

    await ensureInsightsStore();
    const records: SessionMetrics[] = [];
    for (const { meta, source } of sessions) {
      try {
        records.push(
          await getOrComputeMetrics(meta.jsonlPath, meta.mtimeMs, {
            source,
            sessionId: meta.sessionId,
          }),
        );
      } catch {
        // skip sessions we can't parse
      }
    }

    // Knowledge "use" is surfacing ∪ reading, so a note recall keeps surfacing inline is live too.
    const readNoteFiles = readNoteFilesFrom(
      records.map((r) => [...r.knowledge.knowledgeReads, ...r.knowledge.recallSurfacedNotes]),
    );
    const knowledgeHealth = await scanKnowledgeHealth({ readNoteFiles, now });
    const changes = await readChanges();

    const digest = buildDigest({
      records,
      changes,
      knowledgeHealth,
      now,
      windowLabel,
      workspaceLabel,
    });

    // --deep renders the visual surface from the same data and exits. --json keeps precedence
    // (the dashboard is the visual surface, not a data format), so --deep --json behaves as --json.
    if (args.deep && !args.json) {
      const judgments: JudgmentRecord[] = [];
      for (const r of records) {
        const j = await readJudgment(r.sessionId);
        if (j) judgments.push(j);
      }
      const html = renderDashboard({ digest, records, judgments, changes });
      const path = await writeDashboard(html);
      if (!args["no-open"]) openInDefaultApp(path);
      console.log(path);
      return;
    }

    if (args.json) {
      console.log(JSON.stringify(digest, null, 2));
    } else {
      const text = renderDigest(digest, { area });
      console.log(text);
      // Persist the snapshot only for the canonical full-window/all-workspaces view.
      if (!args.workspace && !area && !args.json) {
        await rebuildInsightsIndex(text);
        await commitInsights("insights: refresh digest");
      }
    }
  },
});

/** Render one session's timeline (curve, jumps, candidate worklist) for the fzf preview pane. */
async function renderSessionPreviewToStdout(id: string, source: SessionSource): Promise<void> {
  try {
    source.validateSessionId(id);
    const file = await source.findSessionFile(id);
    if (!file) {
      process.stdout.write(`<no session file found for ${id}>\n`);
      return;
    }
    const { mtimeMs } = await stat(file);
    const record = await getOrComputeMetrics(file, mtimeMs, { source, sessionId: id });
    process.stdout.write(`${renderSessionTimeline(record)}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`<could not load session: ${msg}>\n`);
  }
}
