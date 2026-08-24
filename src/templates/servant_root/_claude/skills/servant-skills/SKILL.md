---
name: servant-skills
description: Manage the skills installed under the servant root — read what a source offers, install and enable what earns its place, and notice when upstream moved. Use when the user asks what skills are installed, wants one added, removed from a session, or asks which skill to use for a job.
---

# /servant-skills

The `servant skills` CLI is a **noun with no judgment**: it never parses a skill, never knows a
name, and owns no source list. That is deliberate — skills are data servant manages, not behavior
it knows. This skill is where the judgment lives instead.

If `$ARGUMENTS` names a source, a skill, or a job to find a skill for, start there. Otherwise read
what is installed (`servant skills list`) and ask what the user is after.

## The line, before anything else

**Never put a skill's name in `src/`.** Not in a default, not in a list, not in a "for convenience"
constant. Every name — every source, every recommendation, every quirk of one particular skill —
belongs in this prose, which is why this prose exists. If a change seems to need the CLI to know a
name, that is the signal to stop and say so, not to add it.

## The whole contract with the CLI

| Command | What it is for |
|---|---|
| `servant skills catalog <source>` | Read what a source offers — name, stated purpose, and which siblings each one points at — installing nothing. |
| `servant skills install <source> --skill <name>` | Take one (repeatable, comma-separable). `--enable` in the same breath. `--all` takes everything the source has. |
| `servant skills enable <name>` · `servant skills disable <name>` | Whether Claude loads it. Enable copies out of the store; disable deletes the copy and keeps the record. |
| `servant skills check` | Ask every source whether it moved, **and whether the copy Claude loads is still the store's bytes**. Detects; never applies. |
| `servant skills list [--json]` | State, source, name, score, and the last `check` verdict — **plus a `FOREIGN` section** for what a session can reach that the store does not own. Offline and instant: it reads a cache, never the network. |
| `servant skills` | The picker: browse, preview each `SKILL.md`, flip enablement on the rows you mark. |

`--force` exists on `install` alone, and **only ever with the user saying so** — see *Drift* below.
There is no `remove`: `disable` is how a skill stops loading, and the store entry it leaves behind
is a few kilobytes of Markdown plus a recorded hash. Keeping it is what makes re-enabling free and
`check` able to answer for it.

## Known sources

A convenience list, not a marketplace. **Extending it means editing this file** — that is the whole
mechanism, and it is why no source is registered anywhere in the CLI. A source is any git repo with
`SKILL.md` files in it: `owner/repo`, a URL, or a local path.

| Source | Roughly | What it is good for |
|---|---|---|
| `anthropics/skills` | 20 skills | Claude's own: document formats (`docx`, `pdf`, `pptx`, `xlsx`), artifact and frontend design, `mcp-builder`, `skill-creator`, `claude-api`. |
| `mattpocock/skills` | 36 skills, in `skills/<area>/<name>` | The engineering flow: `to-spec`, `to-tickets`, `implement`, `code-review`, `tdd`, `grilling`, `handoff`, `research`, `domain-modeling`, `wayfinder`. |
| `cursor/plugins` | 79 skills across 13 plugins | A monorepo of plugins, one directory each. **pstack** is the interesting one — 44 skills at `pstack/skills/<name>`, including `unslop`, `architect`, `interrogate`, `blast-radius`, and a long `principle-*` set. |
| `obra/superpowers` | 14 skills | Process discipline: `brainstorming`, `writing-plans`, `executing-plans`, `systematic-debugging`, `verification-before-completion`, `using-git-worktrees`. |

## The four the board leans on are catalog entries, not ours

`to-spec`, `to-tickets`, `implement` and `code-review` from `mattpocock/skills` are entries in the
table above, exactly like `tdd` and `grilling`. **Servant does not own how tickets get made** — that
was decided deliberately, because maintaining our own `to-tickets` trades "servant depends on a
plugin" for something worse, and it takes away the ability to use anyone else's.

What makes a foreign task-shaping skill work here is the board's **public contract**: the workspace's
`docs/agents/*` say how to file, label, block, claim, comment and close on this board, written for a
skill that has never seen servant.

So: several of those skills' prose points at a `setup-*` skill that would write its own tracker
config. **Do not install or run it.** Servant already publishes that contract, and a second writer
of the same docs is how the two come to disagree. If an installed skill cannot find what it needs,
the fix is what servant renders into `docs/agents/`, not a setup skill.

## Holding the conversation

1. **`catalog` first.** Never install to look — cloning to read and cloning to keep are different
   acts, and the first one leaves nothing behind.
2. **Read the `[mentions: …]` column.** It reports the siblings a skill's own prose points at, and
   only those the same source actually offers. A skill that leans on three others is a decision to
   put to the user, not three more installs.
3. **Install by name, a few at a time.** `--all` on a 79-skill source is almost never what someone
   means.
4. **Enable less than you install.** An enabled skill's `description` is loaded into *every* servant
   session whether or not it is ever invoked, so enablement is a standing context cost. Disabling
   stops invocation immediately but does **not** retract a description already in a running
   session's context — that ends at the next session, not at the command.
5. **Report the hash you landed on.** It is the only answer to "which version is this?", and it is
   what `check` will compare against later.

A newly enabled skill is announced to a running session at the **next turn boundary** — so it is
usable in this conversation, just not in this turn.

## The store is not the only thing a session loads

`list` ends with a **`FOREIGN`** section: every skill a session can invoke that the store did not
install. Two places they come from, and servant manages neither:

- **an enabled plugin** — read from Claude Code's own install records, so a stale cached copy nothing
  points at is not reported. A plugin's skills are namespaced, so the invocation is
  `<plugin>:<name>`.
- **`~/.claude/skills/`** — the user's hand-installed directory.

This section exists because the listing above it used to be presented as the account of what a
session can invoke while reading only the store. That gap is not academic: it is how seven skills
came to be loaded twice at two different versions, and thirteen never-once-invoked ones sat resident
across 394 sessions, with no servant surface saying so. It took a bespoke audit to find.

**Reachable is not model-visible, and the section reports both.** `MODEL? no` means the skill carries
`disable-model-invocation`, so the agent is never shown it: `/`-invocable only, zero resident tokens.
Quote the model-visible count and its `~tok resident` when the question is what a session *pays* —
conflating the two overstates it by more than double on a large plugin, which is the same direction
the store-only listing was already wrong in.

**`COLLIDES WITH` is the finding, not a footnote.** A foreign skill sharing a **bare name** with a
store skill means a session is offered both, with near-identical descriptions, and picks. Measured on
one plugin here: the namespaced twins took **81** invocations to the store copies' **5**. So a
collision quietly decides which bytes run. Two halves to settling one, and only the first is yours:

- servant's side — `servant skills disable <name>`, if the store's copy is the loser.
- the foreign side — **the user's action, always.** Servant writes nothing outside
  `~/.ai_servant/` (ADR-0002). Say where the copy is and what would remove it; do not remove it.

Two things this section cannot see, worth saying out loud rather than implying otherwise: Claude
Code's own per-skill `/skills` toggle (its stored shape is undocumented, and guessing would put this
surface back to being confidently wrong), and a plugin enabled only for some other project. A plugin
absent from the settings map reads as **on** — that is how an org-managed plugin arrives, and a
managed one is policy, not the user's to disable.

## One name, one skill

- **Two sources, same name** — both install side by side and the listing marks them `(contested)`.
  A bare name is then refused, naming both; enable with `<source>/<name>`. Enabling one swaps the
  other out, because they would materialize into the same directory.
- **One source, same name twice** — real in the wild (`cursor/plugins` ships two
  `pr-review-canvas`). Here a bare `--skill <name>` silently picks one of them, and installing the
  other *replaces* it in the store rather than joining it: the output reads like an update, not a
  collision. **Use the full path as the selector** — `--skill cursor-team-kit/skills/pr-review-canvas`
  — whenever `catalog` shows a name twice.
- **Core names are reserved.** A source shipping one is refused at install and again at enable, by
  name, before anything is written — a materialized copy would land on top of the core skill and
  destroy it. The `servant-` prefix is what keeps this rare: `cursor/plugins` ships a `recall`, and
  it sits happily beside core `servant-recall`.

## Drift: what `check` and `list` are telling you

Drift compares the **store copy** against the hash recorded when it was installed. It is a
different question from whether upstream moved, and from whether the copy Claude loads still matches
the store — all three are reported side by side
(`store modified · loaded copy edited · moved → 4dd61e72fcb8`).

| State | What happened | What to do |
|---|---|---|
| `clean` | The store copy is byte-for-byte what was installed. | Nothing. |
| `modified` | Somebody adapted this skill after installing it. | **Protect it.** This is work someone did on purpose, which is exactly why `install` refuses to overwrite it without `--force`. |
| `missing` | The store directory is gone, and the record survives it. | The skill may still be *loaded* from its enabled copy while being unreinstallable through `enable` — reinstall it from its source. |

`modified` is not damage and never reads as a repair job. Taking upstream's version means
**discarding** the adaptation, so `--force` needs the user to have said so in words that mean it.
Offer to save the local version first — a `git diff`-able copy, or an ADR if it turned out to be a
decision.

### The other drift: the copy Claude actually loads

`enable` copies the store directory to where Claude loads it, so there are two copies and they can
disagree. That second question is now reported in its own right — in the `UPDATE?` column, in
`check`, and as `enabledCopy` in `--json`:

| Says | What happened | What to do |
|---|---|---|
| `loaded copy edited` | Somebody edited the copy Claude loads, not the store. **It is what shapes every session, and nothing else records it.** | Salvage anything worth keeping into the store copy first, then `servant skills enable <name>` — which discards the edit. |
| `loaded copy gone` | Recorded as enabled with nothing loaded. | Any `list`, `enable` or `disable` re-materializes it. |
| `loaded copy left behind` | Recorded as off, but a copy is still there **and still loading**. | `servant skills disable <name>` clears it. |

Editing the store copy of an already-enabled skill does **not** reach the session until you `enable`
again. Editing the loaded copy directly still loses the work on the next enable or install — the
difference is that it is no longer silent. **Edit the store, then re-enable.**

`check` never applies what it finds (ADR-0001: an instruction set that changes underneath a session
without a recorded transition is not something the evaluator can score honestly). Reaching a new
version is always an explicit reinstall, and `check` prints the exact command per outdated skill.

## Core skills

The set that ships inside the binary — this one included. They are listed and scored like any
other, and **never disableable and never removable**: their only copy on disk is the one servant
writes, and it is rewritten from the binary whenever it drifts. A hand-edit of a core skill is
therefore temporary. The supported way to change one is the fine-tune overlay
(`/servant-fine-tune`), which is composed in *after* the shipped body and survives every update.

## Not this skill's job

- **Scoring.** The `SCORE` column is *reported* here, never decided here. It nets the session
  evaluator's per-session verdicts on this skill as an instruction unit (`+1/3` = one more
  `justified` than `wasteful`, over three sessions that judged it). Do not guess a score, do not
  compute one, and do not describe a skill as earning or wasting its place on your own read of it.
  `servant insights --units` is the full picture, instruction docs included; `/servant-fine-tune` is
  where a score turns into a decision.
- **Two ways to have no score, and they mean opposite things.** `—` is *not yet* — no session has
  judged it, and one eventually will. **`n/a` is never**: the skill's frontmatter carries
  `disable-model-invocation`, so the agent is never shown it and no session can score it. That is not
  a gap to fix. It is `/`-invocable only and costs **zero resident tokens**, which is arguably the
  right shape for a skill a human triggers deliberately — say that rather than treating it as
  unmeasured.
- **Claude Code's own `/skills` toggle** (`skillOverrides` in settings). Servant's enablement is the
  one mechanism; writing both is how two records of one state come to disagree.
- **Removing anything foreign.** `list` now *reports* what a plugin or `~/.claude/skills/` puts in a
  session, and reporting is the whole intervention. The user's hand-installed skills are theirs, and
  servant enables into `~/.ai_servant/.claude/skills/` and never writes outside it (ADR-0002) — so a
  skill wanted everywhere, not just in servant work, is a deliberate install there that servant does
  not manage. Name the collision, name the directory, and leave the keystroke to the user.
