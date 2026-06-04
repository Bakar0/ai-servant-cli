# Servant Workspace

You are running inside a **servant workspace** at `~/.ai_servant/workspaces/<name>/`. Servant (the `servant` CLI) creates and manages these workspaces. Other tabs in the same workspace may be sibling agents working alongside you.

## Workspace layout

```
<workspace>/
  CONTEXT.md              # shared language / domain glossary (workspace-wide)
  briefs/
    INDEX.md              # list of briefs + status + one-line summary
    <YYYY-MM-DD-HHMM>-<slug>.md   # an Agent Brief (the contract for one delegated task)
  plans/
    INDEX.md              # list of plans + status + one-line summary
    <YYYY-MM-DD-HHMM>-<slug>.md   # an implementation plan (phases / sequencing)
  context/
    INDEX.md              # list of context docs + when each applies
    adr-NNN-<slug>.md     # architecture decision records
    <topic>.md            # reusable reference docs
```

- **Briefs are contracts.** Each brief is a self-contained spec for one delegated task. The brief — not the spawning prompt — is the source of truth.
- **Plans are working scaffolds.** A plan captures procedural sequencing — phases, milestones, investigation steps — for work whose *how* is non-trivial. Plans pair with the brief they implement via backlinks; you will edit a plan as execution reveals reality.
- **`CONTEXT.md`** holds the workspace's shared language: domain terms and ubiquitous vocabulary that briefs, plans, and ADRs reference.
- **`context/`** holds reusable reference docs. Briefs and plans link to them via relative paths like `../context/adr-001-jwt-rotation.md`.

## Where artifacts go

All servant artifacts — briefs, plans, ADRs, context docs — live in **this workspace**, never in the repo you are working on. The repo holds code; the workspace holds the cross-session reasoning around the code.

- **DO** write to `<workspace>/plans/<YYYY-MM-DD-HHMM>-<slug>.md` and update `<workspace>/plans/INDEX.md`.
- **DO NOT** write to `<repo>/docs/plans/`, `<repo>/.scratch/`, `<repo>/PLAN.md`, or any path inside the repo you are editing.

This applies even when a planning skill or slash command (e.g. `/plan`, `planning`) would default to writing inside the repo — override the default and write into `<workspace>/plans/` instead, then append an entry to `plans/INDEX.md`. If the plan implements a specific brief, link the brief from the plan and link the plan from the brief.

## If you were spawned to execute a brief

If your first user message points you at a brief (e.g. `Read briefs/<x>.md and execute the Agent Brief`):

1. Read the brief file in full — it is the contract.
2. Read every file linked under the brief's **Context** section (`../CONTEXT.md`, `../context/*.md`).
3. Execute the brief's **Acceptance criteria**. Do not work outside its **Out of scope** list.
4. When finished (or blocked), update `briefs/INDEX.md` to mark this brief's status: `[status: done]`, `[status: blocked: <reason>]`, or `[status: in-progress]`.

## Brief format (mattpocock Agent Brief)

Briefs follow this template:

- **Category** — bug / enhancement
- **Summary** — one-line description
- **Current behavior** — status quo
- **Desired behavior** — what should happen after the work
- **Key interfaces** — types, signatures, config shapes that change (no file paths or line numbers — they go stale)
- **Acceptance criteria** — concrete, independently testable checklist
- **Out of scope** — explicit boundaries
- **Context** — links to relevant `CONTEXT.md` / ADRs / topic docs

Briefs describe **what**, not **how**. Behavioral, not procedural.

## Delegating onward

To hand a piece of work to a fresh servant in this workspace, use the `/delegate` slash command. It writes a new Agent Brief into `briefs/`, updates the INDEX files, then runs `servant spawn --prompt "Read briefs/<file>.md and execute the Agent Brief."` (which opens a new tab in this same workspace).
