---
description: Recall what prior servants learned about a project or topic from the servant knowledge base.
argument-hint: <query>
---

# /servant:recall

Search the durable **servant knowledge base** (`~/.ai_servant/knowledge/`) for facts prior
servants captured about projects and topics, and bring the matches into this session. Knowledge
is keyed by *subject* (repo or topic), so it survives long after the workspace that learned it.

`$ARGUMENTS` is the search query (tags and/or free text). If it is empty, ask the user what they
want to recall, or infer a query from the current task.

## Process

1. Run the search and read the matching note bodies it prints inline:

   ```bash
   servant recall "$ARGUMENTS"
   ```

   It ranks by tag match, then name, description, and body — projects and topics together.

2. **Apply the verify-before-trust rule.** Any note that names a specific file, function, symbol,
   or flag may have rotted since it was written (see each note's `source` date/commit). Before you
   rely on such a fact, re-check it against the current code. Treat notes as leads, not gospel.

3. Use what's relevant to the current task. If nothing matches, say so and proceed — the base is
   sparse early on and fills in as servants capture more (`/servant:extract-memories`).

## Tips

- Topic notes are found by **tag** — the master `knowledge/INDEX.md` (already in your context)
  lists the tag vocabulary with counts. Recall by those tags for the sharpest matches.
- Pass `-n <N>` to widen/narrow how many notes print: `servant recall "bun sqlite" -n 15`.
