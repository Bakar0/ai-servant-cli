---
name: servant-delegate
description: Hand a piece of work off to a fresh session in this workspace — the ticket carries the context, the Claim carries the ownership, and one line of prompt starts it. Use when work should continue in its own session: after shaping a plan, once tickets exist, or when this session's context is filling mid-task.
---

# /servant-delegate

Hand work to a fresh session in the same workspace. **The ticket is the handoff** — you write a
comment on it, the spawned session reads it. No handoff doc, no temp file, no path to pass along,
which is why the prompt is one line and the context outlives the session that wrote it.

If `$ARGUMENTS` names a ticket or says what to hand off, start there. Otherwise read the frontier
and offer what is dispatchable. Workspace: infer from cwd. Board operations, including filing:
`docs/agents/issue-tracker.md`.

## 1. There must be a ticket

It is the only thing the next session is guaranteed to be able to read. **No ticket yet? File one,
comment, spawn** — one rule, at every stage of the work. Splitting something too big for one session
is a task-shaping skill's job if one is enabled; do not grow a routing table here.

## 2. Read the frontier

Deterministic — don't eyeball the board:

```bash
servant tasks --frontier --ws <name> --json
```

| bucket | means | dispatch? |
|---|---|---|
| `ready[]` | unblocked, nobody holds the Claim | **yes** |
| `stale[]` | unblocked, the session holding the Claim is **gone** | **yes — reclaim as you go** |
| `inFlight[]` | a session is on it, or liveness is unknown | **no** — see below |
| `blocked[]` | an open blocker on the board | **never** |

**Refuse to spawn onto a live Claim.** Name who holds it and since when (`claim.session`,
`claim.since`), and stop. Spawn anyway only on an explicit override in this conversation ("take it
over") — two sessions on one ticket is two sessions in one worktree, the exact failure Claims exist
to prevent. `liveness: "unknown"` is in `inFlight[]` on purpose: a ticket you cannot prove is free is
not free. Say you could not check rather than guessing.

**Reclaim a stale Claim without asking** — it points at a session that no longer exists, which is
cleanup, not a decision. Reclaim in step 4, and say in the report that you did.

Find each dispatchable ticket's repo: a `repo:<name>` label, else the body, else ask. **Different
repos run in parallel; two on the same repo run first-then-rest**, since they share one worktree.
Say which you held back — never drop them silently.

## 3. Write the comment that is the handoff

```bash
servant ticket comment <N> --body "…"
```

Write for someone holding the ticket body and nothing else — **not a summary of this conversation**:

- **Where to work** — worktree path, branch, and what its base already carries.
- **What to read first** — the one prior comment or ADR that is the decision record, by number.
- **What was already measured**, said as measured, so it is not re-derived.
- **The specific way this ticket goes wrong** — the trap you can see and they cannot.
- **What was settled after the body was written** and so is not in it.

Never restate the body, never paste secrets, and point at specs, ADRs and commits by number or path
rather than quoting them.

## 4. Confirm, then claim and spawn as one step

Spawning is the side-effecting step, so show the plan and get a plain go:

> **#13** (repoA) and **#14** (repoB) — parallel. **#15** waits on #13. **#25** is in flight
> (`ws-t25`) — skipping. **#22**'s Claim is stale — reclaiming. Spawn 2 sessions?

Then, per ticket, **both lines together**:

```bash
servant claim <N> --session <ws>-t<N>
servant spawn -w <ws> --name <ws>-t<N> --prompt "Ticket #<N> on the <ws> board — read it; the last comment is your handoff."
```

Neither line works alone, and both failures have happened here. `servant spawn` writes no Claim, so
without the first the ticket still reads as free. Without `--name` the session picks its own, so the
Claim you just wrote points at an address nothing answers to and the ticket reads as stale
immediately. Claim and spawn are indivisible.

Name an implement-style skill in the prompt **only if one is actually enabled** (`servant skills
list`) — `Work it with /<skill>.` Otherwise the line above stands on its own. Servant does not own
`/implement`; it is a catalog entry in `/servant-skills`, so never hardcode it.

## 5. Report

Which tickets got a session and under which tab name; which are held and why — same-repo serial,
blocked, or in flight under another session; which stale Claims you reclaimed. Say what releases
each held one: re-run this skill once the blocker or the first ticket closes, or once the holding
session releases its Claim.

## Notes

- This launches work; it does not do it. Nothing dispatchable and nothing to file — say so and stop.
- To *read* where everything stands, or redirect a session already running, use `/servant-lead`.
