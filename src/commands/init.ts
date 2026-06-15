import { mkdir } from "node:fs/promises";
import { defineCommand } from "citty";
import { ensureServantAssets } from "../core/claude-setup.ts";
import {
  type Config,
  configExists,
  defaultConfig,
  loadConfig,
  saveConfig,
} from "../core/config.ts";
import { aiServantRoot, applyRootOverride, configPath } from "../core/paths.ts";
import { confirm } from "../ui/prompts.ts";
import { STATUSLINE_EXAMPLE, installStatusline } from "./statusline.ts";

export type InitOpts = {
  /** Root directory (default: ~/.ai_servant). Supports a leading `~`. For throwaway/test roots. */
  root?: string | undefined;
  /** Non-interactive: accept defaults, don't prompt, skip statusline. */
  yes?: boolean;
  /** Overwrite config.json with defaults even if it already exists. */
  force?: boolean;
  /** Override TTY detection (tests). */
  interactive?: boolean;
  /** Where human-facing messages go (default stderr). */
  output?: NodeJS.WritableStream;
  /** Test seam for the statusline confirmation. */
  confirmFn?: (message: string, defaultYes: boolean) => Promise<boolean>;
};

/**
 * Set servant up in one explicit, idempotent step: create the root (~/.ai_servant, or
 * `--root` for a throwaway/test location), write config.json, sync the bundled assets, and
 * optionally install the Claude Code status line. Safe to run multiple times.
 */
export async function runInit(opts: InitOpts = {}): Promise<void> {
  const out = opts.output ?? process.stderr;
  const interactive = opts.interactive ?? (Boolean(process.stdin.isTTY) && !opts.yes);
  const confirmFn =
    opts.confirmFn ?? ((message: string, defaultYes: boolean) => confirm(message, defaultYes));

  // --- Root: default ~/.ai_servant, or wherever --root points (for testing). ---
  applyRootOverride(opts.root);
  const root = aiServantRoot();
  await mkdir(root, { recursive: true });
  out.write(`servant: root → ${root}\n`);

  // --- Config (user-owned; never clobbered on re-run). repoSearchRoots defaults to the
  // home dir and is edited in config.json, not prompted for here. ---
  const existed = await configExists();
  let cfg: Config;
  if (existed && !opts.force) {
    cfg = await loadConfig();
    // Re-save to backfill `version` on legacy files; values are preserved.
    await saveConfig(cfg);
    out.write(
      `servant: kept existing config at ${configPath()}\n  search roots: ${cfg.repoSearchRoots.join(", ")}  (edit config.json to change)\n`,
    );
  } else {
    cfg = defaultConfig();
    await saveConfig(cfg);
    out.write(
      `servant: wrote ${configPath()}\n  search roots: ${cfg.repoSearchRoots.join(", ")}  (where repo add looks for git clones; edit config.json to narrow)\n`,
    );
  }

  // --- Deterministic assets (CLI-owned; self-heal on every spawn/resume too). ---
  await ensureServantAssets();
  out.write("servant: synced workspace assets (CLAUDE.md, /goal, /delegate)\n");

  // --- Status line (offered, with a preview). ---
  if (interactive) {
    out.write(`\n${STATUSLINE_EXAMPLE}`);
    if (await confirmFn("Install it now?", false)) {
      await installStatusline((s) => out.write(`${s}\n`));
    } else {
      out.write("servant: skipped status line — run `servant statusline` later to add it.\n");
    }
  }

  // --- Summary. ---
  out.write(
    `\nservant: ready.\n  root:    ${root}\n  config:  ${configPath()}\n  search:  ${cfg.repoSearchRoots.join(", ")}\n\n  first command:  servant spawn -w <workspace-name> -r\n                  (-r picks repos and adds worktrees before opening the tab)\n`,
  );
}

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description:
      "Set up servant: create the root (~/.ai_servant), write config.json, sync assets, and optionally install the status line. Idempotent.",
  },
  args: {
    root: {
      type: "string",
      required: false,
      description:
        "Root directory for servant state (default: ~/.ai_servant). For throwaway/test setups. Supports ~.",
    },
    yes: {
      type: "boolean",
      required: false,
      alias: "y",
      default: false,
      description: "Non-interactive: accept defaults, don't prompt, skip the status line.",
    },
    force: {
      type: "boolean",
      required: false,
      default: false,
      description: "Overwrite config.json with defaults even if it already exists.",
    },
  },
  async run({ args }) {
    await runInit({
      root: args.root as string | undefined,
      yes: Boolean(args.yes),
      force: Boolean(args.force),
    });
  },
});
