---
description: Distill the current session into an Agent Brief and spawn a servant in this workspace to execute it.
argument-hint: [one-line goal]
---

# /delegate

Hand a piece of work from this session off to a fresh servant running in a new tab of the **same workspace** in your Servantry. You write an Agent Brief (the contract) and any reusable context files; the servant reads the brief and executes.

The optional argument `$ARGUMENTS` is a one-line seed goal. If absent, infer the goal from the current session.

## When something is ambiguous, ASK

You are about to spawn another agent. Misalignment compounds. Whenever the goal, scope, acceptance criteria, or workspace is unclear, **stop and ask the user** before writing files or spawning.

## Workspace conventions

Each servant workspace lives under `~/.ai_servant/workspaces/<name>/` and follows this layout:

```
<workspace>/
  CONTEXT.md              # shared language / domain glossary (workspace-wide)
  briefs/
    INDEX.md              # list of briefs + status + one-line summary
    <YYYY-MM-DD-HHMM>-<slug>.md
  context/
    INDEX.md              # list of context docs + when each applies
    adr-NNN-<slug>.md     # architecture decision records
    <topic>.md            # reusable reference docs
```

- **Briefs** are the contract — one self-contained markdown file per delegation.
- **CONTEXT.md** at workspace root holds the shared language: domain terms, recurring concepts, "ubiquitous language" that briefs and ADRs reference.
- **context/** holds reusable reference docs (ADRs, system overviews) that multiple briefs can link to via relative paths like `../context/adr-001-jwt-rotation.md`.

## Process

### 1. Locate the workspace

Your cwd should be a directory under `~/.ai_servant/workspaces/<name>/`. If it is not, ask the user how to proceed — do not invent a workspace.

All file writes below use paths relative to the workspace root.

### 2. Distill the goal

If `$ARGUMENTS` is non-empty, treat it as a seed. Otherwise, infer from the recent session. Either way, restate the goal in your own words and confirm with the user before continuing — unless the goal is unambiguous and the user's intent to delegate it is clear.

### 3. Write the Agent Brief

Create `briefs/<YYYY-MM-DD-HHMM>-<kebab-slug>.md`. Slug should be 2-5 words from the Summary line. Use this template (adapted from mattpocock's agent-brief format):

```markdown
## Agent Brief

**Category:** bug / enhancement
**Summary:** one-line description of what needs to happen

**Current behavior:**
Describe the status quo. For bugs, the broken behavior. For enhancements, what the feature builds on.

**Desired behavior:**
Describe what should happen after the work is complete. Be specific about edge cases and error conditions.

**Key interfaces:**
- `TypeName` — what needs to change and why
- `functionName()` — current vs expected behavior
- Config shape — any new options

**Acceptance criteria:**
- [ ] Specific, testable criterion 1
- [ ] Specific, testable criterion 2

**Out of scope:**
- Thing that should NOT be changed
- Adjacent feature that might seem related but is separate

**Context:**
- [../CONTEXT.md](../CONTEXT.md) — domain glossary
- [../context/adr-001-...md](../context/adr-001-...md) — relevant ADR (link only the ones that apply)
```

Brief principles (from mattpocock):

- **Durability over precision.** Describe interfaces, types, and behavioral contracts. Do NOT reference file paths or line numbers — they go stale.
- **Behavioral, not procedural.** Describe WHAT the system should do, not HOW to implement it. The servant will explore the codebase fresh.
- **Complete acceptance criteria.** Each item independently verifiable.
- **Explicit scope boundaries.** Prevents the servant from gold-plating.

### 4. Update / write reusable context

If the brief depends on terms or decisions that recur across delegations, capture them so they are reusable:

- New domain terms → add to `CONTEXT.md` (create if missing).
- Architectural decisions made during this session → write `context/adr-<NNN>-<slug>.md` with `# Title`, `**Decision:**`, `**Reason:**`, `**Consequences:**`. NNN is the next monotonic number.
- System overviews / explanations the servant will need → write `context/<topic>.md`.

Link each context doc from the brief's "Context" section.

Only write context that is genuinely reusable. One-off details belong in the brief itself.

### 5. Update the INDEX files

After writing the brief and any context, update:

- `briefs/INDEX.md` — append a row: `- [YYYY-MM-DD-HHMM-slug](YYYY-MM-DD-HHMM-slug.md) — one-line summary [status: pending]`
- `context/INDEX.md` — for each new context file, append: `- [filename](filename.md) — when this applies`

Create either INDEX.md with a `# Briefs` / `# Context` heading if it doesn't exist.

### 6. Spawn the servant

Run:

```bash
servant spawn --prompt "Read briefs/<filename>.md and execute the Agent Brief. Start by reading any context files the brief links to."
```

Do **not** pass `--workspace`; it defaults to the current workspace, which is what we want.

Report back to the user where the new tab was opened and the brief file path.

## Examples of when to ask

- Session has touched several topics — which one is being delegated?
- User said "delegate this" with no prior conversation about scope.
- Cwd is not a servant workspace.
- The brief's acceptance criteria depend on an unstated success metric.
- An ADR captured during this session contradicts an existing ADR in `context/`.

In all of these, stop and ask one question at a time.
