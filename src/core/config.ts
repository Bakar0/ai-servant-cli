import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { configPath } from "./paths.ts";

export type Config = {
  /** Schema version. Bump when the shape changes so `init` can migrate older files. */
  version: number;
  repoSearchRoots: string[];
  scanMaxDepth: number;
  /** Show the rotating servant tip in the status line. Set false to hide it. */
  showTips: boolean;
};

/** Current config schema version. */
export const CONFIG_VERSION = 1;

export const DEFAULT_SEARCH_ROOTS = ["~"];
export const DEFAULT_SCAN_MAX_DEPTH = 4;

export function defaultConfig(): Config {
  return {
    version: CONFIG_VERSION,
    repoSearchRoots: [...DEFAULT_SEARCH_ROOTS],
    scanMaxDepth: DEFAULT_SCAN_MAX_DEPTH,
    showTips: true,
  };
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function coerce(raw: unknown): Config {
  const cfg = defaultConfig();
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.version === "number" && Number.isFinite(obj.version)) {
      cfg.version = Math.max(1, Math.floor(obj.version));
    }
    if (Array.isArray(obj.repoSearchRoots)) {
      const roots = obj.repoSearchRoots.filter((s): s is string => typeof s === "string");
      if (roots.length > 0) cfg.repoSearchRoots = roots;
    }
    if (typeof obj.scanMaxDepth === "number" && Number.isFinite(obj.scanMaxDepth)) {
      cfg.scanMaxDepth = Math.max(1, Math.floor(obj.scanMaxDepth));
    }
    if (typeof obj.showTips === "boolean") {
      cfg.showTips = obj.showTips;
    }
  }
  return cfg;
}

export async function configExists(): Promise<boolean> {
  return Bun.file(configPath()).exists();
}

export async function loadConfig(): Promise<Config> {
  const file = Bun.file(configPath());
  if (!(await file.exists())) return defaultConfig();
  try {
    const raw: unknown = await file.json();
    return coerce(raw);
  } catch {
    return defaultConfig();
  }
}

export async function saveConfig(cfg: Config): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(cfg, null, 2)}\n`);
}

export function resolvedSearchRoots(cfg: Config): string[] {
  return cfg.repoSearchRoots.map(expandHome);
}

/**
 * Gate for commands that depend on a configured root. The presence of `config.json`
 * is the single "is this set up?" signal — it's user-owned and never auto-created
 * (deterministic assets self-heal separately on spawn/resume). Throws a clear,
 * actionable error when missing so the user runs `servant init` once.
 */
export async function requireInit(): Promise<Config> {
  if (!(await configExists())) {
    throw new Error(
      `servant: not initialized — run \`servant init\` first.\n  Expected config at ${configPath()}`,
    );
  }
  return loadConfig();
}
