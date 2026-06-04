import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let scratch: string;
let aiServantRoot: string;
let claudeProjectsRoot: string;
const originalAiServantRoot = process.env.AI_SERVANT_ROOT;
const originalClaudeRoot = process.env.CLAUDE_PROJECTS_ROOT;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "servant-session-test-"));
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

const {
  assertValidSessionId,
  encodeProjectDir,
  findSessionJsonl,
  listWorkspaceSessions,
  readLaunchCwd,
  readSessionMeta,
} = await import("../src/core/claude-session.ts");

interface TurnInput {
  cwd?: string;
  user?: string;
  assistant?: string;
}

async function writeSession(opts: {
  launchCwd: string;
  sessionId: string;
  turns: TurnInput[];
  mtimeMs?: number;
}): Promise<string> {
  const encoded = encodeProjectDir(opts.launchCwd);
  const dir = join(claudeProjectsRoot, encoded);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${opts.sessionId}.jsonl`);
  const lines: string[] = [];
  for (const t of opts.turns) {
    if (t.user !== undefined) {
      lines.push(
        JSON.stringify({
          type: "user",
          cwd: t.cwd ?? opts.launchCwd,
          message: { role: "user", content: t.user },
        }),
      );
    }
    if (t.assistant !== undefined) {
      lines.push(
        JSON.stringify({
          type: "assistant",
          cwd: t.cwd ?? opts.launchCwd,
          message: {
            role: "assistant",
            content: [{ type: "text", text: t.assistant }],
          },
        }),
      );
    }
  }
  await writeFile(path, `${lines.join("\n")}\n`);
  if (opts.mtimeMs !== undefined) {
    const t = opts.mtimeMs / 1000;
    await utimes(path, t, t);
  }
  return path;
}

describe("assertValidSessionId", () => {
  test("accepts a UUID", () => {
    expect(() => assertValidSessionId("8fe571f6-c7dc-4f25-abcc-1bfd5f922e5e")).not.toThrow();
  });
  test("rejects garbage", () => {
    expect(() => assertValidSessionId("not-a-uuid")).toThrow(/Invalid Claude session id/);
    expect(() => assertValidSessionId("")).toThrow();
  });
});

describe("encodeProjectDir", () => {
  test("matches the verified sample encoding", () => {
    const cwd = "/Users/barakmor/.ai_servant/workspaces/api_key_authority_visability";
    expect(encodeProjectDir(cwd)).toBe(
      "-Users-barakmor--ai-servant-workspaces-api-key-authority-visability",
    );
  });
});

describe("findSessionJsonl + readLaunchCwd + readSessionMeta", () => {
  test("finds and reads a written session", async () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const launchCwd = join(aiServantRoot, "workspaces", "ws-find");
    await writeSession({
      launchCwd,
      sessionId: id,
      turns: [
        { user: "first message" },
        { assistant: "first answer" },
        { user: "second message" },
        { assistant: "second answer" },
      ],
    });

    const path = await findSessionJsonl(id);
    expect(path).not.toBeNull();
    expect(await readLaunchCwd(path as string)).toBe(launchCwd);

    const meta = await readSessionMeta(path as string);
    expect(meta.sessionId).toBe(id);
    expect(meta.launchCwd).toBe(launchCwd);
    expect(meta.latestCwd).toBe(launchCwd);
    expect(meta.workspaceName).toBe("ws-find");
    expect(meta.userTurns).toBe(2);
    expect(meta.assistantTurns).toBe(2);
    expect(meta.firstUserMessage).toBe("first message");
    expect(meta.lastUserMessage).toBe("second message");
    expect(meta.lastAssistantMessage).toBe("second answer");
  });

  test("returns null for unknown id", async () => {
    const path = await findSessionJsonl("00000000-0000-0000-0000-000000000000");
    expect(path).toBeNull();
  });

  test("captures cwd drift in latestCwd", async () => {
    const id = "22222222-2222-3333-4444-555555555555";
    const launchCwd = join(aiServantRoot, "workspaces", "ws-drift");
    const driftedCwd = join(launchCwd, "repos", "alpha__topic");
    await writeSession({
      launchCwd,
      sessionId: id,
      turns: [
        { user: "hi", cwd: launchCwd },
        { assistant: "ok", cwd: launchCwd },
        { user: "now cd", cwd: driftedCwd },
      ],
    });
    const path = await findSessionJsonl(id);
    const meta = await readSessionMeta(path as string);
    expect(meta.launchCwd).toBe(launchCwd);
    expect(meta.latestCwd).toBe(driftedCwd);
  });
});

describe("listWorkspaceSessions", () => {
  test("scopes by workspace name and sorts by mtime desc", async () => {
    const wsA = join(aiServantRoot, "workspaces", "alpha");
    const wsB = join(aiServantRoot, "workspaces", "beta");

    await writeSession({
      launchCwd: wsA,
      sessionId: "aaaa1111-2222-3333-4444-555555555555",
      turns: [{ user: "alpha-old" }, { assistant: "x" }],
      mtimeMs: Date.now() - 60_000,
    });
    await writeSession({
      launchCwd: wsA,
      sessionId: "aaaa2222-2222-3333-4444-555555555555",
      turns: [{ user: "alpha-new" }, { assistant: "x" }],
      mtimeMs: Date.now() - 1_000,
    });
    await writeSession({
      launchCwd: wsB,
      sessionId: "bbbb1111-2222-3333-4444-555555555555",
      turns: [{ user: "beta-one" }, { assistant: "x" }],
    });

    const alphaOnly = await listWorkspaceSessions({ workspaceName: "alpha" });
    expect(alphaOnly.map((s) => s.firstUserMessage)).toEqual(["alpha-new", "alpha-old"]);

    const all = await listWorkspaceSessions();
    const names = all.map((s) => s.workspaceName);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
  });

  test("hides empty sessions (zero user turns)", async () => {
    const ws = join(aiServantRoot, "workspaces", "empty-ws");
    await writeSession({
      launchCwd: ws,
      sessionId: "cccc1111-2222-3333-4444-555555555555",
      turns: [{ assistant: "no user input here" }],
    });
    const sessions = await listWorkspaceSessions({ workspaceName: "empty-ws" });
    expect(sessions.length).toBe(0);
  });

  test("hides sessions older than maxAge", async () => {
    const ws = join(aiServantRoot, "workspaces", "stale-ws");
    await writeSession({
      launchCwd: ws,
      sessionId: "dddd1111-2222-3333-4444-555555555555",
      turns: [{ user: "ancient" }, { assistant: "x" }],
      mtimeMs: Date.now() - 31 * 24 * 60 * 60 * 1000,
    });
    const sessions = await listWorkspaceSessions({ workspaceName: "stale-ws" });
    expect(sessions.length).toBe(0);
  });

  test("includes sessions launched from worktree subdirs by default", async () => {
    const wsName = "wt-ws";
    const ws = join(aiServantRoot, "workspaces", wsName);
    const sub = join(ws, "repos", "alpha__topic");
    await writeSession({
      launchCwd: sub,
      sessionId: "eeee1111-2222-3333-4444-555555555555",
      turns: [{ user: "from worktree" }, { assistant: "ok" }],
    });
    const sessions = await listWorkspaceSessions({ workspaceName: wsName });
    expect(sessions.length).toBe(1);
    expect(sessions[0]?.workspaceName).toBe(wsName);
    expect(sessions[0]?.launchCwd).toBe(sub);
  });

  test("includeWorktreeSubdirs=false filters them out", async () => {
    const wsName = "wt-strict";
    const ws = join(aiServantRoot, "workspaces", wsName);
    const sub = join(ws, "repos", "alpha__topic");
    await writeSession({
      launchCwd: sub,
      sessionId: "ffff1111-2222-3333-4444-555555555555",
      turns: [{ user: "from worktree" }, { assistant: "ok" }],
    });
    await writeSession({
      launchCwd: ws,
      sessionId: "ffff2222-2222-3333-4444-555555555555",
      turns: [{ user: "from root" }, { assistant: "ok" }],
    });
    const sessions = await listWorkspaceSessions({
      workspaceName: wsName,
      includeWorktreeSubdirs: false,
    });
    expect(sessions.length).toBe(1);
    expect(sessions[0]?.launchCwd).toBe(ws);
  });
});
