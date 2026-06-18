import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractSessionMetrics } from "../src/core/insights/metrics.ts";
import { setRootOverride } from "../src/core/paths.ts";

let tmpRoot: string;
let workspace: string;
let worktree: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "servant-insights-metrics-"));
  setRootOverride(tmpRoot);
  workspace = join(tmpRoot, "workspaces", "ws-alpha");
  worktree = join(workspace, "repos", "api-gw__main");
  await mkdir(worktree, { recursive: true });
});

afterEach(async () => {
  setRootOverride(null);
  await rm(tmpRoot, { recursive: true, force: true });
});

/** Write a fixture transcript and return its path. */
async function writeFixture(records: unknown[]): Promise<string> {
  const dir = join(tmpRoot, "projects", "enc");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "11111111-2222-3333-4444-555555555555.jsonl");
  await writeFile(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return path;
}

describe("extractSessionMetrics", () => {
  test("computes token curve, tool buckets, slash usage, knowledge, and rule violations", async () => {
    const bigRead = "x".repeat(8000);
    const planPath = join(worktree, "docs", "plans", "scratch.md");
    const knowledgePath = join(tmpRoot, "knowledge", "projects", "api-gw", "auth-flow.md");

    const path = await writeFixture([
      // launch + version carrier
      { type: "user", cwd: worktree, version: "2.1.99", message: { role: "user", content: "go" } },
      // assistant turn: usage + a Read tool_use + a Write to an in-repo plan path
      {
        type: "assistant",
        cwd: worktree,
        message: {
          role: "assistant",
          model: "claude-opus-4-7",
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 500,
            output_tokens: 200,
          },
          content: [
            { type: "text", text: "working" },
            { type: "tool_use", id: "tu-read", name: "Read", input: { file_path: knowledgePath } },
            { type: "tool_use", id: "tu-write", name: "Write", input: { file_path: planPath } },
          ],
        },
      },
      // tool results (in a user record)
      {
        type: "user",
        cwd: worktree,
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu-read", content: bigRead },
            { type: "tool_result", tool_use_id: "tu-write", content: "ok" },
          ],
        },
      },
      // a slash-command turn (recall)
      {
        type: "user",
        cwd: worktree,
        message: { role: "user", content: "<command-name>/servant:recall</command-name> auth" },
      },
      // a second assistant turn with a larger context to advance the curve
      {
        type: "assistant",
        cwd: worktree,
        message: {
          role: "assistant",
          model: "claude-opus-4-7",
          usage: {
            input_tokens: 5,
            cache_read_input_tokens: 4000,
            cache_creation_input_tokens: 0,
            output_tokens: 50,
          },
          content: [{ type: "text", text: "done" }],
        },
      },
    ]);

    const m = await extractSessionMetrics(path);

    // token curve
    expect(m.tokens.peakContext).toBe(4005); // 5 + 4000 + 0
    expect(m.tokens.finalContext).toBe(4005);
    expect(m.tokens.totalOutput).toBe(250);

    // per-turn context-growth curve: two usage turns; the 2nd jump is driven by the Read result.
    expect(m.tokens.contextCurve.map((p) => p.context)).toEqual([1510, 4005]);
    expect(m.tokens.contextCurve[0]?.turn).toBe(1);
    expect(m.tokens.contextCurve[1]?.delta).toBe(2495);
    // The big Read tool_result landed between turn 1 and turn 2, so it drives turn 2's jump.
    expect(m.tokens.contextCurve[1]?.drivers[0]?.tool).toBe("Read");
    expect(m.tokens.contextCurve[1]?.drivers[0]?.approxTokens).toBe(2000);
    expect(m.tokens.cacheReadTokens).toBe(5000);
    expect(m.tokens.cacheCreationTokens).toBe(500);
    expect(m.tokens.contextWindowSize).toBe(200_000);

    // tool-size buckets: Read should dominate, Write tiny
    const read = m.tokens.toolBuckets.find((b) => b.tool === "Read");
    expect(read?.chars).toBe(8000);
    expect(read?.approxTokens).toBe(2000);
    expect(m.tokens.topToolResults[0]?.tool).toBe("Read");
    expect(m.tokens.topToolResults[0]?.target).toBe(knowledgePath);

    // slash usage + knowledge
    expect(m.instructions.slashCommands.find((c) => c.name === "/servant:recall")?.count).toBe(1);
    expect(m.knowledge.recallInvocations).toBe(1);
    expect(m.knowledge.knowledgeReads).toContain(knowledgePath);

    // workspace + repo derivation
    expect(m.workspace).toBe("ws-alpha");
    expect(m.repos).toContain("api-gw__main");

    // rule violation: a Write into docs/plans inside a repo worktree
    const viol = m.instructions.ruleViolations.find((v) => v.rule === "no-plans-in-repo");
    expect(viol).toBeDefined();
    expect(viol?.detail).toContain("scratch.md");

    // a deterministic fingerprint is assigned
    expect(m.setupFingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(m.version).toBe("2.1.99");
  });
});
