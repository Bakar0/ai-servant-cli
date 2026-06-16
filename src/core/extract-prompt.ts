// The canonical extraction instructions. The headless drainer feeds this to `claude -p`;
// the `/servant:extract-memories` slash command mirrors the same discipline for in-session
// distillation. Both end by writing notes in the documented format and running
// `servant extract-memories --reconcile` so index/master maintenance stays deterministic.

export interface ExtractPromptOptions {
  transcriptPath: string;
  /** Transcript entry index already extracted; only later turns are new. */
  fromTurn: number;
  /** Working directory of the ended session (used to infer the project repos). */
  cwd: string;
  /**
   * The user's `memory-extraction` fine-tune overlay (comments stripped), if any. Appended
   * verbatim as user overrides so the headless drainer and the in-session slash command
   * (which gets the same overlay via asset composition) stay in sync.
   */
  fineTuneOverlay?: string | null;
}

export function buildExtractionPrompt(opts: ExtractPromptOptions): string {
  const overlay = opts.fineTuneOverlay?.trim();
  const fineTuneSection = overlay
    ? `\n\n## Local fine-tuning (user overrides — take precedence over the above)\n${overlay}`
    : "";
  return `You are the servant knowledge extractor running headlessly. Distill durable knowledge from a just-ended coding session into the servant knowledge base. Do not converse — just do the work and stop.

## Source
- Transcript (JSONL): ${opts.transcriptPath}
- Already extracted up to entry: ${opts.fromTurn} — only consider transcript entries AFTER this index. If there is nothing new and durable, write nothing and stop.
- Session cwd: ${opts.cwd}

## Knowledge store
The store is at the servant root's \`knowledge/\` directory (relative to the session cwd: \`../../knowledge/\`). Layout:
- \`knowledge/projects/<repo>/<slug>.md\` — one atomic fact about a specific repo.
- \`knowledge/topics/<slug>.md\` — one atomic fact about a technology/topic, found by tags.

## What to capture
Capture only **durable** facts that outlive this task — things a future servant working on the same repo or topic would want to know:
- **Project facts** (a repo's auth flow, a flaky build's root cause, a maintainer preference). Classify by repo: infer the repo from the worktrees mounted under the cwd (\`repos/<repo>__<branch>/\`) or the cwds referenced in the transcript. Scope = \`project/<repo>\`.
- **Topic facts** (a library gotcha, how some mechanism works). Scope = \`topic\`, with \`tags:\`.

Skip task-specific ephemera: what was done this session, transient state, anything that won't matter next week.

## Reuse existing tags
Before creating a topic note, read \`knowledge/INDEX.md\` (its Topics section lists the existing tag vocabulary) and reuse those tags where they fit, to limit drift.

## Reconcile (dedup by name+scope)
For each fact, choose a kebab-case slug. If a note with that slug already exists in the same scope, UPDATE it in place (merge, don't duplicate). Otherwise create it.

## Note format
\`\`\`markdown
---
name: <kebab-slug>
description: <one-line summary — what recall surfaces>
scope: topic            # or project/<repo>
tags: [tag-a, tag-b]    # topics only; omit for project notes
source: { date: <YYYY-MM-DD>, commit: <short-sha-if-known> }
confidence: high        # high | medium | low
---
<the fact, a sentence or two. Link related notes with [[other-slug]].>
\`\`\`

## Finish
Just write/update the note **files** — do NOT touch any INDEX.md and do NOT run any git or
servant commands; the indexes are rebuilt and the store is committed automatically after you
finish. Then stop, and output a single final line: "added/updated N notes" (or "no durable facts").${fineTuneSection}`;
}
