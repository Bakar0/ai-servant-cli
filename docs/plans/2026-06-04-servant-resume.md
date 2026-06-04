# `servant resume` Implementation Plan

**Goal:** Add `servant resume [id]` so the user can re-attach to a previously-spawned Claude Code session when cmux's auto-resume fails with `No conversation found with session ID: <id>`. With an `id`: spawn a new tab/surface running `claude --resume <id>` in the correct cwd. Without an `id`: open an fzf picker scoped to the current workspace (with cross-workspace fallback) and a rich preview pane.

## Why this is needed (root cause; do not lose this context)

cmux records two cwds per Claude session in `~/.cmuxterm/claude-hook-sessions.json`:
- `launchCommand.workingDirectory` — the dir Claude was launched from.
- `cwd` — the latest cwd seen by cmux's claude hook; drifts whenever the agent `cd`s.

Claude stores each session at `~/.claude/projects/<encoded-launch-cwd>/<session-id>.jsonl`. The encoded folder name is computed from the **launch** cwd, not the latest cwd. Encoding replaces `/`, `.`, and `_` with `-` (lossy for non-ASCII, but fine for servant paths).

cmux's auto-resume scripts at `/var/folders/.../cmux-surface-resume/claude-<surface>.zsh` (and the agent-resume variant) run `claude --resume <id>` **without `cd`**ing first (cmux issue [#5271](https://github.com/manaflow-ai/cmux/issues/5271)). For `servant spawn` workflows the launch dir is `~/.ai_servant/workspaces/<name>` but the agent typically `cd`s into `repos/<repo>__<branch>/...`, so on app reopen the resume script runs in a directory whose encoded project folder doesn't contain the session — Claude errors out.

This bug is tracked upstream at cmux issues **#4256**, **#4963**, **#5271**, **#4938** (dot-path encoding fast-path) and the closed **#3815**, **#4150** (incompletely fixed). We are not waiting for upstream — `servant resume` works around it from our side.

A Claude-hook-based fix was considered and rejected: lifecycle hooks (`SessionStart`, `Stop`, etc.) only fire after Claude has loaded the session. The lookup failure happens *before* any hook can fire, so hooks can't recover from it. A `Stop` hook could normalize cmux's recorded `cwd` to fix the Sessions-sidebar resume path (issue #4963) but not the surface-resume path (#5271). `servant resume` covers both.

A PATH-shim wrapper around `claude` was also considered. Rejected for now in favor of an explicit command — easier to reason about, no risk of intercepting unrelated `claude` invocations.

## Verified data shape (sample from user's machine)

`~/.cmuxterm/claude-hook-sessions.json` entry:

```json
{
  "sessionId": "8fe571f6-c7dc-4f25-abcc-1bfd5f922e5e",
  "agentLifecycle": "needsInput",
  "isRestorable": true,
  "cwd": "/Users/barakmor/.ai_servant/workspaces/api_key_authority_visability/repos/platform-engineering-org/api_key_authority_visability",
  "launchCommand": {
    "workingDirectory": "/Users/barakmor/.ai_servant/workspaces/api_key_authority_visability",
    "executablePath": "/opt/homebrew/bin/claude",
    "launcher": "claude"
  },
  "transcriptPath": "/Users/barakmor/.claude/projects/-Users-barakmor--ai-servant-workspaces-api-key-authority-visability/8fe571f6-c7dc-4f25-abcc-1bfd5f922e5e.jsonl",
  "surfaceId": "...",
  "workspaceId": "...",
  "updatedAt": 1780585134.84
}
```

The `.jsonl` is JSON-lines. First line is metadata; subsequent lines are turns. Each entry may have a `cwd` field. The **first non-null `cwd`** in the file is the launch cwd (authoritative — survives encoder ambiguity).

Turn entries look like:
- `{"type": "user", "message": {"role": "user", "content": "..."}, "cwd": "...", ...}`
- `{"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "..."}, ...]}, ...}`

(Verify exact shape with `jq` against an existing jsonl during implementation.)

## UX (decisions already made)

Layout chosen: **compact list + rich preview**.

List line (left pane, one row per session):
```
27fe833c  idle      2h   Refactor auth middleware to support typed scopes
8fe571f6  waiting   3d   Set up worktree and bootstrap visability service
```
Fields: short session id (first 8 chars), state, relative-time, first user message truncated.

Preview pane (right, for highlighted row):
```
Session   <full-id>
Workspace <name>
State     <lifecycle>   (live; surface <short-id>)   ← omit the parenthetical if not live
Updated   <iso-time>  (<relative>)
Turns     <n> user / <n> assistant
Launch    <launch cwd, ~-collapsed>
Cwd now   <latest cwd, ~-collapsed>   ← omit if equal to launch

--- First user message ---
<text>

--- Last user message ---
<text>

--- Last assistant message ---
<text>
```

Scope decisions:
- **Include** sessions launched from worktree subdirs (`workspaces/<name>/repos/<repo>__<branch>/...`).
- **Hide** sessions with zero user messages.
- **Hide** sessions older than 30 days (mtime-based). No flag to override in v1 — add `--all` later if needed.
- If no workspace can be resolved, fall back to **cross-workspace mode**: list sessions from every workspace under `~/.ai_servant/workspaces/`.

## File layout

### New files

**`src/core/claude-session.ts`** — pure session discovery and parsing. No UI. No cmux deps.

```ts
export interface ClaudeSessionMeta {
  sessionId: string;
  jsonlPath: string;
  launchCwd: string;            // first non-null cwd in jsonl
  latestCwd: string;            // last non-null cwd in jsonl (== launchCwd if never drifted)
  workspaceName: string | null; // first segment under workspacesRoot(), else null
  firstUserMessage: string | null;
  lastUserMessage: string | null;
  lastAssistantMessage: string | null;
  userTurns: number;
  assistantTurns: number;
  mtimeMs: number;
}

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Throws if id is not a valid UUID shape (cheap input validation).
export function assertValidSessionId(id: string): void;

// Walk ~/.claude/projects/*/<id>.jsonl. Returns null if not found anywhere.
export async function findSessionJsonl(sessionId: string): Promise<string | null>;

// Read first non-null cwd from a jsonl. Used by `servant resume <id>`.
export async function readLaunchCwd(jsonlPath: string): Promise<string | null>;

// Read full metadata for the picker. Reads the whole file — small enough to be fine in practice.
export async function readSessionMeta(jsonlPath: string): Promise<ClaudeSessionMeta>;

// List sessions under a given workspace root path (or all servant workspaces if undefined).
// Filters: hide empty (userTurns === 0), hide older than 30 days.
// Sorted by mtimeMs desc.
export async function listWorkspaceSessions(opts: {
  workspaceName?: string;       // if set, only return sessions whose launchCwd is under workspaces/<name>/
  includeWorktreeSubdirs?: boolean; // default true
  maxAgeMs?: number;            // default 30 days
}): Promise<ClaudeSessionMeta[]>;
```

**Implementation notes:**
- Project-dir prefilter: encode the workspace path with `replace(/[\/._]/g, "-")` and look only at `~/.claude/projects/<encoded-prefix>*`. Significantly faster than reading every jsonl. Confirm against the verified sample above.
- After prefilter, open each jsonl and read line-by-line via `Bun.file(path).stream()` + line splitter so we can stop after we've collected what we need (first cwd, first user message, last user, last assistant). For "last" entries, we have to walk the whole file — fine for typical session size.
- Use `Bun.file(path).stat()` for mtime.
- Workspace-name extraction: take the relative path from `workspacesRoot()` to launchCwd, split on `/`, take `[0]`. Null if not under `workspacesRoot()`. Reuse the validator from `src/core/workspace.ts` (`detectWorkspaceNameFromCwd`).

**`src/core/cmux-sessions.ts`** — read-only live state from cmux's hook JSON.

```ts
export interface CmuxLiveState {
  surfaceId: string | null;
  workspaceId: string | null;
  agentLifecycle: "running" | "idle" | "needsInput" | "unknown" | null;
  lastSubtitle: string | null;
  isRestorable: boolean;
  updatedAtMs: number | null;
}

// Returns map<sessionId, CmuxLiveState>. Empty map if file missing/unreadable.
// Path: ~/.cmuxterm/claude-hook-sessions.json
export async function readCmuxLiveStates(): Promise<Map<string, CmuxLiveState>>;
```

Keep this dead simple — read once, return a Map. Picker / resume command both consult it. Tolerate missing file, parse errors, schema drift.

**`src/ui/resume-picker.ts`** — fzf glue.

```ts
// Picks a session id interactively. Returns null on user abort (esc).
// Errors if fzf is not on PATH or no sessions are available.
export async function pickSession(opts: {
  workspaceName?: string;
}): Promise<string | null>;
```

**Implementation:**
- Build the list of sessions via `listWorkspaceSessions`. If `workspaceName` is undefined, scan all workspaces. Layer in `readCmuxLiveStates` for the state column.
- If list is empty, throw a clean error (`"No resumable Claude sessions found for workspace \"<name>\" (looked in ~/.claude/projects/)."`).
- Render each item as a single tab-separated line: `<sessionId>\t<displayLine>`. The session id is in field 1 (hidden from view via `--with-nth=2..`).
- Spawn fzf via `Bun.spawn(["fzf", "--ansi", "--with-nth=2..", "--delimiter=\t", "--preview", "servant resume --preview {1}", "--preview-window=right:55%:wrap", "--prompt=resume> ", "--height=80%", "--border"], { stdin: "pipe", stdout: "pipe" })`. Write the list to stdin, close, read stdout.
- Exit code 130 → user aborted; return null. Exit code 0 → parse field 1 of the selected line.

**Preview rendering:** `servant resume --preview <id>` (handled in the resume command itself, not a separate subcommand). Internally:
1. Find the jsonl via `findSessionJsonl(id)`.
2. Read full meta via `readSessionMeta`.
3. Layer in cmux live state.
4. Print the formatted preview (ANSI for section dividers is fine; keep it terminal-default-color or use `\x1b[2m` for muted headers).
5. On error, print `"<could not load session: <reason>>"` to stdout (not stderr — fzf shows stdout in the preview pane).

**`src/commands/resume.ts`** — Citty command.

```ts
import { defineCommand } from "citty";

export const resumeCommand = defineCommand({
  meta: {
    name: "resume",
    description:
      "Re-attach to a previous Claude Code session by id. With no id, open an fzf picker over the current workspace's session history.",
  },
  args: {
    id: {
      type: "positional",
      required: false,
      description: "Claude session id (UUID). If omitted, open the interactive picker.",
    },
    workspace: {
      type: "string",
      required: false,
      alias: "w",
      description: "Workspace name to scope the picker to (default: auto-detect; falls back to cross-workspace mode).",
    },
    terminal: {
      type: "string",
      required: false,
      description: "Terminal to use: cmux | iterm (default: auto-detect).",
    },
    prompt: {
      type: "string",
      required: false,
      alias: "p",
      description: "Optional follow-up message to send to the resumed session as the next user turn.",
    },
    preview: {
      type: "string",
      required: false,
      // Hidden flag used by the fzf picker preview command. Print preview for <id> to stdout and exit.
      description: "(internal) Render the preview pane for a session id and exit.",
    },
  },
  async run({ args }) {
    if (typeof args.preview === "string" && args.preview.length > 0) {
      await renderPreviewToStdout(args.preview);
      return;
    }

    // 1. Resolve a session id.
    let sessionId = args.id ?? null;
    if (!sessionId) {
      const workspaceName = args.workspace ?? (await tryResolveWorkspace());
      sessionId = await pickSession({ workspaceName: workspaceName ?? undefined });
      if (!sessionId) return; // user aborted
    } else {
      assertValidSessionId(sessionId);
    }

    // 2. Resolve launch cwd from the jsonl.
    const jsonlPath = await findSessionJsonl(sessionId);
    if (!jsonlPath) {
      throw new Error(
        `No session file found for ${sessionId} under ~/.claude/projects/. The session may have been deleted.`,
      );
    }
    const launchCwd = await readLaunchCwd(jsonlPath);
    if (!launchCwd) {
      throw new Error(`Session ${sessionId} has no cwd recorded — can't resume safely.`);
    }

    // 3. Pick the cmux workspace title:
    //    - if --workspace was passed, use it
    //    - else if launchCwd is under workspacesRoot(), use first segment
    //    - else use launchCwd itself (cmux driver falls back to that)
    const workspaceTitle = resolveWorkspaceTitle(args.workspace, launchCwd);

    // 4. Build command. `claude --resume <id>` plus optional prompt.
    //    Important: prompt is appended AFTER --resume so claude reads it as the next user turn.
    const command = buildResumeCommand(sessionId, args.prompt);

    // 5. Ensure servant assets exist (workspace dir, CLAUDE.md, etc.) if the workspace is one of ours.
    if (workspaceTitle && isUnderWorkspacesRoot(launchCwd)) {
      await ensureWorkspaceDir(workspaceTitle);
    }
    await ensureServantAssets();

    // 6. Open the tab.
    const driver = args.terminal ? getDriver(args.terminal) : await detectTerminal();
    await driver.openTab({ cwd: launchCwd, command, title: workspaceTitle });

    console.log(
      `servant: resumed session ${sessionId.slice(0, 8)} in ${driver.name} workspace "${workspaceTitle ?? launchCwd}" at ${launchCwd}`,
    );
  },
});
```

Helpers used above (define in the same file unless they grow):
- `buildResumeCommand(id, prompt?)` → `"claude --resume '<id>'"` plus `" '<prompt>'"` when prompt is non-empty. Reuse `shellSingleQuote`.
- `resolveWorkspaceTitle(explicit?, launchCwd)` — uses `detectWorkspaceNameFromCwd` from `src/core/workspace.ts`.
- `tryResolveWorkspace()` — wraps the existing auto-detection from `resolveWorkspaceName` but **returns null instead of throwing** when nothing matches. Add an opt-in `{ allowUnresolved: true }` flag to `resolveWorkspaceName` rather than duplicating the logic.

### Files to edit

**`src/index.ts`** — register the new subcommand:

```ts
import { resumeCommand } from "./commands/resume.ts";
// ...
subCommands: { spawn: spawnCommand, repo: repoCommand, resume: resumeCommand },
```

**`src/terminals/cmux.ts`** — fix `addSurfaceToWorkspace` so it cds into the workspace cwd before running the command. This is independently valuable (today, a second surface in an existing workspace starts in `$HOME`, not the workspace dir) AND it's load-bearing for resume into existing workspaces.

Current:
```ts
async function addSurfaceToWorkspace(workspaceRef: string, command: string): Promise<void> {
  // creates surface, then `cmux send` types the command verbatim
}
```

Change to:
```ts
async function addSurfaceToWorkspace(workspaceRef: string, cwd: string, command: string): Promise<void> {
  // ...
  const wrapped = `cd ${shellSingleQuote(cwd)} && ${command}`;
  const sendResult = await runCmux(["send", "--surface", surfaceRef, `${wrapped}\n`], {
    stripCallerContext: true,
  });
  // ...
}
```

Update `cmuxDriver.openTab` to pass `cwd` through.

### Tests

- **`tests/claude-session.test.ts`** — write a synthetic jsonl with a few user/assistant turns into a temp `~/.claude/projects/<encoded>/<id>.jsonl` (override `HOME` for the test via `process.env.HOME` and use `aiServantRoot()`-style path injection if needed — check what other tests do). Verify `findSessionJsonl`, `readLaunchCwd`, `readSessionMeta`, `listWorkspaceSessions` (with and without worktree subdirs, with/without empty sessions, with/without stale sessions).
- **`tests/resume-command.test.ts`** — happy-path: call the command's `run()` with a fake driver injected, assert `openTab` got called with the right cwd/command/title. Test invalid-id rejection, missing-session error, prompt appending.
- **`tests/terminals.test.ts`** — add a unit test for the new `cd`-prefix behavior of `addSurfaceToWorkspace`. Mock `runCmux` to capture invocation args.

For terminal-driver tests we already mock through `runCmux`-style indirection patterns — follow what `tests/terminals.test.ts` does.

## Implementation order

1. **`claude-session.ts` + tests** — no UI, no IO outside `~/.claude/projects/`. Get parsing right first.
2. **`cmux-sessions.ts` + smoke test** — trivial wrapper.
3. **`addSurfaceToWorkspace` cd fix + test** — small, independent, ship in same PR.
4. **`resume.ts` command (non-interactive path)** — `servant resume <id>` end-to-end. Test by hand against a real failing session id.
5. **`resume-picker.ts` + `--preview` handler** — wire fzf, format list and preview. Manually validate against your real workspaces.
6. **Hide stale + empty sessions** — covered in `listWorkspaceSessions`, just verify filters work.
7. **README + `CLAUDE.md` mention** — short note that this exists, when to use it, and a one-liner about the underlying cmux issue.

## Acceptance checks (manual, on the user's machine)

1. `servant resume 8fe571f6-c7dc-4f25-abcc-1bfd5f922e5e` opens a cmux surface that successfully resumes the session (no "No conversation found" error).
2. `servant resume` with no id (run from inside the `api_key_authority_visability` workspace cmux tab) opens an fzf picker listing only that workspace's sessions, newest first, with the preview showing first/last user/assistant turns.
3. `servant resume` run from outside any workspace lists sessions from every workspace under `~/.ai_servant/workspaces/`.
4. `servant resume <id> --prompt "continue"` resumes and sends "continue" as the next user turn.
5. `servant spawn` into an *existing* cmux workspace (second surface) now starts in the workspace dir, not `$HOME`. (This is the `addSurfaceToWorkspace` cd fix; verify by running `pwd` in the new surface.)

## Out of scope (intentionally)

- PATH shim wrapping the `claude` binary. Considered, postponed; can be added later if `servant resume` proves insufficient.
- Auto-normalizing `~/.cmuxterm/claude-hook-sessions.json` (the `cwd` drift fix that would help cmux's Sessions sidebar). Postpone — `servant resume` covers the user's actual failing path.
- A `Stop` hook in `~/.claude/settings.json`. Same reason.
- Upstream PRs to cmux. The issues are already on their tracker (see "Why" section).
- Filtering by date, agent state, or repo. Add later as flags if needed.
- Persisting "recently resumed" history beyond what's already in `~/.claude/projects/`.
