// Config files the mattpocock engineering skills read as prose (to-tickets, to-spec, triage,
// wayfinder). Normally written by `/setup-matt-pocock-skills` per repo; servant pre-writes them
// per workspace instead, because a workspace root isn't a git clone (so the skills can't
// auto-detect a tracker) and because we point every workspace at the shared majordomo hub rather
// than each worked repo's own Issues. The seam is entirely prose: pinning every `gh` op to
// `--repo <hub>` and every created issue to `--label ws:<workspace>` overrides the stock GitHub
// template's "infer the repo from git remote -v".

export const AGENT_SKILLS_MARKER = "<!-- servant:agent-skills -->";

/** The hub-pinned GitHub issue-tracker convention doc (docs/agents/issue-tracker.md). */
export function renderIssueTrackerDoc(workspace: string, hubRepo: string): string {
  const wsLabel = `ws:${workspace}`;
  return `# Issue tracker: GitHub (servant hub)

Issues and specs for this workspace live in the shared **servant hub** repo \`${hubRepo}\` —
one cross-workspace tracker, navigable via \`servant tasks\`, the GitHub Project board, and the
per-workspace label. **Every \`gh\` operation is pinned to \`--repo ${hubRepo}\`** (the workspace
root is not a clone of the hub, so \`gh\` cannot infer it). This workspace's issues carry the
label \`${wsLabel}\`.

## Before creating any issue

Ensure this workspace's label exists (idempotent):

\`\`\`
gh label create ${wsLabel} --repo ${hubRepo} --force --description "servant workspace ${workspace}"
\`\`\`

## Conventions

- **Create an issue**: \`gh issue create --repo ${hubRepo} --label ${wsLabel} --title "..." --body "..."\`
  (heredoc for multi-line bodies). Add \`spec\` / \`ticket\` and any triage label as additional \`--label\`s.
- **Read an issue**: \`gh issue view <number> --repo ${hubRepo} --comments\`.
- **List this workspace's issues**: \`gh issue list --repo ${hubRepo} --label ${wsLabel} --state open --json number,title,body,labels,comments\`.
- **Comment**: \`gh issue comment <number> --repo ${hubRepo} --body "..."\`.
- **Apply / remove labels**: \`gh issue edit <number> --repo ${hubRepo} --add-label "..."\` / \`--remove-label "..."\`.
- **Close**: \`gh issue close <number> --repo ${hubRepo} --comment "..."\`.

Never omit \`--repo ${hubRepo}\`; never omit \`--label ${wsLabel}\` when creating.

## When a skill says "publish to the issue tracker"

Create a GitHub issue in \`${hubRepo}\` labeled \`${wsLabel}\` (a spec also gets \`spec\`; a ticket also gets \`ticket\`).

## When a skill says "fetch the relevant ticket"

Run \`gh issue view <number> --repo ${hubRepo} --comments\`.

## Wayfinding operations (used by /wayfinder)

The **map** is a single issue with **child** issues as tickets — all in \`${hubRepo}\`, all labeled \`${wsLabel}\`.

- **Map**: \`gh issue create --repo ${hubRepo} --label ${wsLabel} --label wayfinder:map\` holding the Notes / Decisions-so-far / Fog body.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (\`gh api\` on the sub-issues endpoint), labeled \`${wsLabel}\` + \`wayfinder:<type>\` (\`research\`/\`prototype\`/\`grilling\`/\`task\`). Where sub-issues aren't enabled, add \`Part of #<map>\` at the top of the child body.
- **Blocking**: GitHub native issue dependencies — \`gh api --method POST repos/${hubRepo}/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>\` (blocker's numeric database id from \`gh api repos/${hubRepo}/issues/<n> --jq .id\`). Fall back to a \`Blocked by: #<n>\` line when unavailable.
- **Frontier query**: list the map's open children, drop any with an open blocker or an assignee; first in map order wins.
- **Claim**: \`gh issue edit <n> --repo ${hubRepo} --add-assignee @me\`.
- **Resolve**: \`gh issue comment <n> --repo ${hubRepo} --body "<answer>"\`, then \`gh issue close <n> --repo ${hubRepo}\`, then append a context pointer to the map's Decisions-so-far.
`;
}

/** Domain-doc consumer rules (docs/agents/domain.md) — servant adopts CONTEXT.md + docs/adr/. */
export function renderDomainDoc(): string {
  return `# Domain Docs

How the engineering skills should consume this workspace's domain documentation when exploring.

## Before exploring, read these

- **\`CONTEXT.md\`** at the workspace root — the shared language / domain glossary.
- **\`docs/adr/\`** — read ADRs that touch the area you're about to work in.

If any of these don't exist yet, **proceed silently**. The \`/domain-modeling\` skill (reached via
\`/grill-with-docs\` and \`/improve-codebase-architecture\`) creates them lazily when terms or
decisions actually get resolved.

## File structure

\`\`\`
<workspace>/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-<slug>.md
│   └── 0002-<slug>.md
└── repos/            ← mounted repo worktrees
\`\`\`

## Use the glossary's vocabulary

When your output names a domain concept (an issue title, a refactor proposal, a hypothesis, a test
name), use the term as defined in \`CONTEXT.md\`. If the concept isn't in the glossary yet, that's a
signal — either you're inventing language the project doesn't use (reconsider) or there's a real
gap (note it for \`/domain-modeling\`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
`;
}

/** Triage label mapping (docs/agents/triage-labels.md) — the five canonical defaults. */
export function renderTriageLabelsDoc(): string {
  return `# Triage Labels

The skills speak in terms of five canonical triage roles. This table maps those roles to the label
strings used in the servant hub. The label strings equal their canonical names (defaults).

| Label in mattpocock/skills | Label in the hub  | Meaning                                  |
| -------------------------- | ----------------- | ---------------------------------------- |
| \`needs-triage\`             | \`needs-triage\`    | Needs evaluation                         |
| \`needs-info\`               | \`needs-info\`      | Waiting on more information              |
| \`ready-for-agent\`          | \`ready-for-agent\` | Fully specified, ready for an AFK agent  |
| \`ready-for-human\`          | \`ready-for-human\` | Requires human implementation            |
| \`wontfix\`                  | \`wontfix\`         | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding
label string from this table. Ensure a label exists before applying it:
\`gh label create <label> --repo <hub> --force\`.
`;
}

/**
 * The `## Agent skills` block injected into the workspace CLAUDE.md so the skills know where their
 * config lives. Wrapped in AGENT_SKILLS_MARKER for idempotent re-generation.
 */
export function renderAgentSkillsBlock(workspace: string, hubRepo: string): string {
  return `${AGENT_SKILLS_MARKER}
## Agent skills

The mattpocock engineering skills are installed (plugin \`mattpocock-skills\`). Their per-workspace
config lives under \`docs/agents/\` — read the relevant file when a skill needs it.

### Issue tracker

Issues live in the shared servant hub \`${hubRepo}\`, labeled \`ws:${workspace}\`. See
\`docs/agents/issue-tracker.md\` — every \`gh\` op is pinned to \`--repo ${hubRepo}\`.

### Triage labels

The five canonical triage labels (defaults). See \`docs/agents/triage-labels.md\`.

### Domain docs

Single-context: \`CONTEXT.md\` + \`docs/adr/\`. See \`docs/agents/domain.md\`.
`;
}
