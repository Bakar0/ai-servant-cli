import { existsSync } from "node:fs";
import { defineCommand } from "citty";
import { requireInit } from "../core/config.ts";
import { applyRootOverride, workspacePath } from "../core/paths.ts";
import { createSoxAudio } from "../core/talk-audio.ts";
import {
  composeTalkInstructions,
  readWorkspaceSnapshot,
  resolveTalkScope,
} from "../core/talk-context.ts";
import { readServantEnv } from "../core/servant-env.ts";
import { requireOpenAiApiKey } from "../core/talk-preflight.ts";
import { createOpenAiRealtimeTransport } from "../core/talk-realtime.ts";
import { createWorkspaceReader } from "../core/talk-reader.ts";
import {
  DEFAULT_TALK_IDLE_TIMEOUT_MS,
  DEFAULT_TALK_MODEL,
  DEFAULT_TALK_VOICE,
  createTalkSession,
} from "../core/talk.ts";
import { resolveWorkspaceName } from "../core/workspace.ts";

const DEFAULT_IDLE_TIMEOUT_SECONDS = DEFAULT_TALK_IDLE_TIMEOUT_MS / 1000;

async function readBriefing(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`servant talk: no briefing file at ${path}`);
  return file.text();
}

function parseIdleTimeoutMs(raw: unknown): number {
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error("servant talk: --idle-timeout must be a number of seconds (0 disables it).");
  }
  return Math.round(seconds * 1000);
}

export const talkCommand = defineCommand({
  meta: {
    name: "talk",
    description:
      "Hold a live spoken conversation with this workspace. Hands-free (open mic, voice-activity detection) over the OpenAI Realtime API; the agent reads and searches locally and never edits.",
  },
  args: {
    workspace: {
      type: "string",
      required: false,
      alias: "w",
      description: "Workspace to talk about (default: the current workspace).",
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
    voice: {
      type: "string",
      required: false,
      default: DEFAULT_TALK_VOICE,
      description: `Realtime voice (default: ${DEFAULT_TALK_VOICE}).`,
    },
    model: {
      type: "string",
      required: false,
      default: DEFAULT_TALK_MODEL,
      description: `Realtime model (default: ${DEFAULT_TALK_MODEL}).`,
    },
    "idle-timeout": {
      type: "string",
      required: false,
      default: String(DEFAULT_IDLE_TIMEOUT_SECONDS),
      description: `Seconds of silence before the session hangs up, so a forgotten mic stops billing (default: ${DEFAULT_IDLE_TIMEOUT_SECONDS}; 0 disables).`,
    },
    root: {
      type: "string",
      required: false,
      description: "Servant root directory (default: ~/.ai_servant). For throwaway/test setups.",
    },
  },
  async run({ args }) {
    applyRootOverride(args.root);
    await requireInit();

    const idleMs = parseIdleTimeoutMs(args["idle-timeout"]);

    const workspace = await resolveWorkspaceName(args.workspace);
    if (!existsSync(workspacePath(workspace))) {
      throw new Error(`Workspace "${workspace}" not found at ${workspacePath(workspace)}.`);
    }

    // Preflight before anything expensive: both failures tell the user what to install or export.
    const apiKey = requireOpenAiApiKey(process.env, await readServantEnv());
    const audio = createSoxAudio();

    const scope = await resolveTalkScope(workspace, args.repo);
    const briefing = args.brief ? await readBriefing(args.brief) : undefined;
    // Read now, not from a cache: the session must open on the workspace as it is today.
    const snapshot = await readWorkspaceSnapshot(scope);

    let ended: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      ended = resolve;
    });
    const session = createTalkSession({
      transport: createOpenAiRealtimeTransport(apiKey),
      reader: createWorkspaceReader(scope.root),
      audio,
      instructions: composeTalkInstructions(snapshot, briefing),
      model: args.model,
      voice: args.voice,
      idleTimeoutMs: idleMs,
      onStopped: () => ended(),
      onError: (message) => console.error(`servant talk: ${message}`),
    });

    await session.start();
    console.log(
      `servant: talking about workspace "${workspace}" (${scope.label}) — ${snapshot.tickets.length} open ticket(s).\n` +
        "  The mic is open; just start speaking. Ctrl-C to hang up.",
    );

    process.on("SIGINT", () => void session.stop());
    await finished;
    console.log("servant: talk session ended.");
  },
});
