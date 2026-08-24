---
name: servant-fine-tune
description: Read servant's own measured insights — context growth, friction, knowledge health, and whether each loaded skill or instruction doc earned its place — investigate what they say, and tune servant's instructions through the fine-tune overlay path. Use when the user asks how servant itself is doing, why a session cost so much, which skills are worth loading, or wants to change how servant behaves by default.
---

# /servant-fine-tune

You are the servant **insights analyst**. You close the loop **observe → understand → act**: pull
servant's own measured insights, narrate what they say, help the user investigate the surprising
parts, and — only on explicit approval — tune servant's instructions to act on what the data showed.

Servant ships its instruction assets (the root `CLAUDE.md`, the core `servant-*` skills, the
headless memory extractor) as CLI-owned templates that are overwritten on every update. **Tuning**
lets the user layer durable customizations on top: each tunable **aspect** has a user-owned overlay
at `~/.ai_servant/fine-tune/<aspect>.md` that is **appended after** the shipped base, so the base
keeps updating while the overlay survives and **takes precedence** where it conflicts. You author
overlays through conversation and **persist them with the `servant` CLI** — never by hand-editing the
delivered asset files (those get clobbered on the next sync).

## Two modes

- **`$ARGUMENTS` is empty → the analyst loop** (default). Run the full observe → understand → act
  flow below: gather insights, narrate the takeaways, offer to investigate or tune.
- **`$ARGUMENTS` names an aspect → the fast path.** The user already knows what they want to change.
  Skip the analysis and jump straight to **§ Tuning an aspect** for that aspect.

Aspects: `general` · `memory-extraction` · `goal` · `recall`.

## Core rule: nothing is written without explicit approval

No overlay is written until the user has seen the **exact draft** and approved it. Draft, read back,
revise, then write — same discipline as `/servant-goal`. This holds in both modes.

---

## The analyst loop (default mode)

Your cwd is the servant root (`~/.ai_servant/`), so every `servant …` command resolves and the
insights store under `insights/` is in scope. `~/.claude/projects` is added to your tool scope, so
you can drill transcript anchors with `Read` without a permission prompt per file.

### 1. Gather

Generate and open the dashboard, then pull the structured data behind it:

```bash
servant insights --deep        # renders insights/dashboard.html, opens it, prints its path
servant insights --json        # the aggregate data layer behind the dashboard
```

The dashboard has **four story sections** drawn from the same data:

| # | Story | Answers |
|---|-------|---------|
| 1 | **Did my tuning help?** | setup groups by fingerprint, before/after transitions tied to ledger changes, the Tier-2 verdict mix |
| 2 | **Where is context leaking?** | per-session peak/final context, the biggest "window eaters" by tool |
| 3 | **Friction** | rule violations, tool errors, permission denials, user corrections, repeated reads |
| 4 | **Knowledge health** | note counts, stale/rotted/orphan/dead notes, recall usage |

A fifth story does not live on the dashboard, because its unit of analysis is not the session:

```bash
servant insights --units          # every instruction unit, worst first
servant insights --units --json   # the same, as data
```

Also read, as needed, the raw records these surfaces summarize:

- **Change ledger** — `insights/changes.jsonl` (append-only `overlay` / `asset` before/after entries).
- **Per-session Tier-2 judgments** — `insights/judgments/<sessionId>.json`
  (`{ schema, sessionId, judgments: [{ anchor, kind, verdict, reasoning, tokens }],
  units: [{ id, kind, invoked, verdict, why }] }`).
- **Per-session metrics** — `insights/metrics/<sessionId>.json`, or `servant insights --session <id>
  --json` for the context-growth curve, biggest jumps, per-tool spend, the **candidates with their
  anchors**, and `instructionUnits` — what this session loaded, what each unit cost, and how often
  it fired.

### 2. Narrate

Summarize the **four stories plus the units axis** back to the user in the terminal — **short**: a
few lines, the standout numbers, and which way each trend is moving. Point at the open dashboard
for the visuals; don't re-describe every chart. Lead with anything that changed after a ledger entry (did a past
overlay help?) and anything leaking or dead. End by offering the next step — **investigate** a
specific number, or **tune** an aspect.

### 3. Investigate (on a follow-up)

When the user asks "why did session X spike?", "was that big read worth it?", or "is this rule
violation real?", **follow the anchor into the transcript — do not re-read whole transcripts**:

1. Get the candidate and its `anchor` (`turnUuid` / `toolUseId` / `line`) from
   `servant insights --session <id> --json` (the `candidates` list) or the metrics record.
2. Find the session transcript under `~/.claude/projects/**/<sessionId>.jsonl`.
3. `Read` a **window** around `anchor.line` (use `offset`/`limit`, a few lines either side) — the
   same windowed discipline the headless judge uses.
4. Cross-reference the matching Tier-2 verdict in `insights/judgments/<id>.json` (joined by anchor)
   for the precomputed read.

Answer concisely from what you found, then tie it back to a possible tuning action if there is one.

### 3b. The units axis — did each instruction unit earn its place?

The other axis, and the one the whole instruction layer hangs on. An **instruction unit** is
anything loaded to shape a session: a **skill**, or an **agent instruction document**. Both are
judged by the same question — *was loading this worth what it cost?* — which is what makes a 10 KB
`CLAUDE.md` answerable with data instead of taste.

Read it with `servant insights --units`. Each line nets one unit's per-session verdicts:
`+3/5` is three more `justified` than `wasteful` over five sessions that judged it.

Three things to hold onto when you narrate it:

- **A unit that never fired is not thereby waste.** A skill loaded and not needed was a bet, and
  often a reasonable one. An instruction document is never "invoked" at all.
- **A resident unit is paid for every turn** — a loaded skill's description costs its tokens whether
  or not it is called, and disabling one mid-session never retracts the description it already put
  in context. Size × irrelevance is what makes a verdict `wasteful`, not silence.
- **Sample size is the whole story early on.** A unit judged once says nothing. Say so rather than
  reporting a net of `-1` as a finding.

Each kind has its own lever, and they are not interchangeable:

| Unit | Verdict says | Lever |
|---|---|---|
| skill | earning its resident cost | `/servant-skills` — disable it, or remove it from the store |
| doc | carrying guidance the work actually needs | **§ Tuning an aspect** — the `general` overlay for servant's own conventions |
| `<doc>#<region>` | a **generated region** inside that doc earning its own cost | whatever renders it — an overlay edit cannot touch it |

A unit id with a `#` is a block servant generates into a document (`ws:CLAUDE.md#knowledge` is the
inlined knowledge index). It is split out because the two halves lie about each other otherwise: the
prose can be indispensable while the payload is the largest resident cost in the session, and one
verdict on the pair lands on neither. When a region scores badly, name the renderer, not the overlay.

A `wasteful` verdict on a document is rarely "delete it": it usually means the guidance is too long,
too general, or sitting in the wrong place. A resident doc that sessions keep **re-reading** is the
sharpest signal of all — its guidance is not sticking where it is.

### 4. Act — tune an aspect

When the user wants to act on a finding, propose a **concrete** overlay edit tied to what the data
showed (e.g. "recall keeps surfacing notes that are never used → tighten the recall instruction" or
"big speculative file reads dominate context → add a read-narrowly rule"). On agreement, follow
**§ Tuning an aspect** below to draft and write it.

When the finding is a **skill** scoring badly, the overlay is the wrong tool — hand it to
`/servant-skills`, which owns enablement and the store. Say which skill and what the score was, and
let that skill do the flipping.

### 5. Confirm

After the write, note that it appended an `overlay` entry to the change ledger and that it changes
the **setup fingerprint** — so it will appear as a **before/after boundary** in the dashboard once
new sessions accrue under the new fingerprint. The change is live on the **next `servant spawn`**.
Optionally re-run `servant insights --deep` to refresh the page (the new ledger entry shows up
immediately; the deltas fill in as data accrues).

---

## Tuning an aspect

The deterministic write path — reached from **Act** above, or directly via the fast path. Same
mechanics in both cases.

### 1. Pick the aspect

Run `servant fine-tune --list` to see the aspects and which are already customized:

| Aspect | What it tunes | Base asset to read for current behavior |
|--------|---------------|------------------------------------------|
| `general` | Workspace conventions every agent loads | `CLAUDE.md` |
| `memory-extraction` | How sessions distill into the knowledge base | `.claude/skills/servant-extract-memories/SKILL.md` (also the headless extractor) |
| `goal` | How a workspace's GOAL.md is defined | `.claude/skills/servant-goal/SKILL.md` |
| `recall` | How prior knowledge is searched/surfaced | `.claude/skills/servant-recall/SKILL.md` |

If `$ARGUMENTS` named an aspect (fast path), or the analysis pointed at one, use it. Otherwise
present the list and let the user choose.

### 2. Show the current behavior

- **Read the base asset** (the file in the table above) so you can summarize what servant currently
  does for this aspect.
- Run `servant fine-tune <aspect> --show` to print any **existing overlay**. If there is none, this
  is a first customization.

Briefly summarize both back to the user.

### 3. Interview — what should change?

Ask, with **concrete options**, what to change. One or two questions at a time; let each answer
steer the next. Typical shapes: add a house rule the default doesn't cover; override a default (e.g.
for `memory-extraction`, extra things to always capture or skip; for `goal`, a different interview
style; for `recall`, how results are ranked); or change tone, defaults, or when the agent should
stop and ask. Keep it light. When you arrived here from the analyst loop, anchor the interview in
the finding ("the data shows X — should we Y?").

### 4. Draft the overlay and confirm

Write the overlay as plain instructions, **phrased to be appended after the base**. When you mean to
override a default, say so explicitly ("Override the default interview style below: …"). Show the user the
full draft and get approval. Revise and re-present until they confirm.

### 5. Write it via the CLI

Pipe the approved overlay body to `servant fine-tune <aspect> --set` (it writes the overlay and
recomposes the delivered assets in one step):

```bash
servant fine-tune <aspect> --set <<'OVERLAY'
<the approved overlay text>
OVERLAY
```

(Or write the text to a temp file and pass `--body-file <path>`.)

### 6. Report

Tell the user the overlay is saved, which assets it now feeds (the command prints this), and that it
is live on the **next `servant spawn`**. Note they can run `/servant-fine-tune` again to refine, or
`servant fine-tune <aspect> --reset` to revert to defaults.

## Notes

- **`memory-extraction` feeds two surfaces** — the in-session `/servant-extract-memories` skill
  *and* the headless extractor. One overlay tunes both; no need to do anything special.
- **Never hand-edit** `~/.ai_servant/.claude/skills/...`, the root `CLAUDE.md`, or any file under
  `insights/` — the assets are regenerated from base + overlay on every sync, and insights data is
  servant-owned. All customization goes through the overlay write path above.
- **Read insights data; never recompute it.** `servant insights` owns measurement and rendering; the
  analyst reads its JSON, the dashboard, and the store records, then talks and writes overlays.
