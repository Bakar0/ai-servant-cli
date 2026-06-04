import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let scratch: string;
let aiServantRoot: string;
let claudeProjectsRoot: string;
const originalAiServantRoot = process.env.AI_SERVANT_ROOT;
const originalClaudeRoot = process.env.CLAUDE_PROJECTS_ROOT;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "servant-resume-test-"));
  aiServantRoot = join(scratch, ".ai_servant");
  claudeProjectsRoot = join(scratch, ".claude", "projects");
  await mkdir(aiServantRoot, { recursive: true });
  await mkdir(claudeProjectsRoot, { recursive: true });
  process.env.AI_SERVANT_ROOT = aiServantRoot;
  process.env.CLAUDE_PROJECTS_ROOT = claudeProjectsRoot;
});

afterAll(async () => {
  if (originalAiServantRoot === undefined) {
    Reflect.deleteProperty(process.env, "AI_SERVANT_ROOT");
  } else {
    process.env.AI_SERVANT_ROOT = originalAiServantRoot;
  }
  if (originalClaudeRoot === undefined) {
    Reflect.deleteProperty(process.env, "CLAUDE_PROJECTS_ROOT");
  } else {
    process.env.CLAUDE_PROJECTS_ROOT = originalClaudeRoot;
  }
  await rm(scratch, { recursive: true, force: true });
});

const { resumeCommand, buildResumeCommand, resolveWorkspaceTitle, formatPreview } = await import(
  "../src/commands/resume.ts"
);
const { encodeProjectDir } = await import("../src/core/claude-session.ts");
const { __registerDriverForTesting } = await import("../src/terminals/index.ts");
const { runCommand } = await import("citty");

async function writeSimpleSession(launchCwd: string, sessionId: string): Promise<void> {
  const dir = join(claudeProjectsRoot, encodeProjectDir(launchCwd));
  await mkdir(dir, { recursive: true });
  const lines = [
    JSON.stringify({
      type: "user",
      cwd: launchCwd,
      message: { role: "user", content: "kick off" },
    }),
    JSON.stringify({
      type: "assistant",
      cwd: launchCwd,
      message: { role: "assistant", content: [{ type: "text", text: "ack" }] },
    }),
  ];
  await writeFile(join(dir, `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
}

describe("buildResumeCommand", () => {
  test("emits claude --resume with the id", () => {
    expect(buildResumeCommand("8fe571f6-c7dc-4f25-abcc-1bfd5f922e5e")).toBe(
      "claude --resume '8fe571f6-c7dc-4f25-abcc-1bfd5f922e5e'",
    );
  });

  test("appends the prompt as a positional after --resume", () => {
    expect(buildResumeCommand("8fe571f6-c7dc-4f25-abcc-1bfd5f922e5e", "continue please")).toBe(
      "claude --resume '8fe571f6-c7dc-4f25-abcc-1bfd5f922e5e' 'continue please'",
    );
  });

  test("ignores blank prompts", () => {
    expect(buildResumeCommand("8fe571f6-c7dc-4f25-abcc-1bfd5f922e5e", "   ")).toBe(
      "claude --resume '8fe571f6-c7dc-4f25-abcc-1bfd5f922e5e'",
    );
  });

  test("escapes embedded single quotes", () => {
    expect(buildResumeCommand("8fe571f6-c7dc-4f25-abcc-1bfd5f922e5e", "don't stop")).toContain(
      `'don'\\''t stop'`,
    );
  });
});

describe("resolveWorkspaceTitle", () => {
  test("prefers the explicit --workspace value", () => {
    expect(resolveWorkspaceTitle("custom", join(aiServantRoot, "workspaces", "other"))).toBe(
      "custom",
    );
  });

  test("derives the workspace title from launchCwd when no explicit name", () => {
    expect(resolveWorkspaceTitle(undefined, join(aiServantRoot, "workspaces", "foo"))).toBe("foo");
    expect(
      resolveWorkspaceTitle(undefined, join(aiServantRoot, "workspaces", "foo", "repos", "x__y")),
    ).toBe("foo");
  });

  test("returns null when launchCwd is outside the workspaces root", () => {
    expect(resolveWorkspaceTitle(undefined, "/tmp/unrelated")).toBeNull();
  });
});

describe("formatPreview", () => {
  test("renders headers, turns, and message dividers", () => {
    const out = formatPreview(
      {
        sessionId: "8fe571f6-c7dc-4f25-abcc-1bfd5f922e5e",
        jsonlPath: "/x.jsonl",
        launchCwd: "/Users/me/.ai_servant/workspaces/foo",
        latestCwd: "/Users/me/.ai_servant/workspaces/foo/repos/alpha__topic",
        workspaceName: "foo",
        firstUserMessage: "hi",
        lastUserMessage: "still hi",
        lastAssistantMessage: "ok",
        userTurns: 2,
        assistantTurns: 1,
        mtimeMs: Date.now() - 5_000,
      },
      undefined,
    );
    expect(out).toContain("Session   8fe571f6-c7dc-4f25-abcc-1bfd5f922e5e");
    expect(out).toContain("Workspace foo");
    expect(out).toContain("State     stored");
    expect(out).toContain("Turns     2 user / 1 assistant");
    expect(out).toContain("Launch    ");
    expect(out).toContain("Cwd now   ");
    expect(out).toContain("--- First user message ---");
    expect(out).toContain("--- Last user message ---");
    expect(out).toContain("--- Last assistant message ---");
  });

  test("omits 'Cwd now' when latestCwd matches launchCwd", () => {
    const cwd = "/Users/me/.ai_servant/workspaces/foo";
    const out = formatPreview(
      {
        sessionId: "8fe571f6-c7dc-4f25-abcc-1bfd5f922e5e",
        jsonlPath: "/x.jsonl",
        launchCwd: cwd,
        latestCwd: cwd,
        workspaceName: "foo",
        firstUserMessage: "hi",
        lastUserMessage: "hi",
        lastAssistantMessage: "ok",
        userTurns: 1,
        assistantTurns: 1,
        mtimeMs: Date.now(),
      },
      undefined,
    );
    expect(out).not.toContain("Cwd now");
  });
});

describe("resume command (non-interactive)", () => {
  type Captured = { cwd: string; command: string; title?: string } | null;

  async function runWithFakeDriver(rawArgs: string[]): Promise<Captured> {
    let captured: Captured = null;
    const fakeDriver = {
      name: "fake",
      async openTab(opts: { cwd: string; command: string; title?: string }) {
        captured = opts;
      },
    };

    const unregister = __registerDriverForTesting("fake", fakeDriver);
    try {
      await runCommand(resumeCommand, { rawArgs: [...rawArgs, "--terminal", "fake"] });
    } finally {
      unregister();
    }
    return captured;
  }

  test("happy path: resolves cwd, builds command, opens tab", async () => {
    const id = "abcd1234-2222-3333-4444-555555555555";
    const launchCwd = join(aiServantRoot, "workspaces", "happy");
    await writeSimpleSession(launchCwd, id);

    const captured = await runWithFakeDriver([id]);
    expect(captured).not.toBeNull();
    expect(captured?.cwd).toBe(launchCwd);
    expect(captured?.command).toBe(`claude --resume '${id}'`);
    expect(captured?.title).toBe("happy");
  });

  test("appends --prompt as a positional arg to claude", async () => {
    const id = "abcd5678-2222-3333-4444-555555555555";
    const launchCwd = join(aiServantRoot, "workspaces", "with-prompt");
    await writeSimpleSession(launchCwd, id);

    const captured = await runWithFakeDriver([id, "--prompt", "keep going"]);
    expect(captured?.command).toBe(`claude --resume '${id}' 'keep going'`);
  });

  test("rejects malformed session ids", async () => {
    await expect(runWithFakeDriver(["not-a-uuid"])).rejects.toThrow(/Invalid Claude session id/);
  });

  test("errors when the session file cannot be found", async () => {
    await expect(runWithFakeDriver(["99999999-9999-9999-9999-999999999999"])).rejects.toThrow(
      /No session file found/,
    );
  });
});
