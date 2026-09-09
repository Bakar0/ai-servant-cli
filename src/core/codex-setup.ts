import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { codexAgent } from "../agents/codex.ts";
import { TEMPLATES } from "../templates/index.generated.ts";
import { composeAssetForRel } from "./fine-tune.ts";
import { aiServantRoot, codexPromptsDir } from "./paths.ts";
import { shellSingleQuote } from "./shell.ts";

// The bundled Claude slash-command templates double as the single source of truth for the Codex
// prompts — the bodies are agent-agnostic natural language and both CLIs share the `$ARGUMENTS` /
// front-matter (`description`, `argument-hint`) conventions. We transform rather than fork:
//   1. `/servant:<cmd>` -> `/prompts:servant-<cmd>` — Codex prompts are flat and have no `:` namespace.
//   2. `~/.claude/projects` → `~/.codex/sessions` — Codex writes its session logs elsewhere.
const CLAUDE_COMMANDS_PREFIX = "servant_root/.claude/commands/servant/";

/** Turn a bundled Claude command body into its Codex-prompt equivalent. */
export function toCodexPrompt(body: string): string {
  return toCodexInstructions(body).replace(/(?<!\$)\$(?!ARGUMENTS\b|[1-9]\b|\$)/g, "$$$$");
}

/** Shared workflows rendered for Codex prompts and AGENTS.md. */
export function toCodexInstructions(body: string): string {
  return body
    .replaceAll("/servant:", "/prompts:servant-")
    .replaceAll("~/.claude/projects", "~/.codex/sessions")
    .replaceAll("CLAUDE.md", "AGENTS.md")
    .replaceAll("the `Agent` tool", "the available Codex subagent tools")
    .replaceAll(
      "installed as the `mattpocock-skills` plugin",
      "available when installed separately for Codex",
    )
    .replaceAll(
      "The mattpocock engineering skills are installed (plugin `mattpocock-skills`).",
      "Use the mattpocock engineering skills when installed for Codex. A Claude plugin installation does not install Codex skills.",
    )
    .replaceAll("imports it", "includes a snapshot of it; read GOAL.md for its current contents")
    .replace(
      /## 4\. Redirect from here[\s\S]*?(?=## Notes)/,
      "## 4. Continue from here\n\nServant does not currently provide named live-session tracking or cross-session steering for Codex. Report liveness as unknown, and do not redirect a session or reclaim its claim based on absence from Claude's registry. The user can continue in the worker's tab or resume a known Codex session id. Use /prompts:servant-handoff for unclaimed, ready work.\n\n",
    )
    .replace(
      /\/(grill-me|to-spec|to-tickets|implement|tdd|code-review|handoff|teach|wait-what|domain-modeling|research|wayfinder|grill-with-docs|improve-codebase-architecture)\b/g,
      "$$$1",
    );
}

/**
 * Install servant's slash-command prompts into `~/.codex/prompts/` so a Codex session gets
 * `/prompts:servant-goal`, `/prompts:servant-handoff`, etc. Derived from the bundled Claude command templates via
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
    const composed = await composeAssetForRel(src.rel.slice("servant_root/".length), src.content);
    const desired = toCodexPrompt(composed);
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

/** Merge workspace hooks without changing Codex config or bypassing its hook trust review. */
export async function ensureCodexHooks(workspaceDir: string): Promise<void> {
  const path = join(workspaceDir, ".codex", "hooks.json");
  let existing: string | null = null;
  try {
    existing = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const parsed: unknown = existing === null ? {} : JSON.parse(existing);
  const settings = parsed as Record<string, unknown>;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error(`Invalid Codex hooks object at ${path}; leaving it unchanged.`);
  }
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new Error(`Invalid Codex hooks at ${path}; leaving it unchanged.`);
  }
  const groups = hooks.SessionEnd ?? [];
  if (!Array.isArray(groups)) throw new Error(`Invalid SessionEnd hooks at ${path}.`);
  for (const subcommand of ["extract-memories", "insights-judge"]) {
    const command = `servant ${subcommand} --from-hook --agent codex --root ${shellSingleQuote(aiServantRoot())}`;
    const present = groups.some(
      (group: { hooks?: { command?: string }[] }) =>
        Array.isArray(group?.hooks) && group.hooks.some((hook) => hook?.command === command),
    );
    if (!present) groups.push({ hooks: [{ type: "command", command, timeout: 3 }] });
  }
  hooks.SessionEnd = groups;
  settings.hooks = hooks;
  const desired = `${JSON.stringify(settings, null, 2)}\n`;
  if (existing === desired) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, desired);
}
