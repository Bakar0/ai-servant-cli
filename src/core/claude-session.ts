import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { workspacesRoot } from "./paths.ts";
import { assertValidWorkspaceName } from "./workspace.ts";

export interface ClaudeSessionMeta {
  sessionId: string;
  jsonlPath: string;
  launchCwd: string;
  latestCwd: string;
  workspaceName: string | null;
  firstUserMessage: string | null;
  lastUserMessage: string | null;
  lastAssistantMessage: string | null;
  userTurns: number;
  assistantTurns: number;
  mtimeMs: number;
}

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function assertValidSessionId(id: string): void {
  if (!SESSION_ID_RE.test(id)) {
    throw new Error(`Invalid Claude session id "${id}" (expected UUID).`);
  }
}

export function claudeProjectsRoot(): string {
  const override = process.env.CLAUDE_PROJECTS_ROOT;
  if (override && override.length > 0) return override;
  return join(homedir(), ".claude", "projects");
}

export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[\/._]/g, "-");
}

async function* listProjectDirs(): AsyncGenerator<string> {
  const root = claudeProjectsRoot();
  const glob = new Bun.Glob("*");
  try {
    for await (const name of glob.scan({ cwd: root, onlyFiles: false, dot: true })) {
      yield join(root, name);
    }
  } catch {
    // root missing — yield nothing
  }
}

export async function findSessionJsonl(sessionId: string): Promise<string | null> {
  assertValidSessionId(sessionId);
  const root = claudeProjectsRoot();
  const file = `${sessionId}.jsonl`;
  const glob = new Bun.Glob(`*/${file}`);
  try {
    for await (const match of glob.scan({ cwd: root, onlyFiles: true, dot: true })) {
      return join(root, match);
    }
  } catch {
    // root missing
  }
  return null;
}

async function* readJsonlLines(path: string): AsyncGenerator<unknown> {
  const file = Bun.file(path);
  const text = await file.text();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed);
    } catch {
      // skip malformed lines
    }
  }
}

interface TurnRecord {
  type?: string;
  cwd?: string | null;
  message?: {
    role?: string;
    content?: unknown;
  };
}

function extractTextFromContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === "object") {
      const obj = item as { type?: string; text?: unknown };
      if (obj.type === "text" && typeof obj.text === "string") parts.push(obj.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/** Count parseable JSONL records in a transcript — the unit the extraction turn marker advances over. */
export async function countTranscriptEntries(jsonlPath: string): Promise<number> {
  let n = 0;
  try {
    for await (const _ of readJsonlLines(jsonlPath)) n += 1;
  } catch {
    return 0;
  }
  return n;
}

export async function readLaunchCwd(jsonlPath: string): Promise<string | null> {
  for await (const entry of readJsonlLines(jsonlPath)) {
    const rec = entry as TurnRecord;
    if (typeof rec.cwd === "string" && rec.cwd.length > 0) return rec.cwd;
  }
  return null;
}

function workspaceNameFromCwd(cwd: string): string | null {
  const rel = relative(resolve(workspacesRoot()), resolve(cwd));
  if (!rel || rel.startsWith("..") || rel.startsWith(sep)) return null;
  const first = rel.split(sep)[0];
  if (!first) return null;
  try {
    assertValidWorkspaceName(first);
  } catch {
    return null;
  }
  return first;
}

export async function readSessionMeta(jsonlPath: string): Promise<ClaudeSessionMeta> {
  const sessionId = jsonlPath.replace(/^.*\//, "").replace(/\.jsonl$/, "");
  let launchCwd: string | null = null;
  let latestCwd: string | null = null;
  let firstUserMessage: string | null = null;
  let lastUserMessage: string | null = null;
  let lastAssistantMessage: string | null = null;
  let userTurns = 0;
  let assistantTurns = 0;

  for await (const entry of readJsonlLines(jsonlPath)) {
    const rec = entry as TurnRecord;
    if (typeof rec.cwd === "string" && rec.cwd.length > 0) {
      if (!launchCwd) launchCwd = rec.cwd;
      latestCwd = rec.cwd;
    }
    const role = rec.message?.role ?? rec.type;
    if (role === "user") {
      const text = extractTextFromContent(rec.message?.content);
      if (text && !isToolResultOnly(rec.message?.content)) {
        userTurns += 1;
        if (firstUserMessage === null) firstUserMessage = text;
        lastUserMessage = text;
      }
    } else if (role === "assistant") {
      const text = extractTextFromContent(rec.message?.content);
      if (text) {
        assistantTurns += 1;
        lastAssistantMessage = text;
      }
    }
  }

  const s = await stat(jsonlPath);
  const cwd = launchCwd ?? "";
  return {
    sessionId,
    jsonlPath,
    launchCwd: cwd,
    latestCwd: latestCwd ?? cwd,
    workspaceName: cwd ? workspaceNameFromCwd(cwd) : null,
    firstUserMessage,
    lastUserMessage,
    lastAssistantMessage,
    userTurns,
    assistantTurns,
    mtimeMs: s.mtimeMs,
  };
}

function isToolResultOnly(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  let sawAny = false;
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    sawAny = true;
    const t = (item as { type?: string }).type;
    if (t !== "tool_result") return false;
  }
  return sawAny;
}

export interface ListSessionsOpts {
  workspaceName?: string;
  includeWorktreeSubdirs?: boolean;
  maxAgeMs?: number;
}

export async function listWorkspaceSessions(
  opts: ListSessionsOpts = {},
): Promise<ClaudeSessionMeta[]> {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const includeWorktreeSubdirs = opts.includeWorktreeSubdirs ?? true;
  const now = Date.now();
  const wsRoot = workspacesRoot();

  const projectPrefix = opts.workspaceName
    ? encodeProjectDir(join(wsRoot, opts.workspaceName))
    : encodeProjectDir(wsRoot);

  const out: ClaudeSessionMeta[] = [];
  for await (const projectDir of listProjectDirs()) {
    const dirName = projectDir.replace(/^.*\//, "");
    if (!dirName.startsWith(projectPrefix)) continue;

    const glob = new Bun.Glob("*.jsonl");
    for await (const file of glob.scan({ cwd: projectDir, onlyFiles: true })) {
      const path = join(projectDir, file);
      let s: Awaited<ReturnType<typeof stat>>;
      try {
        s = await stat(path);
      } catch {
        continue;
      }
      if (now - s.mtimeMs > maxAgeMs) continue;

      let meta: ClaudeSessionMeta;
      try {
        meta = await readSessionMeta(path);
      } catch {
        continue;
      }
      if (!meta.launchCwd) continue;
      if (meta.userTurns === 0) continue;

      if (opts.workspaceName) {
        if (meta.workspaceName !== opts.workspaceName) continue;
      } else {
        if (meta.workspaceName === null) continue;
      }

      if (!includeWorktreeSubdirs) {
        const expected = opts.workspaceName
          ? join(wsRoot, opts.workspaceName)
          : meta.workspaceName
            ? join(wsRoot, meta.workspaceName)
            : null;
        if (expected && resolve(meta.launchCwd) !== resolve(expected)) continue;
      }

      out.push(meta);
    }
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}
