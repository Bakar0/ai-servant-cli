import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
// Two template locations feed it, because servant's core units are mid-migration from slash
// commands to skills (servant-skill-rework#4): whichever a unit currently is, Codex keeps its
// prompt. A skill wins over a command of the same id, so a half-converted set never serves the
// stale copy — and never leaves a gap where `/servant-<cmd>` simply vanishes.
const CLAUDE_COMMANDS_PREFIX = "servant_root/.claude/commands/servant/";
const CORE_SKILLS_PREFIX = "servant_root/.claude/skills/";

/** Turn a bundled Claude command body into its Codex-prompt equivalent. */
export function toCodexPrompt(body: string): string {
  return body
    .replaceAll("/servant:", "/servant-")
    .replaceAll("~/.claude/projects", "~/.codex/sessions");
}

/**
 * Install servant's slash-command prompts into `~/.codex/prompts/` so a Codex session gets
 * `/servant-goal`, `/servant-handoff`, etc. Derived from the bundled Claude command templates via
 * {@link toCodexPrompt}. Overwrites only on content change; idempotent and cheap to run per spawn.
 */
export async function ensureCodexAssets(): Promise<void> {
  const dir = codexPromptsDir();
  for (const [commandId, body] of codexPromptBodies()) {
    const dest = join(dir, codexAgent.prompts.filename(commandId));
    const desired = toCodexPrompt(body);
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
}

/**
 * The prompt body for each core unit, keyed by the id its Codex filename is built from.
 *
 * Insertion order matters: commands first, then skills, so a converted unit's skill body replaces
 * the command body it grew out of.
 */
export function codexPromptBodies(): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const t of TEMPLATES) {
    if (!t.rel.startsWith(CLAUDE_COMMANDS_PREFIX) || !t.rel.endsWith(".md")) continue;
    bodies.set(basename(t.rel, ".md"), t.content);
  }
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
