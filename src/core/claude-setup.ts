import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TEMPLATES } from "../templates/index.generated.ts";
import { composeAssetForRel, isFineTuneAsset } from "./fine-tune.ts";
import { appendChange } from "./insights/changes.ts";
import { aiServantRoot, claudeCommandsDir } from "./paths.ts";

// Templates synced into the servant root live under the `servant_root/` prefix in the
// embedded manifest; the part after it is the path relative to `~/.ai_servant/`.
const SERVANT_ROOT_PREFIX = "servant_root/";

// Slash commands used to live flat at `.claude/commands/<name>.md` (un-prefixed `/goal`,
// `/delegate`). They are now namespaced under `commands/servant/` so they surface as
// `/servant:goal` / `/servant:delegate`. The sync below never deletes, so on upgrade the
// stale flat copies would linger and shadow the namespaced ones with duplicate commands.
// Remove the specific legacy files we know we shipped.
const LEGACY_FLAT_COMMANDS = ["goal.md", "delegate.md"];

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
  const sources = TEMPLATES.filter((t) => t.rel.startsWith(SERVANT_ROOT_PREFIX));
  const changedAssets: string[] = [];
  for (const src of sources) {
    const rel = src.rel.slice(SERVANT_ROOT_PREFIX.length);
    const dest = join(target, rel);
    const incoming = Buffer.from(src.content, "utf8");
    const desired = isFineTuneAsset(rel)
      ? Buffer.from(await composeAssetForRel(rel, src.content), "utf8")
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
