import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { composeAssetForRel, isFineTuneAsset } from "./fine-tune.ts";
import { appendChange } from "./insights/changes.ts";
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
 *
 * For tunable assets (see `fine-tune.ts`), the user's overlay is appended to the
 * bundled base before the comparison, so the base keeps updating while the overlay
 * survives. Composition is deterministic, so the "overwrite only on change" check holds.
 */
export async function ensureServantAssets(): Promise<void> {
  const target = aiServantRoot();
  const sources = await listTemplateFiles(TEMPLATES_DIR);
  const changedAssets: string[] = [];
  for (const src of sources) {
    const rel = relative(TEMPLATES_DIR, src);
    const dest = join(target, rel);
    const incoming = await readFile(src);
    const desired = isFineTuneAsset(rel)
      ? Buffer.from(await composeAssetForRel(rel, incoming.toString("utf8")), "utf8")
      : incoming;
    let existing: Buffer | null = null;
    try {
      existing = await readFile(dest);
    } catch {
      // missing, will write
    }
    if (existing?.equals(desired)) continue;
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, desired);
    // A brand-new install (no prior store) shouldn't flood the ledger; only log changes to
    // an existing install, where the asset materially moved the effective setup.
    if (existing !== null) changedAssets.push(rel);
  }
  await removeLegacyFlatCommands();
  // Record asset changes in the insights ledger (the before/after primitive). Best-effort.
  if (changedAssets.length > 0 && existsSync(join(target, "insights"))) {
    for (const rel of changedAssets) {
      await appendChange({ ts: Date.now(), kind: "asset", id: rel, note: "asset re-sync" });
    }
  }
}

/** Delete pre-namespace flat command files so upgraded installs don't keep duplicate commands. */
async function removeLegacyFlatCommands(): Promise<void> {
  const dir = claudeCommandsDir();
  for (const name of LEGACY_FLAT_COMMANDS) {
    await rm(join(dir, name), { force: true });
  }
}
