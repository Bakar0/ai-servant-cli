# Servant Workspace

You are running inside a **servant workspace** at `~/.ai_servant/workspaces/<name>/`. Servant (the `servant` CLI) creates and manages these workspaces. Other tabs in the same workspace may be sibling agents working alongside you.

## Workspace layout

```
<workspace>/
  CONTEXT.md              # shared language / domain glossary (workspace-wide)
  briefs/
    INDEX.md              # list of briefs + status + one-line summary
    <YYYY-MM-DD-HHMM>-<slug>.md   # an Agent Brief (the contract for one delegated task)
  context/
    INDEX.md              # list of context docs + when each applies
    adr-NNN-<slug>.md     # architecture decision records
    <topic>.md            # reusable reference docs
```

- **Briefs are contracts.** Each brief is a self-contained spec for one delegated task. The brief — not the spawning prompt — is the source of truth.
- **`CONTEXT.md`** holds the workspace's shared language: domain terms and ubiquitous vocabulary that briefs and ADRs reference.
- **`context/`** holds reusable reference docs. Briefs link to them via relative paths like `../context/adr-001-jwt-rotation.md`.

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

To hand a piece of work to a fresh sub-agent in this workspace, use the `/delegate` slash command. It writes a new Agent Brief into `briefs/`, updates the INDEX files, then runs `servant spawn --prompt "Read briefs/<file>.md and execute the Agent Brief."` (which opens a new tab in this same workspace).
