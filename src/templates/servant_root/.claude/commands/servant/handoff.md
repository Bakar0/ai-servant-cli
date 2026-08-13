---
description: Hand the current work forward — write a handoff doc, figure out the next step in the flow, and spawn the session(s) that continue it (one per ready ticket).
argument-hint: "[optional: what the next session should focus on]"
disable-model-invocation: true
---

# /servant:handoff

The single "take it forward" gesture at any seam in the flow. It captures this session's state,
decides what should happen next, and **launches the next session(s) for you** — so you never
hand-type a `servant spawn` prompt. It's the servant continuation layer on top of the mattpocock
`/handoff` discipline: same doc, but it also dispatches.

Use it whenever you're done with a step and want the work to continue in a fresh session —
after `/grill-me`, after `/to-tickets`, when context is filling mid-`/implement`, etc.

## 1. Orient

- **Workspace**: infer from cwd (`~/.ai_servant/workspaces/<name>/…`).
- **The tracker**: read `docs/agents/issue-tracker.md` (the tracker is this workspace's own board —
  a local database, so ticket numbers are board-scoped and small).
- If `$ARGUMENTS` is present, treat it as what the next session should focus on.

## 2. Write the handoff doc

Follow the mattpocock `/handoff` discipline — write a Markdown doc to the OS temp dir (NOT the
workspace/repo):

- Summarise the conversation so a fresh agent can continue. **Don't** duplicate anything already
  captured in a spec/ticket/ADR/commit — reference it by number or path.
- Redact secrets (keys, tokens, PII).
- End with a **"Next"** section naming the skill(s) the continuation should run (e.g.
  `/to-spec`, `/to-tickets`, `/implement #13`).

Print the doc's absolute path — you'll pass it to each spawned session.

## 3. Decide the next step (route)

Read the flow state and pick the continuation. When unsure which skill fits, reason it through as
`/ask-matt` would:

| Where the work is | Next action this skill takes |
|-------------------|------------------------------|
| Idea sharpened, no spec yet | spawn **one** session → `/to-spec` |
| Spec exists, no tickets | spawn **one** session → `/to-tickets` (or `/wayfinder` if it's too big for one session) |
| Tickets exist | **dispatch mode** → step 4 |
| Mid-implement, context full | spawn **one** session → resume `/implement <#>` on the same ticket |

## 4. Dispatch mode — fan out the ready tickets

1. Get the frontier (deterministic — don't eyeball the board):

   ```
   servant tasks --frontier --ws <name> --json
   ```

   Four buckets come back, and which ones you may dispatch is the point:

   | bucket | what it means | dispatch? |
   |---|---|---|
   | `ready[]` | unblocked, nobody holds the Claim | **yes** |
   | `stale[]` | unblocked, but the session holding the Claim is **gone** | **yes — reclaim first** |
   | `inFlight[]` | a session is on it (or its liveness is unknown) | **no** — see below |
   | `blocked[]` | an open blocker on the board | **never** |

   **Refuse to spawn onto a live Claim.** For anything in `inFlight[]`, do not spawn. Say which
   session holds it and since when — the entry carries `claim.session` and `claim.since`:

   > **#25** is already being worked by `ai-servant-t26` (since 21:06). Not spawning.
   > Re-run with an override if you want a second session on it anyway.

   Spawn onto it **only** if the user explicitly overrides in this conversation ("yes, spawn anyway",
   "take it over"). Then pass the ticket's Claim to the new session, which transfers it rather than
   duplicating it. Two sessions on one ticket means two sessions in one worktree, which is exactly
   what the Claim exists to prevent — so the override has to be asked for, never assumed.

   `liveness: "unknown"` (the session registry could not be read) is in `inFlight[]` on purpose:
   a ticket you cannot prove is free is not free. Say you could not check, rather than guessing.

   **Reclaim a stale Claim silently.** Anything in `stale[]` is dispatchable — its Claim points at a
   session that no longer exists, which is just cleanup, not a decision. Reclaim it *explicitly*
   as part of dispatching, then spawn as normal:

   ```
   servant claim <N> --session <workspace>-t<N>
   ```

   `servant spawn` does **not** write Claims — only `servant claim` and the voice delegation path
   do — so without this line the dead Claim survives the spawn and the ticket still reads as stale
   to the next run. "Silently" means without asking; it does not mean without doing it. Say in the
   report that you reclaimed it.

2. For each dispatchable ticket — `ready[]` plus `stale[]` — determine its **target repo**: a
   `repo:<name>` label if present, else infer from the ticket body/title, else ask the user.

3. **Parallel-safety rule:**
   - Dispatchable tickets on **different repos** → safe to run **in parallel** (separate worktrees,
     no collision).
   - Two+ dispatchable tickets on the **same repo** → run the **first now, the rest after** (they'd
     share one worktree). Say so in the summary; don't silently drop them.

## 5. Confirm, then spawn

Show the plan and get a go:

> Ready: **#13** (repoA) and **#14** (repoB) — parallel. **#15** waits on #13.
> **#25** is in flight (`ai-servant-t26`) — skipping. **#22**'s claim is stale (`ws-t22` is gone) — reclaiming.
> Spawn 2 implement sessions now?

On confirmation, spawn one session per dispatchable ticket:

```
servant spawn -w <name> --prompt "Read <handoff-doc>. Run /implement #<N> for the <repo> ticket on the <name> board; follow its acceptance criteria, drive /tdd at the seams, and close with /code-review before committing."
```

`servant spawn` auto-detects the workspace and opens a new tab per call — that's the fan-out.

## 6. Report

Tell the user exactly what happened: which tickets got a session (with tab names), which are held
and why — same-repo serial, blocked by an open ticket, or **already in flight under another
session** — and how to release them (re-run `/servant:handoff` once the blocker/first ticket
closes, or once the holding session finishes and releases its Claim). Name any stale Claim you
reclaimed, so a reclaim is never silent in the *report* even though it needs no permission.

## Notes

- This skill **launches** work; it doesn't implement it — the spawned sessions do, via `/implement`.
- If there are no tickets and nothing to shape, say so and stop — don't invent work.
- `servant spawn` is the only side-effecting step; never spawn without the step-5 confirmation.
- Never spawn onto a ticket in `inFlight[]` without an explicit override from the user in this
  conversation. Re-running this skill on a ticket somebody is already carrying is how two sessions
  end up in one worktree — the failure Claims exist to stop.
