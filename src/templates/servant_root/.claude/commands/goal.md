---
description: Interview the user to define (or amend) this workspace's GOAL.md — a lightweight statement of what the workspace is for.
argument-hint: [one-line goal]
---

# /goal

Define the **goal** of this servant workspace: a short `GOAL.md` at the workspace root that every
agent here auto-loads. Think of the mission as a **guiding beacon** the servants steer by while
they work — not a robust, detailed spec. It is **lightweight**: a sentence or two of mission plus
a couple of KPIs. It says *what this workspace is about* and *how we'll know it's working*. It is
**not** operating instructions (those live in `CLAUDE.md`) or architecture/design (those are ADRs
in `context/`). Don't duplicate either; link out instead.

The goal is a **living direction** — it can be re-run with `/goal` and updated as things evolve.

The optional argument `$ARGUMENTS` is a one-line seed for the goal. If present, treat it as the
user's answer to the opening question below and skip straight to the follow-ups.

## Core rule: nothing is written without explicit approval

`GOAL.md` only changes by direct user approval. **Never write or overwrite it until the user has
seen the exact draft and approved it.** This is the only way the goal changes.

## Process

### 1. Locate the workspace

Your cwd should be under `~/.ai_servant/workspaces/<name>/`. If it is not, ask the user how to
proceed — do not invent a workspace. The file you maintain is `GOAL.md` at the workspace root.

### 2. Define vs. amend

Read `GOAL.md`.

- If it still contains the `<!-- servant:goal:unfilled -->` marker (or is missing) → **first
  definition**, start at step 3.
- Otherwise → **amendment**: summarize the current goal back to the user, ask what's changing,
  keep everything they don't touch, then go to step 5.

### 3. Open with one broad question + an example

Start by asking the user, in plain language, **what the goal of this workspace is** — and seed it
with one short, concrete example so they know the shape of a good answer and you get a direction
to dig into. For example:

> **What's the goal of this workspace?** A sentence or two is plenty — we'll refine it together.
> e.g. *"Add OAuth login to the billing app so users stop getting locked out — done when users
> can sign in with Google and the support tickets about lockouts drop to ~zero."*

Adapt the example to anything you already know from the session. Don't ask a wall of questions
yet — just this one, and let their answer point you at what to ask next.

### 4. Iterate toward direction + KPIs

Using their answer as the thread, ask **targeted follow-ups one or two at a time** — only what's
needed to make the goal clear and to pin down how success is measured. Let the previous answer
decide the next question rather than running a fixed checklist. Typically you're after:

- The **mission** — what this workspace is about and why it matters (a beacon, kept short).
- One or two **KPIs / success signals** — concrete and verifiable where possible (a behavior
  works, a test passes, a number moves). Push gently for measurable, but don't force it.
- The **rough scope edge** — anything explicitly *not* in this workspace, if it's not obvious.

Keep it light: a handful of exchanges, not an interrogation. If something stays genuinely
unknown, leave a short `[NEEDS CLARIFICATION: …]` note rather than inventing an answer.

### 5. Present the draft and get confirmation

Assemble a short `GOAL.md` from this template (trim any section that doesn't earn its space):

```markdown
# Goal

## Mission
<one or two sentences: the guiding beacon — what this workspace is about and why>

## KPIs / success signals
- <concrete, verifiable signal 1>
- <concrete, verifiable signal 2>

## Out of scope
- <anything explicitly not part of this workspace>
```

**Show the user the full draft and ask them to confirm.** Revise and re-present until they
approve. Do not restate code, file paths, operating instructions, or architecture detail —
link to an ADR in `context/` if design context matters.

### 6. Write, then report

Only after explicit approval, write `GOAL.md` with the `servant:goal:unfilled` marker removed.
Then tell the user the goal is set, that every agent in this workspace auto-loads it, and that
they can run `/goal` again anytime to update it as things evolve.
