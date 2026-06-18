import { stat } from "node:fs/promises";
import { defineCommand } from "citty";
import { findSessionJsonl, listWorkspaceSessions } from "../core/claude-session.ts";
import {
  type Area,
  buildDigest,
  renderDigest,
  renderSessionTimeline,
} from "../core/insights/digest.ts";
import { readNoteFilesFrom, scanKnowledgeHealth } from "../core/insights/knowledge-health.ts";
import type { SessionMetrics } from "../core/insights/metrics.ts";
import {
  commitInsights,
  ensureInsightsStore,
  getOrComputeMetrics,
  readChanges,
  rebuildInsightsIndex,
} from "../core/insights/store.ts";
import { applyRootOverride } from "../core/paths.ts";

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
      description: "Reserved: run an optional `claude -p` qualitative pass (no-op in v1).",
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

    // Single-session drill-down: the context-growth curve and what drove it, no aggregation.
    if (args.session) {
      const jsonlPath = await findSessionJsonl(args.session);
      if (!jsonlPath) throw new Error(`No transcript found for session "${args.session}".`);
      const { mtimeMs } = await stat(jsonlPath);
      const record = await getOrComputeMetrics(jsonlPath, mtimeMs);
      console.log(args.json ? JSON.stringify(record, null, 2) : renderSessionTimeline(record));
      return;
    }

    const area = VALID_AREAS.includes(args.area as Area) ? (args.area as Area) : undefined;
    if (args.area && !area) {
      throw new Error(`Invalid --area "${args.area}" (expected: ${VALID_AREAS.join(" | ")}).`);
    }

    const { maxAgeMs, label: windowLabel } = resolveWindow(args, now);
    const workspaceLabel = args.workspace ? `workspace ${args.workspace}` : "all workspaces";

    const sessions = await listWorkspaceSessions({
      workspaceName: args.workspace,
      maxAgeMs,
    });

    await ensureInsightsStore();
    const records: SessionMetrics[] = [];
    for (const s of sessions) {
      try {
        records.push(await getOrComputeMetrics(s.jsonlPath, s.mtimeMs));
      } catch {
        // skip sessions we can't parse
      }
    }

    const readNoteFiles = readNoteFilesFrom(records.map((r) => r.knowledge.knowledgeReads));
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

    if (args.deep) {
      console.log("\n(--deep qualitative pass is reserved for a future release; no-op for now.)");
    }
  },
});
