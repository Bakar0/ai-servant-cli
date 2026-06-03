# Repo Worktree Management Implementation Plan

**Goal:** Add a `servant repo` command group that lets the agent work in git worktrees of the user's existing local clones, organized under each workspace, while restructuring `~/.ai_servant/` to host both per-user config and a `workspaces/` namespace.

**Architecture:** Worktrees are created against the user's existing local clones via `git -C <local-repo> worktree add ...` — no shared bare cache, no clone management. Discovery walks user-configured search roots (`~/private`, `~/code` by default), picks via `fzf` with a numbered-prompt fallback. Workspace state stays implicit: `git worktree list` + filesystem is authoritative. Per-user config (search roots, scan depth) lives in `~/.ai_servant/config.json`; per-workspace data lives under `~/.ai_servant/workspaces/<name>/`.

---

## Phase 1: Path restructure + config module

**Foundation for everything else.** Move `~/.ai_servant/<workspace>/` to `~/.ai_servant/workspaces/<workspace>/` and introduce a per-user `config.json` at the root. v0.0.1 — no migration shim.

**Components:**
- `src/core/paths.ts`: split into `aiServantRoot()` (root), `workspacesRoot()` (`<root>/workspaces`), `workspacePath(name)` (`<workspaces-root>/<name>`), `configPath()` (`<root>/config.json`), `discoveryCachePath()` (`<root>/.cache/repo-discovery.json`).
- `src/core/workspace.ts`: `detectWorkspaceNameFromCwd` now resolves against `workspacesRoot()`, not `aiServantRoot()`.
- `src/core/config.ts` *(new)*: `loadConfig()` reads `config.json` (returns defaults if missing, does NOT write — writing is a Phase 6 concern), `saveConfig(cfg)`, `Config` type with `repoSearchRoots: string[]` (default `["~/private", "~/code"]`), `scanMaxDepth: number` (default `4`). Use `Bun.file` for IO. Expand `~` in paths at load time.
- `src/commands/spawn.ts`: no behavior change, just inherits new paths via the helpers.
- `tests/workspace.test.ts`: update paths in test fixtures.
- `tests/config.test.ts` *(new)*: defaults, round-trip, `~` expansion.

**Success criteria:** existing `spawn` flow works against new layout; config module load/save tested; typecheck + biome clean.

---

## Phase 2: Git/worktree primitives module

Isolated, pure git wrappers — easy to unit-test against temp repos. No CLI, no UI here.

**Components:**
- `src/core/git.ts` *(new)*. All functions take a `repoPath` and shell out via `Bun.$`.
  - `detectDefaultBranch(repoPath): Promise<string>` — try `git symbolic-ref refs/remotes/origin/HEAD` first; on failure, `git ls-remote --symref origin HEAD` and parse. Throw with a clear message if neither works.
  - `fetchBranch(repoPath, branch): Promise<void>` — `git fetch origin <branch>`.
  - `localBranchExists(repoPath, name): Promise<boolean>` — `git show-ref --verify --quiet refs/heads/<name>`.
  - `remoteBranchExists(repoPath, name): Promise<boolean>` — check `refs/remotes/origin/<name>` after fetch.
  - `addWorktree(repoPath, worktreePath, opts: { branch, base?, track? })`:
    - `track: true` → `git worktree add --track -b <branch> <path> origin/<branch>`
    - else → `git worktree add -b <branch> <path> <base>`
  - `listWorktrees(repoPath): Promise<Worktree[]>` — parse `git worktree list --porcelain`.
  - `removeWorktree(repoPath, worktreePath, opts: { force? })`.
  - `repoCommonDir(repoPath): Promise<string>` — `git rev-parse --git-common-dir`, used by `repo rm` to find the source repo from a worktree path.

**Testing:** `tests/git.test.ts` — initialize a temp git repo with `Bun.$`, exercise each primitive. Branch-name conflict detection is tested at this layer.

**Success criteria:** all primitives work against a temp repo created in test setup.

---

## Phase 3: Repo discovery + caching

Walks configured search roots, finds `.git` directories, returns a list of `{name, path, remoteUrl?}` entries with collision flags.

**Components:**
- `src/core/repo-discovery.ts` *(new)*:
  - `discoverRepos(config): Promise<DiscoveredRepo[]>` — main entry.
  - Internal: `detectScanner()` returns `"fd" | "find"` based on `which fd`.
  - Internal: per-root scan invokes `fd '^\.git$' -t d -H -E node_modules --max-depth <n>` or equivalent `find` pattern.
  - Filter: exclude any path that resolves under `aiServantRoot()` (so we don't list worktrees as candidates). Also skip `.git` *files* (submodules / worktrees) — only directories count as a "main clone."
  - For each repo, optionally read `origin` URL (`git -C <path> remote get-url origin`) for display in the picker. Best-effort; failure non-fatal.
  - Collision marking: group by `basename(path)`; if `>1` share a basename, mark all of them `collides: true`.
- Cache layer in same module:
  - Cache file: `~/.ai_servant/.cache/repo-discovery.json` with `{ generatedAt, rootMtimes: Record<string, number>, repos: DiscoveredRepo[] }`.
  - Invalidation: stat each search root; if any mtime differs from cached value (or root added/removed), rescan. Otherwise return cached list.
  - `--refresh` flag on `repo add` to force rescan.

**Testing:** `tests/repo-discovery.test.ts` — create a temp directory tree with several fake `.git` dirs (including same-name collisions and one nested under a faux `~/.ai_servant`), point search roots at it, assert discovery and collision flags. Cache invalidation tested by touching a root's mtime.

**Success criteria:** discovery is fast on cached path (no scan), correctly excludes `.ai_servant/`, flags collisions.

---

## Phase 4: Interactive UI helpers

Thin abstraction over interactive prompts so the rest of the code stays testable.

**Components:**
- `src/ui/picker.ts` *(new)*:
  - `pickFromList<T>(items, opts: { format(t): string, preview?(t): string, prompt? }): Promise<T | null>`.
  - Implementation: detect `fzf` via `which fzf`. If present, spawn it with items piped to stdin (format strings), parse selection. Use `--preview` for an info pane (default branch + remote URL + path) when `preview` is supplied.
  - Fallback: numbered prompt to stderr, read a line from stdin, parse selection. Acceptable but ugly — fzf is the expected path on the user's mac.
- `src/ui/prompts.ts` *(new)*:
  - `promptText(message, opts?: { default? }): Promise<string>`.
  - `confirm(message, default?): Promise<boolean>`.

**Testing:** `tests/picker.test.ts` for the numbered-prompt fallback (drive stdin via a string). fzf path is not unit-tested — exercised manually + via integration test if available.

**Success criteria:** picker resolves cleanly with fzf installed *and* without it.

---

## Phase 5: `servant repo` command group

Wire it all together. This is the user-facing surface.

**Components:**
- `src/commands/repo/index.ts` *(new)*: citty subcommand group; mounts `add`, `list`, `rm`.
- `src/commands/repo/add.ts` *(new)*:
  1. Resolve workspace (extract `resolveWorkspaceName` from `spawn.ts` into `src/core/workspace.ts` so both share it).
  2. Load config; if `repoSearchRoots` is empty/missing, trigger first-run flow (Phase 6).
  3. `discoverRepos(config)`; apply `<repo-hint>` filter if given.
     - Interactive: 0 matches → error; 1 match → auto-select; ≥2 → fzf pick.
     - Non-interactive: 0 or ≥2 matches → error with a list of matches.
  4. Collision check on selected repo. If `collides && !args.as` → refuse with explicit error showing both paths and `--as` instructions.
  5. Determine branch name: `--branch` arg, else prompt.
  6. Determine base: `--base` arg, else `detectDefaultBranch(repoPath)`.
  7. Unless `--no-fetch`, `fetchBranch(repoPath, base)` and (if relevant for `--track`) `fetchBranch(repoPath, branchName)`.
  8. Branch-name conflict resolution:
     - `localBranchExists` → refuse with helpful message naming the branch.
     - `remoteBranchExists` only → interactive: prompt to track; non-interactive: require `--track`, else refuse.
  9. Compute worktree path: `workspacePath(ws)/repos/<alias-or-basename>/<branch>/`. Refuse if directory exists.
  10. `addWorktree(...)`. Print final path + a one-liner like `cd <path>` for ergonomics.
- `src/commands/repo/list.ts` *(new)*:
  - Resolve workspace. Walk `workspacePath(ws)/repos/*/*/`. For each, run `repoCommonDir` to find the source repo, then `listWorktrees(sourceRepo)` and filter to entries inside this workspace. Display grouped by repo.
- `src/commands/repo/rm.ts` *(new)*:
  - Parse `<repo>[@<branch>]`. If `@<branch>` omitted, refuse (don't be clever).
  - Resolve worktree path. `repoCommonDir` to find source. `removeWorktree(source, worktreePath, { force })`. Then delete the now-empty `repos/<repo>/` parent if empty.
- `src/index.ts`: register `repo` subcommand group.

**Testing:** `tests/repo-add.test.ts`, `tests/repo-list.test.ts`, `tests/repo-rm.test.ts`. Each sets up a temp source repo, a temp `AI_SERVANT_ROOT` (override via env var for tests — add support in `paths.ts`), and exercises the command via its citty entry point. Branch-conflict and collision branches assert error messages.

**Success criteria:** end-to-end interactive and non-interactive `repo add` work; `list` and `rm` cycle cleanly.

---

## Phase 6: First-run config experience + polish

The smaller-but-still-needed bits.

**Components:**
- First-run config prompt: triggered the first time a command needs `repoSearchRoots` and `config.json` doesn't exist. Show defaults (`~/private`, `~/code`), prompt for confirm/edit (comma-separated list), write `config.json`. Skipped entirely if `--workspace` and `--branch` and `<repo-hint>` resolves without discovery — but we always need discovery for collision checks, so practically: always prompt on first run.
- `--refresh` flag on `repo add` to force discovery rescan.
- fzf preview formatter: show `path`, `origin URL`, `default branch`, `current branch of source clone`.
- Helpful errors:
  - "no repos discovered" — print the search roots that were scanned and suggest editing `config.json`.
  - "branch already exists locally" — suggest a different name or `--track` (if the remote matches too).
  - "repo basename collision" — print both paths and the `--as` flag.
- README update: short section on `servant repo add` and `~/.ai_servant/` layout.

**Testing:** focused integration test for the first-run prompt (drive stdin); error-message snapshots for the three big helpful errors.

**Success criteria:** new user can run `servant repo add` cold, accept defaults, pick a repo, and end up with a worktree — no manual config editing required.

---

## Module map (final state)

```
src/
  commands/
    spawn.ts                       (updated paths)
    repo/
      index.ts                     (citty group)
      add.ts
      list.ts
      rm.ts
  core/
    paths.ts                       (split helpers)
    workspace.ts                   (+ shared resolveWorkspaceName)
    config.ts                      (new)
    git.ts                         (new)
    repo-discovery.ts              (new)
  ui/
    picker.ts                      (new)
    prompts.ts                     (new)
  agents/ terminals/               (unchanged)
  index.ts                         (+ repo subcommand)

tests/
  workspace.test.ts                (updated)
  config.test.ts                   (new)
  git.test.ts                      (new)
  repo-discovery.test.ts           (new)
  picker.test.ts                   (new)
  repo-add.test.ts                 (new)
  repo-list.test.ts                (new)
  repo-rm.test.ts                  (new)
```

## Implementation notes worth carrying forward

- `paths.ts` should honor a `AI_SERVANT_ROOT` env var override so tests can use temp dirs without touching `~/.ai_servant/`. Add this in Phase 1; it pays off in every later phase.
- All git wrappers in `git.ts` should throw `Error` with the command and stderr included — that error text bubbles directly to the user and is most of the "helpful errors" work.
- Don't extract a "WorktreeRef" type prematurely. A repo + worktree path is two strings; resist abstraction until something needs it.
- Avoid writing a parallel state file. If a future feature truly needs metadata (e.g., "this worktree was created for task X"), prefer a small file *inside* the worktree (e.g., `.servant/meta.json`) over a workspace-level registry that has to be kept in sync.
