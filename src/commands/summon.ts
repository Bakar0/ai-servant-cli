import { existsSync } from "node:fs";
import { defineCommand } from "citty";
import { requireInit } from "../core/config.ts";
import { applyRootOverride, workspacePath } from "../core/paths.ts";
import { readServantEnv } from "../core/servant-env.ts";
import { createSoxAudio } from "../core/summons-audio.ts";
import {
  composeSummonsInstructions,
  readWorkspaceSnapshot,
  resolveSummonsScope,
} from "../core/summons-context.ts";
import { createSummonsActions } from "../core/summons-delegate.ts";
import { requireOpenAiApiKey } from "../core/summons-preflight.ts";
import { createOpenAiRealtimeTransport } from "../core/summons-realtime.ts";
import { createWorkspaceReader } from "../core/summons-reader.ts";
import {
  DEFAULT_SUMMONS_IDLE_TIMEOUT_MS,
  DEFAULT_SUMMONS_MODEL,
  DEFAULT_SUMMONS_VOICE,
  createSummonsSession,
} from "../core/summons.ts";
import { resolveWorkspaceName } from "../core/workspace.ts";

const DEFAULT_IDLE_TIMEOUT_SECONDS = DEFAULT_SUMMONS_IDLE_TIMEOUT_MS / 1000;

async function readBriefing(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`servant summon: no briefing file at ${path}`);
  return file.text();
}

function parseIdleTimeoutMs(raw: unknown): number {
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error("servant summon: --idle-timeout must be a number of seconds (0 disables it).");
  }
  return Math.round(seconds * 1000);
}

export const summonCommand = defineCommand({
  meta: {
    name: "summon",
    description:
      "Hold a live spoken conversation with this workspace. Hands-free (open mic, voice-activity detection) over the OpenAI Realtime API; the agent reads and searches locally and never edits.",
  },
  args: {
    workspace: {
      type: "string",
      required: false,
      alias: "w",
      description: "Workspace the Summons is scoped to (default: the current workspace).",
    },
    repo: {
      type: "string",
      required: false,
      description:
        "Scope the session to one mounted repo under repos/ (default: the whole workspace).",
    },
    brief: {
      type: "string",
      required: false,
      description:
        "Path to a briefing from a prior session, prepended to the workspace state the session opens with.",
    },
    terminal: {
      type: "string",
      required: false,
      description:
        "Terminal delegated Claude sessions open in: cmux | iterm (default: auto-detect).",
    },
    voice: {
      type: "string",
      required: false,
      default: DEFAULT_SUMMONS_VOICE,
      description: `Realtime voice (default: ${DEFAULT_SUMMONS_VOICE}).`,
    },
    model: {
      type: "string",
      required: false,
      default: DEFAULT_SUMMONS_MODEL,
      description: `Realtime model (default: ${DEFAULT_SUMMONS_MODEL}).`,
    },
    "idle-timeout": {
      type: "string",
      required: false,
      default: String(DEFAULT_IDLE_TIMEOUT_SECONDS),
      description: `Seconds of silence before the session hangs up, so a forgotten mic stops billing (default: ${DEFAULT_IDLE_TIMEOUT_SECONDS}; 0 disables).`,
    },
    debug: {
      type: "boolean",
      required: false,
      default: false,
      description:
        "Trace the Realtime event stream and the audio subprocesses on stderr. Use when the session goes quiet and you need to see whether it is the socket or the mic.",
    },
    root: {
      type: "string",
      required: false,
      description: "Servant root directory (default: ~/.ai_servant). For throwaway/test setups.",
    },
  },
  async run({ args }) {
    applyRootOverride(args.root);
    const { hubRepo } = await requireInit();

    const idleMs = parseIdleTimeoutMs(args["idle-timeout"]);

    const workspace = await resolveWorkspaceName(args.workspace);
    if (!existsSync(workspacePath(workspace))) {
      throw new Error(`Workspace "${workspace}" not found at ${workspacePath(workspace)}.`);
    }

    const debug = args.debug ? (message: string) => console.error(`summon: ${message}`) : undefined;

    // Preflight before anything expensive: both failures tell the user what to install or export.
    const apiKey = requireOpenAiApiKey(process.env, await readServantEnv());
    let onAudioFailure: (message: string) => void = () => {};
    const audio = createSoxAudio({ onDebug: debug, onFailure: (m) => onAudioFailure(m) });

    const scope = await resolveSummonsScope(workspace, args.repo);
    const briefing = args.brief ? await readBriefing(args.brief) : undefined;
    // Read now, not from a cache: the session must open on the workspace as it is today.
    const snapshot = await readWorkspaceSnapshot(scope);

    let ended: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      ended = resolve;
    });
    const session = createSummonsSession({
      transport: createOpenAiRealtimeTransport(apiKey, { onDebug: debug }),
      reader: createWorkspaceReader(scope.root),
      // Delegated sessions open on the workspace, not the Summons' scope: `--repo` narrows what
      // the agent may read out loud, never what Claude is allowed to work on.
      actions: createSummonsActions({ workspace, hubRepo, terminal: args.terminal }),
      audio,
      instructions: composeSummonsInstructions(snapshot, briefing),
      model: args.model,
      voice: args.voice,
      idleTimeoutMs: idleMs,
      onStopped: () => ended(),
      onError: (message) => console.error(`servant summon: ${message}`),
    });

    // A dead mic or speaker is not recoverable mid-session, and staying open would look to the
    // user exactly like the agent having nothing to say.
    onAudioFailure = (message) => {
      console.error(`servant summon: ${message}`);
      void session.stop();
    };

    await session.start();
    console.log(
      `servant: talking about workspace "${workspace}" (${scope.label}) — ${snapshot.tickets.length} open ticket(s).\n` +
        "  The mic is open; just start speaking. Ctrl-C to hang up.",
    );

    process.on("SIGINT", () => void session.stop());
    await finished;
    console.log("servant: Summons ended.");
  },
});
