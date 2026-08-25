# Servant Workspace

You are running inside a **servant workspace** at `~/.ai_servant/workspaces/<name>/`. Servant (the `servant` CLI) creates and manages these workspaces. Other tabs in the same workspace may be sibling agents working alongside you.

## Workspace layout

```
<workspace>/
  GOAL.md                 # the workspace's intent / north star (auto-loaded every session)
  CONTEXT.md              # shared language / domain glossary (workspace-wide)
  docs/
    adr/
      NNNN-<slug>.md      # architecture decision records
    agents/               # the board's public contract, for any instruction set (auto-generated)
      issue-tracker.md    # every board operation, written for a reader new to servant
      domain.md           # where the domain docs are (CONTEXT.md + docs/adr/) and when to read them
      triage-labels.md    # the triage label vocabulary
  repos/                  # mounted repo worktrees (one per `servant repo add` / `spawn -r`)
```

- **Tasks and plans are tickets on the workspace's board** — not files in the workspace. See "The task tracker" below.
- **`GOAL.md`** holds the workspace's intent — what it's ultimately for. See "The workspace goal" below.
- **`CONTEXT.md`** holds the workspace's shared language: domain terms the ADRs, specs, and tickets reference.
- **`docs/adr/`** holds architecture decision records. **`docs/agents/`** is the board's **public contract** — auto-generated prose that tells any instruction set, including one that has never seen servant, how to operate this board. Read it; don't edit it (it is rewritten when servant's copy moves).

## Skills

Servant's own **core skills** are named `servant-*`. They ship inside the binary and are always on; `servant skills list` prints them alongside everything else installed.

**Everything else is installed, not bundled.** servant does not own the engineering flow — shaping specs, breaking work down, implementing, reviewing, TDD are all skills installed from a source, and which ones is the user's choice. `servant skills list` says what is installed and enabled right now, and what else a session can reach that servant does not manage; `/servant-skills` is where the judgment about sources, additions and removals lives. Do not assume a skill is available because it is conventional — check, or ask.

Specs and tickets are **published to the board**, not written as files here. Domain terms and decisions live in `CONTEXT.md` + `docs/adr/`, created lazily when there is something to record.

## The task tracker (the board)

Every workspace's tasks, specs, and tickets live on **servant's own board** — a local SQLite database at the servant root. Each workspace is a board of its own, so ticket numbers stay small; cross-workspace views union the boards. There is no GitHub, no `gh`, no account and no network, and every command works whether or not the viewer is open:

```
servant tasks                # every board's open tickets, grouped
servant tasks --ws <name>    # just this workspace
servant ticket new --title …  # file one
servant ticket show <n>      # read one, with its blockers and comments
```

Every operation — labels, comments, closing, blocking, claiming, maps and child tickets — is in `docs/agents/issue-tracker.md`. **Do not** create per-workspace `briefs/` or `plans/` files, and **do not** write blocking into a ticket body as prose: `servant ticket block <n> --on <m>` is the only representation, and a cycle is rejected as you add it.

To see where the whole initiative stands rather than one ticket — what is in flight and under which session, what is ready, what is blocked, and which Claims have gone stale — run **`/servant-lead`**. It joins the board, the Claims, the session registry and the transcripts into one report, and can redirect a running session from there. It is a skill, not a session type: any session runs it and leads for that turn.

## The workspace goal

`GOAL.md` at the workspace root is the **north star** for everyone working here — its intent:
what we're building and why, who it's for, what "done" looks like, and what's out of scope. The
workspace `CLAUDE.md` imports it, so it is **already in your context every session**. Let it
guide scope and priority decisions; if a request conflicts with it, surface that.

- **Offer, don't block.** If the loaded `GOAL.md` still carries the `servant:goal:unfilled`
  marker, the goal hasn't been defined yet. Briefly offer to run `/servant-goal` to define it — but if
  the user gives you a task, just do the task. Never gate work on defining the goal.
- **Changes need approval.** `GOAL.md` only changes by direct user approval. Never edit it
  silently — propose the change and let the user confirm. The `/servant-goal` skill handles the
  interview and writes only after sign-off.
- Keep it intent-only: design decisions belong in `docs/adr/`, operating instructions here
  in `CLAUDE.md` — `GOAL.md` should not duplicate either.

## Where artifacts go

Cross-session reasoning lives with the workspace or on the board — never inside the repo you are editing. The repo holds code.

- **Tasks / specs / tickets** → tickets on this workspace's board (`servant ticket new`, or whatever installed skill shapes them).
- **Architecture decisions** → `<workspace>/docs/adr/NNNN-<slug>.md`.
- **DO NOT** write plans/specs/tickets to `<repo>/docs/`, `<repo>/.scratch/`, `<repo>/PLAN.md`, or any path inside the repo. Most skills in the wild were written for a repo with no board behind it and will default to a file there — override that and file a ticket instead.

## Spawning & delegation

There are two ways to move work to another agent — pick by layer:

- **In-session subagent (the `Agent` tool)** — ephemeral, runs inside *your* session and returns a report to your context. It is how review, research and design skills fan out. Reach for it for tightly-scoped, AFK work you want back in this thread.
- **`servant spawn` (a new tab / fresh top-level agent)** — persistent, its own context, human-visible. Reach for it when a chunk of work deserves its own session: an independent subtask you want running in parallel, a sibling agent, or the continuation of work you are handing on. **Proactively suggest `servant spawn`** when you notice work that should live in its own session rather than crowding this one.

**Handing work forward — invoke `/servant-delegate`.** It owns the whole procedure: reading which tickets are actually dispatchable, writing the comment on the ticket that *is* the handoff (there is no handoff document and no path to pass), and claiming and spawning as one indivisible step. Run the skill rather than reconstructing the steps by hand — each of them has a failure mode this doc is too short to warn you about. `servant spawn --prompt "…"` remains the one-session primitive underneath.

**Worktree safety for subagents.** A mounted repo under `repos/` is a live git **worktree**. A subagent that does `git checkout -b research/<name>` there would switch the shared checkout's branch out from under the main agent. Read-only subagents — research, review, exploration — must stay read-only or take a worktree of their own; never switch the shared checkout.

## servant commands you'll reach for

```
servant tasks [--ws <name>]     # cross-workspace ticket view (grouped, deep-linked)
servant tasks --frontier --ws … # what is dispatchable; read by /servant-delegate
servant ticket <new|show|…>      # file, read and edit tickets on the board
servant claim <n> --session …    # who is carrying a ticket
servant recall <query>          # search accumulated knowledge notes
servant skills [list|…]         # what is installed and enabled; bare form is the picker
servant spawn -w <name> [-r]    # new workspace / tab; -r mounts repo worktrees
servant resume                  # re-attach to an earlier session
```

To define or amend the workspace's intent, use the `/servant-goal` skill — it interviews the user and writes `GOAL.md` only after approval.
