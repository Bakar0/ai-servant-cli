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
    agents/               # per-workspace config the engineering skills read (auto-generated)
      issue-tracker.md    # how/where tickets are filed — this workspace's board
      domain.md           # domain-doc consumer rules (CONTEXT.md + docs/adr/)
      triage-labels.md    # triage label vocabulary
  repos/                  # mounted repo worktrees (one per `servant repo add` / `spawn -r`)
```

- **Tasks and plans are tickets on the workspace's board** — not files in the workspace. See "The task tracker" below.
- **`GOAL.md`** holds the workspace's intent — what it's ultimately for. See "The workspace goal" below.
- **`CONTEXT.md`** holds the workspace's shared language: domain terms the ADRs, specs, and tickets reference.
- **`docs/adr/`** holds architecture decision records. **`docs/agents/`** holds the engineering-skills config (auto-generated; you rarely edit it by hand).

## The engineering workflow (mattpocock skills)

This workspace uses the **mattpocock engineering skills** (installed as the `mattpocock-skills` plugin). Reach for them by name; they read their per-workspace config from `docs/agents/` (see the `## Agent skills` block below, injected per workspace):

```
/grill-me       align on the task before building — resolve ambiguity first
/to-spec        turn the conversation into a spec ticket on the board
/to-tickets     break a spec/plan into tracer-bullet tickets (with blocking edges)
/implement      build a ticket end-to-end
/tdd            tight red-green loop while implementing
/code-review    two-axis review (standards + spec) of the diff
/handoff        write a handoff doc so a fresh session can continue  (see "Spawning & handoff")
/teach          explain a concept or a slice of the codebase
/wait-what      stop and get unstuck when something doesn't add up
```

Specs and tickets are **published to the board**, not written as files here. Domain terms and decisions live in `CONTEXT.md` + `docs/adr/` (created lazily by `/domain-modeling`).

## The task tracker (the board)

Every workspace's tasks, specs, and tickets live on **servant's own board** — a local SQLite database at the servant root. Each workspace is a board of its own, so ticket numbers stay small; cross-workspace views union the boards. There is no GitHub, no `gh`, no account and no network, and every command works whether or not the viewer is open:

```
servant tasks                # every board's open tickets, grouped
servant tasks --ws <name>    # just this workspace
servant ticket new --title …  # file one
servant ticket show <n>      # read one, with its blockers and comments
```

Every operation — labels, comments, closing, blocking, claiming — is in `docs/agents/issue-tracker.md`, including all of the `/wayfinder` ones. **Do not** create per-workspace `briefs/` or `plans/` files, and **do not** write blocking into a ticket body as prose: `servant ticket block <n> --on <m>` is the only representation, and a cycle is rejected as you add it.

To see where the whole initiative stands rather than one ticket — what is in flight and under which session, what is ready, what is blocked, and which Claims have gone stale — run **`/servant:lead`**. It joins the board, the Claims, the session registry and the transcripts into one report, and can redirect a running session from there. It is a skill, not a session type: any session runs it and leads for that turn.

## The workspace goal

`GOAL.md` at the workspace root is the **north star** for everyone working here — its intent:
what we're building and why, who it's for, what "done" looks like, and what's out of scope. The
workspace `CLAUDE.md` imports it, so it is **already in your context every session**. Let it
guide scope and priority decisions; if a request conflicts with it, surface that.

- **Offer, don't block.** If the loaded `GOAL.md` still carries the `servant:goal:unfilled`
  marker, the goal hasn't been defined yet. Briefly offer to run `/servant:goal` to define it — but if
  the user gives you a task, just do the task. Never gate work on defining the goal.
- **Changes need approval.** `GOAL.md` only changes by direct user approval. Never edit it
  silently — propose the change and let the user confirm. The `/servant:goal` command handles the
  interview and writes only after sign-off.
- Keep it intent-only: design decisions belong in `docs/adr/`, operating instructions here
  in `CLAUDE.md` — `GOAL.md` should not duplicate either.

## Where artifacts go

Cross-session reasoning lives with the workspace or on the board — never inside the repo you are editing. The repo holds code.

- **Tasks / specs / tickets** → tickets on this workspace's board (`/to-spec`, `/to-tickets`, or `servant ticket new`).
- **Architecture decisions** → `<workspace>/docs/adr/NNNN-<slug>.md`.
- **DO NOT** write plans/specs/tickets to `<repo>/docs/`, `<repo>/.scratch/`, `<repo>/PLAN.md`, or any path inside the repo. If a planning skill defaults to writing inside the repo, override it — file a ticket instead.

## Spawning & handoff

There are two ways to move work to another agent — pick by layer:

- **In-session subagent (the `Agent` tool)** — ephemeral, runs inside *your* session and returns a report to your context. This is what `/code-review`, `/research`, `/wayfinder`, and the design skills use to fan out. Reach for it for tightly-scoped, AFK work you want back in this thread.
- **`servant spawn` (a new tab / fresh top-level agent)** — persistent, its own context, human-visible. Reach for it when a chunk of work deserves its own session: continuing after a `/handoff`, an independent subtask you want running in parallel, or a sibling agent. **Proactively suggest `servant spawn`** when you notice work that should live in its own session rather than crowding this one.

**Handing work forward — `/servant:handoff`.** This is the one "take it forward" gesture at any seam in the flow. It writes the handoff doc, decides the next step (route: `/to-spec` → `/to-tickets` → `/implement`), and **spawns the continuation session(s) itself** — one per ready ticket — so the user never hand-types a `servant spawn`. It reads the dispatchable set from `servant tasks --frontier --ws <name> --json`, which sorts open tickets into `ready` (unblocked, unclaimed), `stale` (claimed by a session that is gone — reclaimed silently), `inFlight` (someone is on it — **refused** without an explicit override) and `blocked`. It fans out over `ready` + `stale`: tickets on different repos run in parallel; two on the same repo run first-then-rest. Plain mattpocock `/handoff` still exists for the rare "just write a doc, I'll continue myself" case; `servant spawn --prompt "…"` remains the one-session primitive underneath.

**Worktree safety for research/wayfinder.** A mounted repo under `repos/` is a live git **worktree**. A subagent that does `git checkout -b research/<name>` there would switch the shared checkout's branch out from under the main agent. Research/wayfinder subagents must stay **read-only** or use their own worktree, and write `/research` findings into `docs/` — never switch the shared checkout.

## servant commands you'll reach for

```
servant tasks [--ws <name>]     # cross-workspace ticket view (grouped, deep-linked)
servant tasks --frontier --ws … # ready / stale / in-flight / blocked; feeds /servant:handoff
servant ticket <new|show|…>      # file, read and edit tickets on the board
servant claim <n> --session …    # who is carrying a ticket
servant recall <query>          # search accumulated knowledge notes
servant spawn -w <name> [-r]    # new workspace / tab; -r mounts repo worktrees
servant resume                  # re-attach to an earlier session
```

To define or amend the workspace's intent, use the `/servant:goal` slash command — it interviews the user and writes `GOAL.md` only after approval.
