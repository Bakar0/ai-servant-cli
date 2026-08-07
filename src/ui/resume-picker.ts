import { servantReinvokeArgv } from "../core/self-exec.ts";
import { type SessionMeta, type SessionSource, getSessionSource } from "../core/session-source.ts";

export interface PickSessionOpts {
  workspaceName?: string;
  /** fzf prompt label (default "resume> "). */
  promptLabel?: string;
  /**
   * The servant subcommand whose `--preview <id>` renders the fzf preview pane (default "resume").
   * Pass e.g. "insights" to preview a session's metrics/candidates instead of its messages.
   */
  previewSubcommand?: string;
  /** Which backend's session store to pick from (default: Claude). */
  source?: SessionSource;
}

export async function pickSession(opts: PickSessionOpts = {}): Promise<string | null> {
  const fzfPath = Bun.which("fzf");
  if (!fzfPath) {
    throw new Error(
      "fzf is required to pick a session interactively. Install it (e.g. `brew install fzf`) or pass a session id.",
    );
  }

  const source = opts.source ?? getSessionSource(null);
  const sessions = await source.listWorkspaceSessions({ workspaceName: opts.workspaceName });
  if (sessions.length === 0) {
    const scope = opts.workspaceName
      ? `workspace "${opts.workspaceName}"`
      : "any servant workspace";
    throw new Error(
      `No ${source.backend} sessions found for ${scope} (looked in ${source.storeLabel}).`,
    );
  }

  const lines = sessions.map((s) => `${s.sessionId}\t${formatListLine(s)}`);

  const previewSub = opts.previewSubcommand ?? "resume";
  // Thread the backend into the preview reinvocation so the pane renders from the right store.
  const previewCmd = `${servantReinvokeArgv().map(shellQuote).join(" ")} ${previewSub} --agent ${shellQuote(source.backend)} --preview {1}`;

  const proc = Bun.spawn(
    [
      fzfPath,
      "--ansi",
      "--with-nth=2..",
      "--delimiter=\t",
      `--preview=${previewCmd}`,
      "--preview-window=right:55%:wrap",
      `--prompt=${opts.promptLabel ?? "resume> "}`,
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
  void proc.stdin.write(lines.join("\n"));
  await proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) return null;

  const selected = out.split("\n").find((l) => l.length > 0);
  if (!selected) return null;
  const sessionId = selected.split("\t")[0];
  return sessionId ?? null;
}

export function formatListLine(meta: SessionMeta): string {
  const age = relativeAge(meta.mtimeMs);
  const message = (meta.firstUserMessage ?? "(no user message)").replace(/\s+/g, " ").slice(0, 120);
  return `${pad(age, 4)}  ${message}`;
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
