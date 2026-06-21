import { readFile } from "node:fs/promises";
import { defineCommand } from "citty";
import { DEFAULT_AGENT, getAgent } from "../agents/index.ts";
import { claudeProjectsRoot } from "../core/claude-session.ts";
import { ensureServantAssets } from "../core/claude-setup.ts";
import { requireInit } from "../core/config.ts";
import {
  FINE_TUNE_ASPECTS,
  type FineTuneAspect,
  ensureScaffold,
  getAspect,
  isCustomized,
  readOverlayBody,
  resetOverlay,
  writeOverlay,
} from "../core/fine-tune.ts";
import { aiServantRoot, applyRootOverride } from "../core/paths.ts";
import { detectTerminal, getDriver } from "../terminals/index.ts";

// Title for the fine-tune session tab. Global (no workspace) — it customizes servant itself.
const SESSION_TITLE = "fine-tune";

function interviewPrompt(aspectId?: string): string {
  return aspectId
    ? `Run the /servant:fine-tune command to help me fine-tune servant's \`${aspectId}\` instructions.`
    : "Run the /servant:fine-tune command: analyze my servant insights and help me act on them.";
}

/**
 * Open an interactive servant session that runs the insights analyst loop (or, with an aspect,
 * jumps straight to tuning it) and writes overlays via the CLI. Mirrors `servant spawn`: a new
 * terminal tab running the agent — but global, with cwd at the servant root so
 * `/servant:fine-tune` resolves and the root CLAUDE.md auto-loads. The Claude projects root is
 * added to tool scope so the analyst can drill metric anchors into raw transcripts without a
 * permission prompt per drill. This `--add-dir` is interactive-only — the headless `claude -p`
 * judge/extraction runners never get it.
 */
async function openSession(aspectId: string | undefined, terminal?: string): Promise<void> {
  await requireInit();
  await ensureServantAssets();
  const cwd = aiServantRoot();
  const command = getAgent(DEFAULT_AGENT).launchCommand(cwd, {
    prompt: interviewPrompt(aspectId),
    addDirs: [claudeProjectsRoot()],
  });
  const driver = terminal ? getDriver(terminal) : await detectTerminal();
  await driver.openTab({ cwd, command, title: SESSION_TITLE });
  console.log(
    `servant: opened ${driver.name} tab "${SESSION_TITLE}" at ${cwd} running "${command}"`,
  );
}

function requireAspect(id: string): FineTuneAspect {
  const aspect = getAspect(id);
  if (!aspect) {
    const ids = FINE_TUNE_ASPECTS.map((a) => a.id).join(", ");
    throw new Error(`Unknown fine-tune aspect "${id}". Known: ${ids}.`);
  }
  return aspect;
}

function consumers(aspect: FineTuneAspect): string {
  const parts = [...aspect.assets];
  if (aspect.feedsExtractionPrompt) parts.push("headless extraction prompt");
  return parts.join(", ");
}

async function runList(): Promise<void> {
  const lines: string[] = ["servant fine-tune — aspects:"];
  for (const aspect of FINE_TUNE_ASPECTS) {
    const mark = (await isCustomized(aspect.id)) ? "✎ customized" : "· default   ";
    lines.push(`  ${mark}  ${aspect.id.padEnd(18)} ${aspect.blurb}`);
  }
  console.log(lines.join("\n"));
}

async function runShow(aspect: FineTuneAspect): Promise<void> {
  const body = await readOverlayBody(aspect.id);
  if (!body) {
    console.log(`servant: \`${aspect.id}\` has no fine-tuning yet (using defaults).`);
    return;
  }
  console.log(body);
}

export const fineTuneCommand = defineCommand({
  meta: {
    name: "fine-tune",
    description:
      "Customize servant's instruction assets per aspect. Bare: open an interactive session to tune. Flags drive the deterministic write path the session uses.",
  },
  args: {
    aspect: {
      type: "positional",
      required: false,
      description: `Aspect to tune: ${FINE_TUNE_ASPECTS.map((a) => a.id).join(" | ")}.`,
    },
    list: {
      type: "boolean",
      required: false,
      default: false,
      description: "List tunable aspects and whether each is customized.",
    },
    show: {
      type: "boolean",
      required: false,
      default: false,
      description: "Print the aspect's current overlay (user customization).",
    },
    set: {
      type: "boolean",
      required: false,
      default: false,
      description:
        "Write the aspect's overlay from --body-file (or stdin) and recompose the delivered assets.",
    },
    "body-file": {
      type: "string",
      required: false,
      description: "With --set: read the overlay body from this file instead of stdin.",
    },
    scaffold: {
      type: "boolean",
      required: false,
      default: false,
      description: "Create the aspect's overlay file with its guidance scaffold; print its path.",
    },
    reset: {
      type: "boolean",
      required: false,
      default: false,
      description: "Delete the aspect's overlay (revert to defaults) and recompose.",
    },
    apply: {
      type: "boolean",
      required: false,
      default: false,
      description: "Recompose all delivered assets from base + overlays (idempotent).",
    },
    terminal: {
      type: "string",
      required: false,
      description: "Terminal to open the session in: cmux | iterm (default: auto-detect).",
    },
    root: {
      type: "string",
      required: false,
      description: "Servant root directory (default: ~/.ai_servant). For throwaway/test setups.",
    },
  },
  async run({ args }) {
    applyRootOverride(args.root);
    const aspectId = (args.aspect as string | undefined)?.trim() || undefined;

    if (args.list) return runList();
    if (args.apply) {
      await ensureServantAssets();
      console.log("servant: recomposed fine-tune assets.");
      return;
    }

    // No aspect and no global action → open the all-aspects interview session.
    if (!aspectId) return openSession(undefined, args.terminal);

    const aspect = requireAspect(aspectId);

    if (args.show) return runShow(aspect);
    if (args.scaffold) {
      console.log(await ensureScaffold(aspect));
      return;
    }
    if (args.reset) {
      const removed = await resetOverlay(aspect.id);
      await ensureServantAssets();
      console.log(
        removed
          ? `servant: reset \`${aspect.id}\` to defaults.`
          : `servant: \`${aspect.id}\` had no overlay.`,
      );
      return;
    }
    if (args.set) {
      const body = args["body-file"]
        ? await readFile(args["body-file"], "utf8")
        : await Bun.stdin.text();
      const path = await writeOverlay(aspect, body);
      await ensureServantAssets();
      console.log(
        `servant: fine-tuned \`${aspect.id}\` → ${path}\n  applies to: ${consumers(aspect)}`,
      );
      return;
    }

    // Aspect given, no action flag → open a session focused on that aspect.
    return openSession(aspect.id, args.terminal);
  },
});
