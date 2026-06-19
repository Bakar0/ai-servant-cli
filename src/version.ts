import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isCompiled } from "./core/self-exec.ts";
import { BUILD_VERSION } from "./version.generated.ts";

/**
 * Resolve the running `servant` version.
 *
 * - **Compiled binary:** `BUILD_VERSION`, stamped from `git describe` at build time
 *   (`scripts/gen-version.ts`, run on `prebuild`). There is no `.git` next to a shipped
 *   binary, so the value must be embedded.
 * - **Dev (`bun run`):** the live `git describe --tags --always` of the source tree, so the
 *   reported version always tracks the working tree you're actually running.
 */
export function getVersion(): string {
  if (!isCompiled()) {
    const live = gitDescribe();
    if (live) return live;
  }
  return BUILD_VERSION;
}

function gitDescribe(): string | null {
  try {
    const proc = Bun.spawnSync(["git", "describe", "--tags", "--always"], {
      cwd: dirname(fileURLToPath(import.meta.url)),
      stdout: "pipe",
      stderr: "ignore",
    });
    if (proc.exitCode !== 0) return null;
    const out = proc.stdout.toString().trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
