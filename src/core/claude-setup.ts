import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { aiServantRoot } from "./paths.ts";

const TEMPLATES_DIR = new URL("../templates/servant_root/", import.meta.url).pathname;

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
}
