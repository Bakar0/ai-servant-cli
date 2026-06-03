import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { configPath } from "./paths.ts";

export type Config = {
  repoSearchRoots: string[];
  scanMaxDepth: number;
};

const DEFAULT_SEARCH_ROOTS = ["~/private", "~/code"];
const DEFAULT_SCAN_MAX_DEPTH = 4;

export function defaultConfig(): Config {
  return {
    repoSearchRoots: [...DEFAULT_SEARCH_ROOTS],
    scanMaxDepth: DEFAULT_SCAN_MAX_DEPTH,
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
    if (Array.isArray(obj.repoSearchRoots)) {
      const roots = obj.repoSearchRoots.filter((s): s is string => typeof s === "string");
      if (roots.length > 0) cfg.repoSearchRoots = roots;
    }
    if (typeof obj.scanMaxDepth === "number" && Number.isFinite(obj.scanMaxDepth)) {
      cfg.scanMaxDepth = Math.max(1, Math.floor(obj.scanMaxDepth));
    }
  }
  return cfg;
}

export async function configExists(): Promise<boolean> {
  return await Bun.file(configPath()).exists();
}

export async function loadConfig(): Promise<Config> {
  const file = Bun.file(configPath());
  if (!(await file.exists())) return defaultConfig();
  try {
    const raw = await file.json();
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
