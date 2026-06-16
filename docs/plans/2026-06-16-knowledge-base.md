# Servant Knowledge Base ("servant memory") Implementation Plan

**Goal:** Persist what servants learn — facts about **projects** (repos) and **technologies/topics** (from research and session context) — beyond the ephemeral workspace, in a simple indexed file structure. Knowledge is **captured automatically at session end** (plus a manual command), keyed by *subject* (not by the throwaway workspace), and **retrieved automatically at spawn** so a new servant working on a repo already knows what prior servants learned about it.

## The problem (root cause; do not lose this context)

Today every learned fact lives in either `workspaces/<name>/context/` or the Claude session `.jsonl`. Both are scoped to an **ephemeral task**. But the knowledge isn't about the task — it's about a **subject that outlives it**:

- **Projects** — "this repo's auth flow lives in X", "the build is flaky because Y", "maintainer prefers Z".
- **Topics/technologies** — "Bun's SQLite WAL gotcha", "how cmux workspace-id matching works".

When the workspace is torn down (or just goes stale), the knowledge dies with it. The fix is **not** a heavier store (vector DB / memory server). At our scale, a file + index store searched with ripgrep beats embeddings and needs zero infra — and it fits this project's existing philosophy: human-readable markdown, git-friendly, no daemon, self-healing scaffold synced on every spawn. The job is to (1) move knowledge out of the workspace into a subject-keyed store, (2) capture into it, (3) wire retrieval back in.

### Industry grounding (what we're cloning, and what we're deliberately not)

- **File + index camp** (Cursor `.cursor/rules`, Windsurf Memories, Letta memory blocks, CLAUDE.md/AGENTS.md): markdown the agent reads and curates. **This is us.**
- **Progressive disclosure** (Cursor rule types: Always / Auto-attached-by-glob / Agent-requested / Manual): an *index is always loaded*; *leaf notes load on demand* when their one-line description looks relevant. This is the single most important idea for keeping a growing KB from blowing the context window.
- **Distill-on-exit** (mem0 LLM fact-extraction; Windsurf learns after use): extract durable facts from the transcript at session end. We already have this machinery — `/servant:delegate` distills a session into a brief; point the same approach at the KB.
- **The closest template is in front of us:** Claude Code's own memory system (a `MEMORY.md` index of one-line pointers + one fact per file with frontmatter + `[[wiki-links]]` + dedup/staleness rules). We clone that shape verbatim.
- **Deliberately NOT** adopting: vector/graph DBs, memory servers (mem0/Zep/Cognee/Redis). Revisit only if note count makes ripgrep insufficient — and design retrieval as a swappable layer so that's an add, not a rewrite.

## Store layout

A new durable store at the servant root, sibling to `workspaces/`:

```
~/.ai_servant/
  knowledge/                      # git-tracked (git init); every extraction auto-commits
    INDEX.md                      # thin master: projects → per-dir indexes; topics → tag directory
    projects/
      <repo>/                     # keyed by repo NAME (matches worktree-naming repo segment)
        INDEX.md                  # per-repo leaf index (auto-@-referenced when repo is mounted)
        auth-flow.md              # one atomic fact per file
        build-flakiness.md
    topics/                       # FLAT files + tags (no subfolders); found by ripgrep on tags/content
      wal-gotcha.md               # tags: [bun, sqlite]
      workspace-id-matching.md    # tags: [cmux, env]
      worktree-naming.md          # tags: [git]
```

**Note format** (clone of the proven memory format):

```markdown
---
name: cmux-send-workspace-context
description: cmux send "not a terminal" = caller workspace-id mismatch
scope: topic                         # topic | project/<repo>
tags: [cmux, env]                    # topics only; drives ripgrep retrieval
source: { session: 3f2a…, date: 2026-06-16, commit: e1a6cb6 }
confidence: high                     # high | medium | low
---
"Surface is not a terminal" actually means the caller's CMUX_WORKSPACE_ID
doesn't match the target's. Strip CMUX_WORKSPACE_ID/SURFACE_ID/… before invoking.

Related: [[cmux-cli-new-workspace]]
```

- One fact per file. `name` is a kebab-case slug — unique within its project dir (projects) or within `topics/` (topics).
- **Project notes** live in `projects/<repo>/` with a per-dir `INDEX.md` (`- [title](slug.md) — hook`).
- **Topic notes** live flat in `topics/` and carry `tags:`; there is no per-topic index — retrieval is ripgrep over tags/content.
- **Master `knowledge/INDEX.md` is thin:** a Projects section linking to each per-repo `INDEX.md` (with note counts), and a Topics section that is a **tag directory** — the tag vocabulary + counts, not a per-note list:

```
## Projects        (per-dir indexes; @-referenced when the repo is mounted)
- [api-gw](projects/api-gw/INDEX.md) — 12 notes
- [billing](projects/billing/INDEX.md) — 5 notes

## Topics          (flat files in topics/, find by tag via ripgrep / `/servant:recall`)
tags: bun(3) sqlite(2) cmux(4) git(5) claude-code(6) env(2)
```
- `source.commit` + `date` enable a **"verify before trust"** rule: any note that names a file/function/flag must be re-checked before relied on (code facts rot).

## Retrieval (read) — auto-wire projects + grep topics  *(decided)*

- **Projects, eager:** at `spawn` and `repo add`, for every repo mounted in the workspace (`repos/<repo>__<branch>/`), ensure the workspace `CLAUDE.md` `@`-references `~/.ai_servant/knowledge/projects/<repo>/INDEX.md`. Create an empty index if none exists. Project knowledge now **follows the project** into every future workspace, automatically. This is the whole point.
- **Topics, on-demand:** inject the master `knowledge/INDEX.md` reference. Its tag directory tells the agent which tags exist; it then greps `topics/` by tag/content. Pure progressive disclosure — no topic note is auto-loaded.
- **`/servant:recall <query>` (build it):** searches `projects/` + `topics/` by tag and content, ranks, returns matching note bodies inline. Since topic retrieval is entirely grep-driven, this command encapsulates the recipe so every servant recalls consistently — and is the natural home for ranking/freshness later. No embeddings.

Workspace `CLAUDE.md` after wiring (extends today's `@../../CLAUDE.md` + `@GOAL.md`):

```
@../../CLAUDE.md
@GOAL.md
@../../knowledge/INDEX.md
@../../knowledge/projects/<repo-a>/INDEX.md
@../../knowledge/projects/<repo-b>/INDEX.md
```

## Capture (write) — auto at session end + manual  *(decided)*

**Trigger and work are separated** so nothing pops up or hangs: the hook is instant and dumb (enqueue only); a single headless worker does the extraction. Three entry points:

1. **Manual, in-session:** `/servant:extract-memories` — a markdown slash command (shipped via templates like `/servant:goal`). Distills the *current* transcript into atomic notes in the running session (no extra tab/process), reconciles, writes, commits.
2. **Automatic enqueue:** a `SessionEnd` hook → `servant extract-memories --from-hook` reads stdin and just **appends a job** to `~/.ai_servant/.cache/extract-queue.jsonl` (`session_id`, `transcript_path`, `workspace`, `cwd`, `ts`), then kicks the drainer if it isn't already running. Returns in milliseconds; spawns no `claude`.
3. **Drainer (headless, serialized):** `servant extract-memories --drain` acquires a lockfile (so only one runs ever), processes each queued job with **headless `claude -p` (no tab)** — distill → reconcile → write → `git commit` — then releases the lock and exits. A burst of `/clear`s just lengthens the queue; it never spawns concurrent processes or tabs.

**Visibility (no tabs, no notifications — retrospective by design):**
- **git log of `knowledge/`** — every capture is a commit (`memory: <repo> <slug>`); `git log -p` is the full free audit trail.
- **`servant memories`** — status/digest CLI: recent captures, pending-queue depth, last run + any error.

### Hook wiring (answers "can hooks live in the servant root like commands?")

Hooks are **JSON under a `hooks` key in `settings.json`**, *not* markdown like commands. But they can live in the **same `.claude/` folder the commands already live in**:

- Ship `~/.ai_servant/.claude/settings.json` via the existing `ensureServantAssets()` template sync (`src/core/claude-setup.ts`). Add `src/templates/servant_root/.claude/settings.json`.
- This works because Claude Code discovers the project `.claude/` by **walking up the directory tree** from the workspace cwd (`~/.ai_servant/workspaces/<name>/`) and finding `~/.ai_servant/.claude/`. That is *already* why `/servant:*` commands surface despite a bare `claude` launch (`src/agents/claude-code.ts` runs `claude` with no `--settings`/`CLAUDE_CONFIG_DIR`). Scoped to servant sessions only — normal shells elsewhere never see it.
- **Right event:** `SessionEnd` (fires once at close), not `Stop` (every turn).

> **Phase-0 must-verify:** confirm upward `.claude/` discovery applies to `settings.json` (empirically true for commands; not explicitly documented for settings). Validate with a throwaway `--root` setup and a trivial echo hook before building on it.
> **Fallbacks if not:** (a) scaffold a per-workspace `.claude/settings.json` in the workspace template (self-healing, slightly duplicative); or (b) write the hook into `~/.claude/settings.json` with a cwd guard, the way `src/commands/statusline.ts` already edits user settings.

Example `settings.json` hook:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "servant extract-memories --from-hook", "timeout": 15 }
        ]
      }
    ]
  }
}
```

### Transcript tracking

The `SessionEnd` hook receives JSON on **stdin** including `session_id`, `transcript_path`, `cwd`, `reason`. Use `transcript_path` **directly** — do not reconstruct; `--from-hook` records it in the queue job. Fallback locator (if a future payload omits it): existing `readSessionMeta()`/`listWorkspaceSessions()` in `src/core/claude-session.ts`.

### Loop avoidance (version-proof — the critical bit)

The drainer's headless `claude -p` is itself a Claude session → it will hit `SessionEnd` → would enqueue another job → loop.

**Solution:** the drainer runs `claude -p` with env `SERVANT_EXTRACTION=1`. The hook command is a subprocess of that claude process and inherits its env, so `servant extract-memories --from-hook` **first checks `process.env.SERVANT_EXTRACTION` and exits 0 immediately** if set — the extraction's own session never enqueues. Version-independent — does not rely on `--bare`/`disableAllHooks` flags (the claude-code-guide agent flagged those as version-dependent; treat as optional hardening only).

Belt-and-suspenders guards in `--from-hook` (enqueue), all → silent exit 0:
- `SERVANT_EXTRACTION` set (the extraction session itself).
- `cwd` not under `workspacesRoot()` (non-servant session that happened to inherit the hook).
- `transcript_path` missing/empty, or transcript has fewer than N turns (nothing worth extracting).
- `reason === "clear"` if we decide `/clear` shouldn't trigger extraction (open question).

### Per-job extraction behavior (headless drainer)

For each queued job the drainer runs headless `claude -p` with the extraction prompt (same content as `/servant:extract-memories`), pointed at the job's `transcript_path` and resuming from the incremental turn marker. The agent:
1. Reads the *new* transcript turns (since the marker), identifies **durable** facts (skip task-specific ephemera — same discipline as the memory rules).
2. Classifies each as **project** (which repo, inferred from the worktrees mounted / cwds in the transcript) or **topic** (flat file + tags, reusing existing tags).
3. Reconciles against existing notes (update vs. create — dedup by `name`+scope), updates the relevant per-repo `INDEX.md` and the thin master.
4. Writes, `git commit`s, advances the turn marker. The drainer aggregates an "added/updated N notes" line per job into the `servant memories` digest (no tab output).

## Resolved decisions (2026-06-16)

1. **Write policy → direct write, git-tracked.** `git init` the `knowledge/` dir; extraction writes notes straight in and auto-commits (e.g. `memory: <repo> <slug>`). Frictionless unattended capture, fully auditable/revertable via git. **Consequence:** the Phase-4 consolidation/prune pass matters more — the store will accumulate.
2. **Triggers → every `SessionEnd` reason, including `/clear`.** Maximizes capture (a `/clear` won't lose in-context learnings). **Consequences:** (a) **dedup/reconcile is load-bearing** — the same facts get re-proposed and must merge cleanly; (b) add an **incremental marker** (persist "extracted up to turn N" per session, e.g. under `~/.ai_servant/.cache/`) so each extraction tab only processes *new* turns instead of re-reading the whole transcript.
3. **Master index → thin.** Projects section links to per-repo `INDEX.md` (with counts); Topics section is a **tag directory** (tag vocabulary + counts), not a per-note list. Builder maintains the counts/tags. Reconciles with #4: topics have no per-dir index to link, so the master surfaces tags instead.
4. **Topic taxonomy → tag-based flat files.** `topics/*.md` with `tags:` in frontmatter; no topic subfolders. Retrieval is ripgrep over tags/content. Before creating a note, extraction reuses existing tags (greps the tag directory) to limit drift. Projects keep folder+index (needed for clean `@`-referencing); only topics go flat.
5. **`/servant:recall` → build it.** A real command (tag + content search, ranked, bodies inline). Load-bearing because topic recall is entirely grep-driven; lands in Phase 1 (completes the read path).
6. **Auto-extraction execution → queue + serialized headless drainer (no tabs).** `SessionEnd` only enqueues (instant); a single lockfile-guarded headless worker drains. Chosen over visible tabs (would carpet the terminal under extract-on-every-`/clear`) and over per-session headless spawns (burst = concurrent processes). **Visibility is retrospective:** git log of `knowledge/` + a `servant memories` digest command — *no* notifications, *no* tabs. (The manual `/servant:extract-memories` still runs in-session for watch-it-live needs.)

## Phasing

- **Phase 0 — Foundation + verification.** `src/core/knowledge.ts` (paths, note read/write, frontmatter parse/serialize, per-dir `INDEX.md` reconcile, thin-master rebuild with project counts + topic tag directory, robust **dedup/merge** by `name`+scope). `knowledgeRoot()` in `paths.ts`; `git init` the store on first write. Tests under `bun test`. **Verify the upward `.claude/settings.json` discovery assumption** with a throwaway echo hook before relying on it. No user-facing change yet.
- **Phase 1 — Retrieval (read path first).** Auto-`@`-reference `knowledge/projects/<repo>/INDEX.md` per mounted repo + master `INDEX.md` in workspace `CLAUDE.md` at `spawn`/`repo add` (create empty indexes). Ship **`/servant:recall <query>`** (tag + content ripgrep, ranked). Useful immediately — **hand-seed** notes and watch them load/recall before capture exists.
- **Phase 2 — Manual capture.** `/servant:extract-memories` slash command (template) that distills the current session in-session (no tab), reusing existing tags, reconciling via Phase-0 dedup, auto-committing. Factor the extraction logic into a shared core so the drainer reuses it.
- **Phase 3 — Automatic capture (queue + drainer).** Ship `settings.json` `SessionEnd` hook (all reasons) via `ensureServantAssets()`. Implement `servant extract-memories --from-hook` (stdin parse, loop/cwd guards, append to `extract-queue.jsonl`, kick drainer) and `--drain` (lockfile-serialized headless `claude -p` per job with `SERVANT_EXTRACTION=1`, the **incremental "extracted up to turn N" marker** so only new turns are read, write + `git commit`). Plus `servant memories` (digest: recent captures, pending depth, last error). End-to-end: any session end → silent enqueue → headless drain → notes committed.
- **Phase 4 — Polish.** Decay/staleness flags + "verify before trust" enforcement, consolidation/prune pass (merge near-duplicate tags, drop stale notes), recall ranking/freshness tuning.

## Files likely touched

- `src/core/paths.ts` — add `knowledgeRoot()`, project/topic path helpers.
- `src/core/knowledge.ts` *(new)* — note + index model, read/write/reconcile.
- `src/core/claude-setup.ts` + `src/templates/servant_root/.claude/settings.json` *(new)* — ship the hook.
- `src/templates/servant_root/.claude/commands/servant/extract-memories.md` *(new)* — the slash command.
- `src/core/workspace.ts` — extend `CLAUDE.md` scaffold with knowledge `@`-references.
- `src/commands/spawn.ts`, `src/commands/repo*.ts` — wire project-index references on mount; `SERVANT_EXTRACTION` env on the extraction spawn.
- `src/commands/extract-memories.ts` *(new)* — `--from-hook` (stdin parse, loop/cwd guards, enqueue, kick drainer) and `--drain` (lockfile, headless `claude -p` per job, turn marker, write + commit).
- `src/core/extract-queue.ts` *(new)* — append/read/clear the queue (`~/.ai_servant/.cache/extract-queue.jsonl`), lockfile acquire/release, turn-marker store.
- `src/commands/memories.ts` *(new)* — `servant memories`: digest (recent captures from git log, pending depth, last error).
- `src/commands/recall.ts` *(new)* — `servant recall <query>`: tag+content ripgrep over `knowledge/`, ranked, bodies inline.
- `src/templates/servant_root/.claude/commands/servant/recall.md` + `extract-memories.md` *(new)* — `/servant:recall` (thin CLI wrapper) and `/servant:extract-memories` (in-session distill).
- `src/index.ts` — register `extract-memories`, `recall`, `memories`.
- Tests for `knowledge.ts` (read/write, dedup/merge, thin-master rebuild), index reconcile, recall ranking, queue append/drain + lock serialization, and the loop-guard logic.
