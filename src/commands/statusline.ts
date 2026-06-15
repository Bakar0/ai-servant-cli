import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defineCommand } from "citty";
import { statuslineScriptPath, userClaudeSettingsPath } from "../core/paths.ts";

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

export const statuslineCommand = defineCommand({
  meta: {
    name: "statusline",
    description:
      "Install the servant status line for Claude Code: writes the script and wires it into ~/.claude/settings.json. Idempotent.",
  },
  async run() {
    const dest = statuslineScriptPath();
    const script = await readFile(TEMPLATE_URL, "utf8");
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, script);
    await chmod(dest, 0o755);
    console.log(`servant: wrote ${dest}`);

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
      console.log(`servant: replaced statusLine.command in ${settingsPath} (was ${prevCmd})`);
    } else {
      console.log(`servant: wired statusLine in ${settingsPath}`);
    }
    console.log("servant: restart Claude Code to pick up the new status line.");
  },
});
