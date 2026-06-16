import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defineCommand } from "citty";
import { applyRootOverride, statuslineScriptPath, userClaudeSettingsPath } from "../core/paths.ts";

const TEMPLATE_URL = new URL("../templates/claude/statusline.sh", import.meta.url);

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {};
  const raw = await readFile(path, "utf8");
  if (raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${path}: ${msg}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

/** A representative rendering of the status line, shown before offering to install it. */
export const STATUSLINE_EXAMPLE = [
  "The servant status line replaces Claude Code's bottom status bar with your",
  "model + token usage and one line per repo (branch · git stats · PR), plus a",
  "rotating gray tip reminding you what servant can do. Preview:",
  "",
  "     opus · 102k/200k · 12%",
  "   ▸ api ⎇ feat-login · ✎3 +1 · #482",
  "     web ⎇ feat-login · clean",
  "     ※ tip: servant spawn -w fix-login-bug -r — workspace for a task, pick repos",
  "",
  'Hide the tip anytime: set "showTips": false in ~/.ai_servant/config.json.',
  "",
].join("\n");

/**
 * Write the bundled status line script into the servant root and wire it into the
 * user's `~/.claude/settings.json`. Idempotent: re-running rewrites the same wiring.
 */
export async function installStatusline(log: (s: string) => void = console.log): Promise<void> {
  const dest = statuslineScriptPath();
  const script = await readFile(TEMPLATE_URL, "utf8");
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, script);
  await chmod(dest, 0o755);
  log(`servant: wrote ${dest}`);

  const settingsPath = userClaudeSettingsPath();
  const settings = await readJsonObject(settingsPath);
  const prev = settings.statusLine;
  settings.statusLine = { type: "command", command: dest };
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

  const prevCmd =
    prev && typeof prev === "object" && !Array.isArray(prev)
      ? ((prev as Record<string, unknown>).command as string | undefined)
      : undefined;
  if (prevCmd && prevCmd !== dest) {
    log(`servant: replaced statusLine.command in ${settingsPath} (was ${prevCmd})`);
  } else {
    log(`servant: wired statusLine in ${settingsPath}`);
  }
  log("servant: restart Claude Code to pick up the new status line.");
}

export const statuslineCommand = defineCommand({
  meta: {
    name: "statusline",
    description:
      "Install the servant status line for Claude Code: writes the script and wires it into ~/.claude/settings.json. Idempotent.",
  },
  args: {
    root: {
      type: "string",
      required: false,
      description: "Servant root directory (default: ~/.ai_servant). For throwaway/test setups.",
    },
  },
  async run({ args }) {
    applyRootOverride(args.root);
    await installStatusline();
  },
});
