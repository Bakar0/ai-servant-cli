---
description: Distill durable knowledge from the current session into the servant knowledge base (projects + topics).
---

# /servant:extract-memories

Capture what this session learned that **outlives the task** into the durable, subject-keyed
servant knowledge base at `~/.ai_servant/knowledge/` (relative to your cwd: `../../knowledge/`).
This runs **in-session** — no new tab, no headless process. The same distillation also happens
automatically at session end via a queue + headless drainer; this command is for capturing now,
watching it happen.

## What to capture

Only **durable** facts — what a future servant on the same repo or topic would want to know.
Skip task-specific ephemera (what you did this session, transient state, anything that won't
matter next week — same discipline as good memory notes).

- **Project facts** → `knowledge/projects/<repo>/<slug>.md`, scope `project/<repo>`. Classify by
  repo from the worktrees mounted under the workspace (`repos/<repo>__<branch>/`). No tags.
- **Topic facts** → `knowledge/topics/<slug>.md`, scope `topic`, with `tags:`.

## Reuse existing tags

Read `../../knowledge/INDEX.md` first — its Topics section is the existing tag vocabulary. Reuse
those tags where they fit instead of inventing near-duplicates.

## Reconcile (dedup by name+scope)

Pick a kebab-case slug per fact. If a note with that slug already exists in the same scope,
**update it in place** (merge — never duplicate). Otherwise create it.

## Note format

```markdown
---
name: <kebab-slug>
description: <one-line summary — what recall surfaces>
scope: topic            # or project/<repo>
tags: [tag-a, tag-b]    # topics only; omit for project notes
source: { date: <YYYY-MM-DD>, commit: <short-sha-if-known> }
confidence: high        # high | medium | low
---
<the fact, a sentence or two. Link related notes with [[other-slug]].>
```

## Process

1. Review the session for durable facts. If there are none, say so and stop — don't invent any.
2. Confirm the candidate notes with the user if anything is ambiguous (which repo, topic vs
   project, whether a fact is really durable).
3. Write/update the note files using the format above.
4. Run the reconcile step — it rebuilds every per-repo `INDEX.md` and the thin master, then commits:

   ```bash
   servant extract-memories --reconcile -m "memory: <short summary>"
   ```

5. Report which notes you added or updated.
