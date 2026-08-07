import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { codexAgent } from "../agents/codex.ts";
import { TEMPLATES } from "../templates/index.generated.ts";
import { codexPromptsDir } from "./paths.ts";

// The bundled Claude slash-command templates double as the single source of truth for the Codex
// prompts — the bodies are agent-agnostic natural language and both CLIs share the `$ARGUMENTS` /
// front-matter (`description`, `argument-hint`) conventions. We transform rather than fork:
//   1. `/servant:<cmd>` → `/servant-<cmd>` — Codex prompts are flat and have no `:` namespace.
//   2. `~/.claude/projects` → `~/.codex/sessions` — Codex writes its session logs elsewhere.
const CLAUDE_COMMANDS_PREFIX = "servant_root/.claude/commands/servant/";

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
  const commands = TEMPLATES.filter(
    (t) => t.rel.startsWith(CLAUDE_COMMANDS_PREFIX) && t.rel.endsWith(".md"),
  );
  for (const src of commands) {
    const commandId = basename(src.rel, ".md");
    const dest = join(dir, codexAgent.prompts.filename(commandId));
    const desired = toCodexPrompt(src.content);
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
