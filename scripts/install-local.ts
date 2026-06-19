#!/usr/bin/env bun
// Install the freshly built `dist/servant` binary to `~/.bun/bin/servant` (already on PATH
// via `export PATH="$HOME/.bun/bin:$PATH"`), replacing any prior `bun link` source symlink.
// Run after `bun run build` (the `install-local` package script chains them).
import { chmod, copyFile, lstat, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const here = dirname(Bun.fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const src = join(repoRoot, "dist", "servant");
const binDir = join(homedir(), ".bun", "bin");
const dest = join(binDir, "servant");

if (!(await Bun.file(src).exists())) {
  throw new Error(`Build artifact not found at ${src} — run \`bun run build\` first.`);
}

await mkdir(binDir, { recursive: true });

// Remove any existing entry first: `bun link` leaves a symlink here, and copyFile onto a
// symlink would follow it and clobber the link target (the source tree) instead.
try {
  await lstat(dest);
  await rm(dest, { force: true });
} catch {
  // nothing there yet
}

await copyFile(src, dest);
await chmod(dest, 0o755);
console.log(`install-local — installed servant binary → ${dest}`);
