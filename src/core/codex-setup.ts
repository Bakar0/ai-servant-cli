import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { codexAgent } from "../agents/codex.ts";
import { TEMPLATES } from "../templates/index.generated.ts";
import { codexPromptsDir } from "./paths.ts";
import { CORE_SKILL_PREFIX, SKILL_FILE } from "./skills.ts";

// Codex has no skills mechanism, so servant's core instruction units reach it as *prompts*. The
// bundled Claude templates are the single source of truth for both — the bodies are agent-agnostic
// natural language and both CLIs share the `$ARGUMENTS` / front-matter conventions. We transform
// rather than fork:
//   1. `/servant:<cmd>` → `/servant-<cmd>` — Codex prompts are flat and have no `:` namespace.
//   2. `~/.claude/projects` → `~/.codex/sessions` — Codex writes its session logs elsewhere.
//
// One template location feeds it: the core skills. The union with `.claude/commands/servant/` that
// carried the migration (servant-skill-rework#4) is gone with the last command
// (servant-skill-rework#8) — a loop over a prefix that matches nothing is not a seam, it is a claim
// that a finished migration is still running. If servant ever ships a slash command again — the one
// real reason being `disable-model-invocation`, which skills have no equivalent for — reinstating
// the union is a few lines, and the test pinning "skills only" is what makes that deliberate.
const CORE_SKILLS_PREFIX = "servant_root/.claude/skills/";

// `~/.codex/prompts/` is the user's directory, flat and shared with their own prompts, so servant
// cannot claim it by containment the way ADR-0002 claims the skills directory. It claims individual
// files instead: every prompt servant writes carries this marker, so "servant wrote this" is a fact
// recorded in the artifact rather than a guess from its name. A file without the marker is the
// user's, whatever it is called — including a `servant-`prefixed name servant does not ship.
const OWNERSHIP_MARKER =
  "<!-- servant:codex-prompt — written by `servant` from its bundled templates. Hand edits are" +
  " overwritten, and this file is deleted when servant stops shipping the unit it came from. -->";

// The prompt ids servant shipped before the marker existed. Their files carry no marker, so the
// sweep cannot recognize them — but servant is provably their author: it wrote these exact
// filenames on every Codex spawn, so a user's file could never have survived at one of them.
// Closed by construction: a unit retired from here on is swept by its marker, so nothing is ever
// added to this list. `delegate` is inert while servant ships a unit of that name again
// (servant-skill-rework#8) — it stays because the list records what predates the marker, not what
// is currently retired.
const PRE_MARKER_PROMPT_IDS = [
  "delegate",
  "extract-memories",
  "fine-tune",
  "goal",
  "handoff",
  "lead",
  "recall",
];

/** Turn a bundled core-skill body into its Codex-prompt equivalent. */
export function toCodexPrompt(body: string): string {
  return body
    .replaceAll("/servant:", "/servant-")
    .replaceAll("~/.claude/projects", "~/.codex/sessions");
}

/**
 * Install servant's core instruction units into `~/.codex/prompts/` so a Codex session gets
 * `/servant-goal`, `/servant-delegate`, etc. Derived from the bundled core-skill templates via
 * {@link toCodexPrompt}. Overwrites only on content change; idempotent and cheap to run per spawn.
 *
 * Retired units are swept afterwards — see {@link sweepRetiredCodexPrompts}.
 */
export async function ensureCodexAssets(): Promise<void> {
  const dir = codexPromptsDir();
  const desiredNames = new Set<string>();
  for (const [commandId, body] of codexPromptBodies()) {
    const name = codexAgent.prompts.filename(commandId);
    desiredNames.add(name);
    const dest = join(dir, name);
    const desired = withOwnershipMarker(toCodexPrompt(body));
    let existing: string | null = null;
    try {
      existing = await readFile(dest, "utf8");
    } catch {
      // missing — will write
    }
    if (existing === desired) continue;
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, desired);
  }
  await sweepRetiredCodexPrompts(dir, desiredNames);
}

/** Stamp servant's ownership onto a prompt body. Applied after {@link toCodexPrompt}, never before. */
export function withOwnershipMarker(body: string): string {
  return `${body.trimEnd()}\n\n${OWNERSHIP_MARKER}\n`;
}

/**
 * Delete the prompts of units servant no longer ships. Retirement is *derived* — a prompt goes
 * because {@link codexPromptBodies} stopped producing its id, not because someone remembered to add
 * it to a list — which is the one thing a list cannot guarantee.
 *
 * The safety is ownership, not naming: a file is only deleted if servant can prove it wrote it,
 * either by the marker in its body or by its name being one of the {@link PRE_MARKER_PROMPT_IDS}
 * servant shipped before markers existed. Everything else in the directory is the user's.
 */
export async function sweepRetiredCodexPrompts(
  dir: string,
  desiredNames: ReadonlySet<string>,
): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // no prompts directory yet — nothing to sweep
  }
  const preMarkerNames = new Set(
    PRE_MARKER_PROMPT_IDS.map((id) => codexAgent.prompts.filename(id)),
  );
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (desiredNames.has(entry.name)) continue;
    const path = join(dir, entry.name);
    const ours =
      preMarkerNames.has(entry.name) ||
      (await readFile(path, "utf8").catch(() => "")).includes(OWNERSHIP_MARKER);
    if (!ours) continue;
    await rm(path, { force: true });
    removed.push(entry.name);
  }
  return removed;
}

/** The prompt body for each core skill, keyed by the id its Codex filename is built from. */
export function codexPromptBodies(): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const t of TEMPLATES) {
    if (!t.rel.startsWith(CORE_SKILLS_PREFIX) || !t.rel.endsWith(`/${SKILL_FILE}`)) continue;
    const dirName = t.rel.slice(CORE_SKILLS_PREFIX.length).split("/")[0];
    if (!dirName) continue;
    // The skill directory already carries the `servant-` prefix, and so does the Codex filename —
    // strip it here so the prompt is `servant-recall.md`, not `servant-servant-recall.md`.
    const commandId = dirName.startsWith(CORE_SKILL_PREFIX)
      ? dirName.slice(CORE_SKILL_PREFIX.length)
      : dirName;
    bodies.set(commandId, t.content);
  }
  return bodies;
}
