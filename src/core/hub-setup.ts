import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { $ } from "bun";
import { hubRemoteUrl, hubRoot } from "./paths.ts";

// One-time, network-touching setup for the servant hub. Best-effort: it never throws, so
// `servant init` completes offline / unauthenticated and just reports what it couldn't do. Callers
// gate it on paths.isDefaultRoot() so throwaway `--root`/test setups never reach the network.
//
// `servant init` used to also `claude plugin install` a specific third-party skill plugin from here.
// It no longer installs any skill: a skill is data servant manages, not behavior it knows, so the
// CLI names no skill and no source. Installing one is `servant skills install <source>`, and which
// sources are worth trying is prose in the `servant-skills` skill.

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
      `servant: hub dir ${root} exists but isn't a clone — leaving it (\`servant tasks\` will have no hub to read)`,
    );
    return;
  }
  const url = hubRemoteUrl(hubRepo);
  const res = await $`git clone ${url} ${root}`.nothrow().quiet();
  if (res.exitCode === 0) log(`servant: cloned hub ${hubRepo} → ${root}`);
  else
    log(
      `servant: could not clone hub ${hubRepo} (offline or no access) — \`servant tasks\` will have no hub to read`,
    );
}
