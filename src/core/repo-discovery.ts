import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { $ } from "bun";
import { type Config, resolvedSearchRoots } from "./config.ts";
import { aiServantRoot, discoveryCachePath } from "./paths.ts";

export type DiscoveredRepo = {
  name: string;
  path: string;
  remoteUrl?: string;
  collides?: boolean;
};

type CacheFile = {
  generatedAt: number;
  rootMtimes: Record<string, number>;
  repos: DiscoveredRepo[];
};

type Scanner = "fd" | "find";

async function detectScanner(): Promise<Scanner> {
  const proc = await $`which fd`.nothrow().quiet();
  return proc.exitCode === 0 ? "fd" : "find";
}

async function rootMtime(root: string): Promise<number | null> {
  try {
    const s = await stat(root);
    return s.mtimeMs;
  } catch {
    return null;
  }
}

async function scanRoot(root: string, scanner: Scanner, maxDepth: number): Promise<string[]> {
  // Returns absolute paths to repo root directories (the directory containing the .git dir).
  const exists = await rootMtime(root);
  if (exists === null) return [];

  let stdout = "";
  if (scanner === "fd") {
    const proc =
      await $`fd --hidden --no-ignore --type d --max-depth ${String(maxDepth)} --prune --exclude node_modules ^\\.git$ ${root}`
        .nothrow()
        .quiet();
    stdout = proc.stdout.toString();
  } else {
    // find: depth includes the path itself; .git at depth N means root depth N-1
    const proc =
      await $`find ${root} -maxdepth ${String(maxDepth)} -type d -name node_modules -prune -o -type d -name .git -print`
        .nothrow()
        .quiet();
    stdout = proc.stdout.toString();
  }

  const out: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Only directories named .git; the parent dir is the repo root.
    if (basename(trimmed) !== ".git") continue;
    out.push(resolve(dirname(trimmed)));
  }
  return out;
}

async function readOriginUrl(repoPath: string): Promise<string | undefined> {
  const proc = await $`git -C ${repoPath} remote get-url origin`.nothrow().quiet();
  if (proc.exitCode !== 0) return undefined;
  const url = proc.stdout.toString().trim();
  return url || undefined;
}

function markCollisions(repos: DiscoveredRepo[]): DiscoveredRepo[] {
  const counts = new Map<string, number>();
  for (const r of repos) counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
  return repos.map((r) => ((counts.get(r.name) ?? 0) > 1 ? { ...r, collides: true } : r));
}

async function readCache(): Promise<CacheFile | null> {
  const file = Bun.file(discoveryCachePath());
  if (!(await file.exists())) return null;
  try {
    return (await file.json()) as CacheFile;
  } catch {
    return null;
  }
}

async function writeCache(cache: CacheFile): Promise<void> {
  await Bun.write(discoveryCachePath(), `${JSON.stringify(cache, null, 2)}\n`);
}

async function currentRootMtimes(roots: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const r of roots) {
    const m = await rootMtime(r);
    if (m !== null) out[r] = m;
  }
  return out;
}

function mtimesEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a).toSorted();
  const kb = Object.keys(b).toSorted();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    const key = ka[i];
    if (!key) return false;
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export async function discoverRepos(
  config: Config,
  opts: { refresh?: boolean } = {},
): Promise<DiscoveredRepo[]> {
  const roots = resolvedSearchRoots(config).map((r) => resolve(r));
  const mtimes = await currentRootMtimes(roots);

  if (!opts.refresh) {
    const cached = await readCache();
    if (cached && mtimesEqual(cached.rootMtimes, mtimes)) {
      return cached.repos;
    }
  }

  const scanner = await detectScanner();
  const excludeRoot = resolve(aiServantRoot());
  const found: string[] = [];
  for (const root of roots) {
    const paths = await scanRoot(root, scanner, config.scanMaxDepth);
    for (const p of paths) {
      if (p === excludeRoot || p.startsWith(`${excludeRoot}/`)) continue;
      found.push(p);
    }
  }

  // Dedupe by path
  const unique = Array.from(new Set(found));

  const repos: DiscoveredRepo[] = [];
  for (const p of unique) {
    const remoteUrl = await readOriginUrl(p);
    const entry: DiscoveredRepo = { name: basename(p), path: p };
    if (remoteUrl) entry.remoteUrl = remoteUrl;
    repos.push(entry);
  }

  const marked = markCollisions(repos);
  await writeCache({ generatedAt: Date.now(), rootMtimes: mtimes, repos: marked });
  return marked;
}
