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
- **Hub + label**: read `docs/agents/issue-tracker.md` (the tracker is the shared hub; this
  workspace's issues carry `ws:<name>`).
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

1. Get the frontier (deterministic — don't eyeball `gh`):

   ```
   servant tasks --frontier --ws <name> --json
   ```

   Use `ready[]` (blockers closed) — never dispatch anything in `blocked[]`.

2. For each ready ticket, determine its **target repo**: a `repo:<name>` label if present, else
   infer from the ticket body/title, else ask the user.

3. **Parallel-safety rule:**
   - Ready tickets on **different repos** → safe to run **in parallel** (separate worktrees, no
     collision).
   - Two+ ready tickets on the **same repo** → run the **first now, the rest after** (they'd share
     one worktree). Say so in the summary; don't silently drop them.

## 5. Confirm, then spawn

Show the plan and get a go:

> Ready: **#13** (repoA) and **#14** (repoB) — parallel. **#15** waits on #13.
> Spawn 2 implement sessions now?

On confirmation, spawn one session per dispatchable ticket:

```
servant spawn -w <name> --prompt "Read <handoff-doc>. Run /implement #<N> for the <repo> ticket in the hub (ws:<name>); follow its acceptance criteria, drive /tdd at the seams, and close with /code-review before committing."
```

`servant spawn` auto-detects the workspace and opens a new tab per call — that's the fan-out.

## 6. Report

Tell the user exactly what happened: which tickets got a session (with tab names), which are held
(same-repo serial, or blocked by an open ticket), and how to release them (re-run `/servant:handoff`
once the blocker/first ticket closes).

## Notes

- This skill **launches** work; it doesn't implement it — the spawned sessions do, via `/implement`.
- If there are no tickets and nothing to shape, say so and stop — don't invent work.
- `servant spawn` is the only side-effecting step; never spawn without the step-5 confirmation.
