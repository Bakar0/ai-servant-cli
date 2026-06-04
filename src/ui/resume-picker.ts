import { type ClaudeSessionMeta, listWorkspaceSessions } from "../core/claude-session.ts";
import { type CmuxLiveState, readCmuxLiveStates } from "../core/cmux-sessions.ts";

export interface PickSessionOpts {
  workspaceName?: string;
}

export async function pickSession(opts: PickSessionOpts = {}): Promise<string | null> {
  const fzfPath = Bun.which("fzf");
  if (!fzfPath) {
    throw new Error(
      "fzf is required for `servant resume` without an id. Install it (e.g. `brew install fzf`) or pass a session id.",
    );
  }

  const sessions = await listWorkspaceSessions({ workspaceName: opts.workspaceName });
  if (sessions.length === 0) {
    const scope = opts.workspaceName
      ? `workspace "${opts.workspaceName}"`
      : "any servant workspace";
    throw new Error(
      `No resumable Claude sessions found for ${scope} (looked in ~/.claude/projects/).`,
    );
  }

  const liveStates = await readCmuxLiveStates();

  const lines = sessions.map(
    (s) => `${s.sessionId}\t${formatListLine(s, liveStates.get(s.sessionId))}`,
  );

  const previewCmd = `${shellQuote(process.execPath)} ${shellQuote(servantEntry())} resume --preview {1}`;

  const proc = Bun.spawn(
    [
      fzfPath,
      "--ansi",
      "--with-nth=2..",
      "--delimiter=\t",
      `--preview=${previewCmd}`,
      "--preview-window=right:55%:wrap",
      "--prompt=resume> ",
      "--height=80%",
      "--layout=reverse",
      "--border",
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  proc.stdin.write(lines.join("\n"));
  await proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) return null;

  const selected = out.split("\n").find((l) => l.length > 0);
  if (!selected) return null;
  const sessionId = selected.split("\t")[0];
  return sessionId ?? null;
}

export function formatListLine(meta: ClaudeSessionMeta, live: CmuxLiveState | undefined): string {
  const id = meta.sessionId.slice(0, 8);
  const state = stateLabel(live);
  const age = relativeAge(meta.mtimeMs);
  const message = (meta.firstUserMessage ?? "(no user message)").replace(/\s+/g, " ").slice(0, 80);
  return `${id}  ${pad(state, 8)}  ${pad(age, 4)}  ${message}`;
}

function stateLabel(live: CmuxLiveState | undefined): string {
  if (!live) return "stored";
  switch (live.agentLifecycle) {
    case "running":
      return "running";
    case "idle":
      return "idle";
    case "needsInput":
      return "waiting";
    default:
      return live.isRestorable ? "stored" : "stored";
  }
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}

export function relativeAge(mtimeMs: number, now: number = Date.now()): string {
  const diffMs = Math.max(0, now - mtimeMs);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "now";
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h`;
  return `${Math.floor(diffMs / day)}d`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function servantEntry(): string {
  // When invoked as `bun /path/to/src/index.ts`, process.argv[1] is the script path.
  // When invoked via the published binary, argv[1] may not be set; fall back to argv[0].
  return process.argv[1] ?? process.argv[0] ?? "servant";
}
