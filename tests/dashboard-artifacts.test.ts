import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { buildWorkspaceDashboardData } from "../src/core/dashboard/data.ts";
import {
  derivePlanPhases,
  normalizeStatus,
  parseGoalText,
  parsePlansText,
} from "../src/core/dashboard/artifacts.ts";
import { workspacePath } from "../src/core/paths.ts";

describe("normalizeStatus (D2 grammar — leading-token)", () => {
  test("classifies by the leading status token, ignoring trailing prose", () => {
    expect(normalizeStatus("done — shipped & proven live: PR #9 merged")).toBe("done");
    expect(normalizeStatus("ABANDONED (2026-06-23) — voice doesn't fit")).toBe("abandoned");
    expect(normalizeStatus("blocked: waiting on upstream API")).toBe("blocked");
    expect(normalizeStatus("superseded by ADR-004")).toBe("superseded");
    expect(normalizeStatus("reversed (2026-06-23)")).toBe("reversed");
    expect(normalizeStatus("in-progress")).toBe("in-progress");
    expect(normalizeStatus("proposed")).toBe("todo");
    expect(normalizeStatus("pending review")).toBe("todo");
    expect(normalizeStatus("something nobody recognizes")).toBe("unknown");
  });

  test("trailing bucket keywords are ignored; only the leading token decides", () => {
    // Leading token is the (unknown) word `was` — the trailing `done`/`ABANDONED` are ignored.
    expect(normalizeStatus("was done, now ABANDONED")).toBe("unknown");
    // Leading token `proposed` wins over a `done` buried later (the insights-plan tag shape).
    expect(normalizeStatus("proposed; P0/P1 done, P2 re-shaped")).toBe("todo");
    expect(normalizeStatus("blocked — was once done and shipped")).toBe("blocked");
  });

  test("handles empty / undefined safely", () => {
    expect(normalizeStatus("")).toBe("unknown");
    // @ts-expect-error exercising the nullish guard
    expect(normalizeStatus(undefined)).toBe("unknown");
  });
});

describe("derivePlanPhases", () => {
  test("reads done/remaining from a compact INDEX status tag", () => {
    const phases = derivePlanPhases("proposed; P0/P1 done, P2 re-shaped, P3 obsolete", "");
    expect(phases).toEqual([
      { id: "P0", state: "done" },
      { id: "P1", state: "done" },
      { id: "P2", state: "remaining" },
      { id: "P3", state: "remaining" },
    ]);
  });

  test("reads a per-phase marker from a long build-phase bullet line", () => {
    const body = [
      "## Build phases",
      "- **P0 — Skeleton.** New command. Gate green. ✓ done",
      "- **P1 — Parsers.** The artifact readers.",
      "- **P2 — Insights.** Wire metrics.",
    ].join("\n");
    const phases = derivePlanPhases("proposed", body);
    expect(phases).toEqual([
      { id: "P0", state: "done", label: "Skeleton" },
      { id: "P1", state: "remaining", label: "Parsers" },
      { id: "P2", state: "remaining", label: "Insights" },
    ]);
  });

  test("reads alternating-suffix ids and inline ✓ markers", () => {
    const phases = derivePlanPhases("", "anchors (P0 ✓) → judgments (P1 ✓) → P2a split, P2b later");
    expect(phases).toEqual([
      { id: "P0", state: "done" },
      { id: "P1", state: "done" },
      { id: "P2a", state: "remaining" },
      { id: "P2b", state: "remaining" },
    ]);
  });

  test("recognizes the ✅ emoji as a done marker in a roadmap bullet", () => {
    const body = [
      "## Build phases",
      "- **P0 — Skeleton.** ✅ done. Scaffold the command.",
      "- **P1 — Parsers.** ✅ done. The artifact readers.",
      "- **P2 — Insights.** Wire metrics.",
    ].join("\n");
    expect(derivePlanPhases("proposed", body)).toEqual([
      { id: "P0", state: "done", label: "Skeleton" },
      { id: "P1", state: "done", label: "Parsers" },
      { id: "P2", state: "remaining", label: "Insights" },
    ]);
  });

  test("parses multi-word labels from `**P# — Label**` headings, stopping at the bold close", () => {
    const body = [
      "- **P5 — Re-author the 4 panels** ◀ **now** (brief R3) — the only template work.",
      "- **P6 — Tests + gate** (brief R4) — no-network + data-slot tests.",
    ].join("\n");
    expect(derivePlanPhases("", body)).toEqual([
      { id: "P5", state: "remaining", label: "Re-author the 4 panels" },
      { id: "P6", state: "remaining", label: "Tests + gate" },
    ]);
  });

  test("compact status-tag phases carry no label (no heading to parse)", () => {
    expect(derivePlanPhases("P0/P1 done, P2 later", "")).toEqual([
      { id: "P0", state: "done" },
      { id: "P1", state: "done" },
      { id: "P2", state: "remaining" },
    ]);
  });

  test("no phase ids anywhere → empty list", () => {
    expect(derivePlanPhases("done", "A plan body with no phase markers at all.")).toEqual([]);
  });
});

describe("parseGoalText", () => {
  test("extracts the one-line mission across wrapped lines", () => {
    const goal = parseGoalText(
      [
        "# Goal",
        "## Mission",
        "Build and improve the `servant` CLI tooling —",
        "the system that manages workspaces.",
        "## KPIs / success signals",
        "- New features land and work end-to-end.",
      ].join("\n"),
    );
    expect(goal.mission).toContain("Build and improve the servant CLI tooling");
    expect(goal.mission).toContain("manages workspaces");
  });

  test("strips the unfilled-goal marker", () => {
    const goal = parseGoalText("## Mission\nservant:goal:unfilled");
    expect(goal.mission).toBe("");
  });

  test("missing / empty input → empty-but-valid Goal", () => {
    expect(parseGoalText("")).toEqual({ mission: "" });
    expect(parseGoalText("# Goal\nno mission heading here")).toEqual({ mission: "" });
  });
});

describe("parsePlansText", () => {
  test("is tolerant of the plans ordering (status right after the link)", () => {
    const idx = [
      "# Plans",
      "- [a.md](a.md) — [status: done] Batch reconciler. Merged in PR #8.",
      "- [b.md](b.md) — [status: proposed] Dashboard work.",
    ].join("\n");
    const bodies: Record<string, string> = {
      "a.md": "A reconciler with no phases.",
      "b.md": "- **P0 — Skeleton.** done ✓\n- **P1 — Parsers.** later",
    };
    const plans = parsePlansText(idx, (t) => bodies[t] ?? null);
    expect(plans[0]).toMatchObject({
      status: "done",
      summary: "Batch reconciler. Merged in PR #8.",
      totalCount: 0,
    });
    expect(plans[1]).toMatchObject({ status: "todo", doneCount: 1, totalCount: 2 });
  });
});

// ── Live workspace smoke test (the real GOAL.md / plans INDEX) ─────────────────────────────────────
// Read-only; skipped where this servant workspace isn't on disk (e.g. a bare CI checkout).
const WORKSPACE = "ai_servant";
const HAS_WORKSPACE = existsSync(workspacePath(WORKSPACE));

describe.skipIf(!HAS_WORKSPACE)("against the live ai_servant workspace", () => {
  test("mission is the GOAL.md mission line", () => {
    const data = buildWorkspaceDashboardData(WORKSPACE);
    expect(data.mission.length).toBeGreaterThan(0);
    expect(data.mission.toLowerCase()).toContain("servant");
  });

  test("whereWeAre lists plans with phases + done/total counts", () => {
    const { whereWeAre } = buildWorkspaceDashboardData(WORKSPACE);
    const plan = whereWeAre.plans.find((p) => p.title.includes("workspace dashboard"));
    expect(plan).toBeDefined();
    expect(plan?.totalCount).toBeGreaterThan(0);
    expect(plan?.doneCount).toBeGreaterThan(0);
    expect(plan?.doneCount).toBeLessThanOrEqual(plan?.totalCount ?? 0);
  });

  test("current marks the first non-done phase of the most-recent active plan (workspace-dashboard)", () => {
    const { whereWeAre } = buildWorkspaceDashboardData(WORKSPACE);
    expect(whereWeAre.current).toBeDefined();
    expect(whereWeAre.current?.planTitle).toBe("workspace dashboard");
    const plan = whereWeAre.plans.find((p) => p.title === whereWeAre.current?.planTitle);
    const phase = plan?.phases.find((ph) => ph.id === whereWeAre.current?.phaseId);
    expect(phase?.state).not.toBe("done");
  });
});
