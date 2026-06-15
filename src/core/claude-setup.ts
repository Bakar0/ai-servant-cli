import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { aiServantRoot, claudeCommandsDir } from "./paths.ts";

const TEMPLATES_DIR = new URL("../templates/servant_root/", import.meta.url).pathname;

// Slash commands used to live flat at `.claude/commands/<name>.md` (un-prefixed `/goal`,
// `/delegate`). They are now namespaced under `commands/servant/` so they surface as
// `/servant:goal` / `/servant:delegate`. The sync below never deletes, so on upgrade the
// stale flat copies would linger and shadow the namespaced ones with duplicate commands.
// Remove the specific legacy files we know we shipped.
const LEGACY_FLAT_COMMANDS = ["goal.md", "delegate.md"];

async function listTemplateFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  await walk(root);
  return out;
}

/**
 * Sync the bundled servant-root templates into `~/.ai_servant/`. This includes
 * the workspace conventions doc (`CLAUDE.md`) and the slash-command directory
 * (`.claude/commands/*.md`). Existing files are overwritten only when content
 * has changed; missing files are created. Idempotent and cheap to run on every
 * spawn so users automatically pick up template updates.
 */
export async function ensureServantAssets(): Promise<void> {
  const target = aiServantRoot();
  const sources = await listTemplateFiles(TEMPLATES_DIR);
  for (const src of sources) {
    const rel = relative(TEMPLATES_DIR, src);
    const dest = join(target, rel);
    const incoming = await readFile(src);
    let existing: Buffer | null = null;
    try {
      existing = await readFile(dest);
    } catch {
      // missing, will write
    }
    if (existing?.equals(incoming)) continue;
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, incoming);
  }
  await removeLegacyFlatCommands();
}

/** Delete pre-namespace flat command files so upgraded installs don't keep duplicate commands. */
async function removeLegacyFlatCommands(): Promise<void> {
  const dir = claudeCommandsDir();
  for (const name of LEGACY_FLAT_COMMANDS) {
    await rm(join(dir, name), { force: true });
  }
}
