---
description: Interview the user to customize a servant instruction aspect, then write the overlay via the servant CLI.
argument-hint: [aspect]
---

# /servant:fine-tune

Help the user **fine-tune** servant's own instructions. Servant ships its instruction assets
(the root `CLAUDE.md`, the `/servant:*` slash commands, the headless memory extractor) as
CLI-owned templates that are overwritten on every update. Fine-tuning lets the user layer
durable customizations on top: each tunable **aspect** has a user-owned overlay file at
`~/.ai_servant/fine-tune/<aspect>.md` that is **appended after** the shipped base, so the base
keeps updating while the overlay survives. Overlay text **takes precedence** over the defaults
where it conflicts — by plain language ("Override the default below: …").

You author the overlay through conversation; you **persist it with the `servant` CLI** (never by
hand-editing the delivered asset files — those get clobbered on the next sync).

`$ARGUMENTS` may name the aspect to tune. If empty, help the user pick one.

## Core rule: nothing is written without explicit approval

The overlay only changes after the user has seen the **exact draft** and approved it. Draft,
read back, revise, then write — same discipline as `/servant:goal`.

## Process

### 1. Pick the aspect

Run `servant fine-tune --list` to see the aspects and which are already customized:

| Aspect | What it tunes | Base asset to read for current behavior |
|--------|---------------|------------------------------------------|
| `general` | Workspace conventions every agent loads | `CLAUDE.md` |
| `memory-extraction` | How sessions distill into the knowledge base | `.claude/commands/servant/extract-memories.md` (also the headless extractor) |
| `delegate` | How work is handed off as Agent Briefs | `.claude/commands/servant/delegate.md` |
| `goal` | How a workspace's GOAL.md is defined | `.claude/commands/servant/goal.md` |
| `recall` | How prior knowledge is searched/surfaced | `.claude/commands/servant/recall.md` |

If `$ARGUMENTS` named an aspect, use it. Otherwise present the list and let the user choose one.

### 2. Show the current behavior

Your cwd is the servant root (`~/.ai_servant/`). For the chosen aspect:

- **Read the base asset** (the file in the table above) so you can summarize for the user what
  servant currently does for this aspect.
- Run `servant fine-tune <aspect> --show` to print any **existing overlay** (their current
  customization). If there is none, this is a first customization.

Briefly summarize both back to the user.

### 3. Interview — what should change?

Ask, with **concrete options**, what the user wants to change about this aspect. One or two
questions at a time; let each answer steer the next. Typical shapes:

- Add a house rule the default doesn't cover.
- Override a default (e.g. for `delegate`, a different brief template; for `memory-extraction`,
  extra things to always capture or always skip; for `goal`, a different interview style).
- Change tone, defaults, or when the agent should stop and ask.

Keep it light — a handful of exchanges, not an interrogation.

### 4. Draft the overlay and confirm

Write the overlay as plain instructions, **phrased to be appended after the base**. When you mean
to override a default, say so explicitly ("Override the brief template below: …"). Show the user
the full draft and get approval. Revise and re-present until they confirm.

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

Tell the user the overlay is saved, which assets it now feeds (the command prints this), and that
it is live on the **next `servant spawn`**. Note they can run `/servant:fine-tune` again to refine,
or `servant fine-tune <aspect> --reset` to revert to defaults.

## Notes

- **`memory-extraction` feeds two surfaces** — the in-session `/servant:extract-memories` command
  *and* the headless extractor. One overlay tunes both; no need to do anything special.
- **Never hand-edit** `~/.ai_servant/.claude/commands/...` or the root `CLAUDE.md` directly — they
  are regenerated from base + overlay on every sync. All customization goes through the overlay.
