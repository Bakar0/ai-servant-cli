import {
  type Config,
  configExists,
  defaultConfig,
  loadConfig,
  saveConfig,
} from "../../core/config.ts";
import { configPath } from "../../core/paths.ts";
import { promptText } from "../../ui/prompts.ts";

function parseCsv(s: string): string[] {
  return s
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY);
}

export type EnsureConfigOpts = {
  // Test seams
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  forceInteractive?: boolean;
};

export async function ensureConfigInteractive(opts: EnsureConfigOpts = {}): Promise<Config> {
  if (await configExists()) return await loadConfig();

  const interactive = opts.forceInteractive ?? isInteractive();
  if (!interactive) {
    // Don't write — let the user discover that config is missing only if it matters.
    return defaultConfig();
  }

  const out = opts.output ?? process.stderr;
  const defaults = defaultConfig();
  out.write(
    [
      "servant: no config found — creating one at",
      `  ${configPath()}`,
      "",
      "Repo search roots are the directories under which servant looks for your local clones.",
      `Defaults: ${defaults.repoSearchRoots.join(", ")}`,
      "",
    ].join("\n"),
  );

  const promptOpts: {
    default: string;
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
  } = {
    default: defaults.repoSearchRoots.join(", "),
  };
  if (opts.input) promptOpts.input = opts.input;
  if (opts.output) promptOpts.output = opts.output;
  const raw = await promptText("Search roots (comma-separated)", promptOpts);

  const roots = parseCsv(raw);
  const cfg: Config = {
    repoSearchRoots: roots.length > 0 ? roots : defaults.repoSearchRoots,
    scanMaxDepth: defaults.scanMaxDepth,
  };
  await saveConfig(cfg);
  out.write(`servant: wrote ${configPath()}\n`);
  return cfg;
}
