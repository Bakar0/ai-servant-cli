import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { $ } from "bun";
import { hubRemoteUrl, hubRoot } from "./paths.ts";

// One-time, network-touching setup for the servant hub + skills. Both functions are best-effort:
// they never throw, so `servant init` completes offline / unauthenticated and just reports what it
// couldn't do. Callers gate these on paths.isDefaultRoot() so throwaway `--root`/test setups never
// reach the network.

const MARKETPLACE = "mattpocock/skills";
const PLUGIN = "mattpocock-skills@mattpocock";

type Log = (line: string) => void;

/** True if a directory is absent or empty (safe to `git clone` into). */
async function absentOrEmpty(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return true;
  try {
    return (await readdir(dir)).length === 0;
  } catch {
    return false;
  }
}

/**
 * Clone the majordomo hub into ~/.ai_servant/majordomo/ when it isn't already a git clone.
 * No-op when the clone (or any non-empty dir) is already there. Best-effort.
 */
export async function ensureHubClone(hubRepo: string, log: Log = () => {}): Promise<void> {
  const root = hubRoot();
  if (existsSync(`${root}/.git`)) return;
  if (!(await absentOrEmpty(root))) {
    log(
      `servant: hub dir ${root} exists but isn't a clone — leaving it (knowledge stays local-only)`,
    );
    return;
  }
  const url = hubRemoteUrl(hubRepo);
  const res = await $`git clone ${url} ${root}`.nothrow().quiet();
  if (res.exitCode === 0) log(`servant: cloned hub ${hubRepo} → ${root}`);
  else
    log(
      `servant: could not clone hub ${hubRepo} (offline or no access) — knowledge stays local-only`,
    );
}

/**
 * Install the mattpocock-skills plugin (user-global, idempotent). Adds the marketplace then
 * installs the plugin; both are safe to re-run. Best-effort — a missing `claude` CLI or offline
 * run just logs and moves on.
 */
export async function ensurePluginInstalled(log: Log = () => {}): Promise<void> {
  const list = await $`claude plugin list`.nothrow().quiet();
  if (list.exitCode === 0 && list.stdout.toString().includes("mattpocock-skills")) {
    return; // already installed
  }
  if (list.exitCode !== 0) {
    log("servant: `claude` CLI not available — skipped installing mattpocock-skills");
    return;
  }
  await $`claude plugin marketplace add ${MARKETPLACE}`.nothrow().quiet();
  const inst = await $`claude plugin install ${PLUGIN}`.nothrow().quiet();
  if (inst.exitCode === 0) log(`servant: installed mattpocock-skills plugin (${PLUGIN})`);
  else
    log(
      "servant: could not install mattpocock-skills plugin — run `claude plugin install " +
        PLUGIN +
        "` manually",
    );
}
