import { existsSync } from "node:fs";
import { defineCommand } from "citty";
import { DEFAULT_AGENT } from "../agents/index.ts";
import { createLiveCallLogView } from "../core/call-log/live.ts";
import { teeCallLog } from "../core/call-log/record.ts";
import { openCallLog } from "../core/call-log/store.ts";
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
import { createHandsSession } from "../core/summons-hands.ts";
import { createSummonsTickets } from "../core/summons-tickets.ts";
import { requireOpenAiApiKey } from "../core/summons-preflight.ts";
import { createOpenAiRealtimeTransport } from "../core/summons-realtime.ts";
import { createWorkspaceReader } from "../core/summons-reader.ts";
import { createSummonsView } from "../core/summons-view.ts";
import {
  DEFAULT_SUMMONS_IDLE_TIMEOUT_MS,
  DEFAULT_SUMMONS_MODEL,
  DEFAULT_SUMMONS_VOICE,
  type SummonsSession,
  createSummonsSession,
} from "../core/summons.ts";
import { readWorkspaceAgent, resolveWorkspaceName } from "../core/workspace.ts";
import { readSessionLatest, readWorkspaceSessions } from "../core/workspace-sessions.ts";

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
    headphones: {
      type: "boolean",
      required: false,
      default: false,
      description:
        "You are on headphones, so the agent cannot hear itself. Keeps the mic open through its replies, which lets it be interrupted the instant you start speaking. On speakers this must stay off: an open mic there hears the agent and it interrupts itself.",
    },
    "no-fast": {
      type: "boolean",
      required: false,
      default: false,
      description:
        "Launch delegated Claude sessions without fast mode. Fast mode is the same model with faster output, and a session a Summons delegates to is what the conversation is waiting for — so it is on by default. Turn it off to compare, or if your plan does not offer it.",
    },
    "no-barge-in": {
      type: "boolean",
      required: false,
      default: false,
      description:
        "Never cut a reply off, however loud the room gets. Replies always play to the end and talking over one does nothing. Use it to tell an interrupted reply from a broken one, or in a room the echo detector reads badly.",
    },
    debug: {
      type: "boolean",
      required: false,
      default: false,
      description:
        "Trace the Realtime event stream and the audio subprocesses — inline in the Summons view, on stderr when the output is piped. Use when the session goes quiet and you need to see whether it is the socket or the mic.",
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

    /**
     * Where everything the command itself has to say goes.
     *
     * Late-bound because the Summons view does not exist yet and must not: it captures the terminal,
     * and the preflight below can still throw. Until it opens, a line is a line on the terminal;
     * after it opens, a line written straight to the terminal would land inside the pinned footer,
     * so every one of them has to go through the view instead. `--debug` above all, which is the
     * output that made the audio bugs findable and is also the noisiest.
     */
    let say: (line: string) => void = (line) => console.log(`servant: ${line}`);
    let complain: (line: string) => void = (line) => console.error(`servant summon: ${line}`);
    const debug = args.debug ? (message: string) => complain(`summon: ${message}`) : undefined;

    // Preflight before anything expensive: both failures tell the user what to install or export.
    const apiKey = requireOpenAiApiKey(process.env, await readServantEnv());
    let onAudioFailure: (message: string) => void = () => {};
    let onAudioLost: (message: string) => void = () => {};
    const audio = createSoxAudio({
      onDebug: debug,
      onFailure: (m) => onAudioFailure(m),
      onLost: (m) => onAudioLost(m),
    });

    // A Hands session is a resumable headless Claude thread and has no equivalent on Codex, whose
    // headless runs are ephemeral by design. A Codex workspace summons without hands rather than
    // being handed a tool that would spawn the wrong agent.
    const backend = (await readWorkspaceAgent(workspace)) ?? DEFAULT_AGENT;
    const hands = backend === "claude-code" ? createHandsSession({ workspace }) : undefined;

    const scope = await resolveSummonsScope(workspace, args.repo);
    const briefing = args.brief ? await readBriefing(args.brief) : undefined;
    // Read now, not from a cache: the session must open on the workspace as it is today.
    const snapshot = await readWorkspaceSnapshot(scope);

    // Opened before the socket is: a Summons that dies during the handshake still leaves a record
    // saying it was attempted. The live view and the durable record are the same entries, fanned
    // out — what the user watches scroll past is exactly what is kept.
    const callLog = await openCallLog({
      workspace,
      scope: scope.label,
      model: args.model,
      voice: args.voice,
      onWriteError: (message) => complain(`call log write failed — ${message}`),
    });

    /**
     * A terminal at both ends, or the Plain view.
     *
     * Both are required, and for different reasons: without a terminal on stdout there is nothing to
     * pin a footer to, and without one on stdin there is nobody to read keys from. A Summons whose
     * output is piped or redirected keeps today's line printer exactly as it was — which is what a
     * pipe, a redirect and a test all want (workspace ADR 0014).
     */
    const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
    // Imported here rather than at the top of the file, because this is the one module in servant
    // with a native dependency behind it. Loaded eagerly, every `servant` command — `tasks`,
    // `ticket show`, all of them — would pay OpenTUI's FFI load at startup and would stop working
    // outright on a platform it has no binary for. A Summons on a terminal is the only caller that
    // needs it, so it is the only one that loads it.
    const terminal = interactive
      ? await (await import("../core/summons-terminal.ts")).openSummonsTerminal()
      : undefined;

    // Everything from here to the `finally` runs with the terminal belonging to the view rather than
    // to the user — so every path out of it, a failed handshake included, has to hand the terminal
    // back. Left pinned, the footer sits over the shell's own output and stdin stays in raw mode.
    try {
      // The view is built before the session it drives, because it is also where the session's own
      // opening lines are printed. It reaches the session through this, which is filled in below.
      let sessionRef: SummonsSession | undefined;
      const view = terminal
        ? createSummonsView({
            screen: terminal.screen,
            session: {
              typed: (text) => sessionRef?.typed(text) ?? Promise.resolve(),
              interrupt: () => sessionRef?.interrupt() ?? false,
              toggleMute: () => sessionRef?.toggleMute() ?? false,
              stop: () => sessionRef?.stop() ?? Promise.resolve(),
            },
            workspace,
            // Named only when it narrows something: every Summons is scoped to a workspace, and
            // saying so twice on one line says nothing.
            scope: args.repo ? scope.label : "",
            bargeIn: !args["no-barge-in"],
            callLogId: callLog.id,
          })
        : undefined;
      if (view) {
        terminal?.attach(view);
        say = (line) => view.say(line);
        // Nothing may reach the terminal around the view, and stderr is not the view's — a line
        // written there would be painted over the footer. Errors are notes in the transcript instead.
        complain = (line) => view.say(line);
      }
      const printed =
        view ?? createLiveCallLogView({ write: (line) => process.stdout.write(`${line}\n`) });

      // One adapter over the board, handed to the controller as two narrow ports: the Claims steering
      // reads, and the one write a Summons can make. The Call log id goes with it so anything filed
      // by voice can be traced back to the conversation that produced it.
      const hub = createSummonsTickets({ workspace, callLogId: callLog.id });

      let ended: () => void = () => {};
      const finished = new Promise<void>((resolve) => {
        ended = resolve;
      });
      const session = createSummonsSession({
        transport: createOpenAiRealtimeTransport(apiKey, { onDebug: debug }),
        reader: createWorkspaceReader(scope.root),
        // Delegated sessions open on the workspace, not the Summons' scope: `--repo` narrows what
        // the agent may read out loud, never what Claude is allowed to work on.
        actions: createSummonsActions({
          workspace,
          terminal: args.terminal,
          fastMode: !args["no-fast"],
        }),
        // Constructed, not started: the session behind this is spawned by the first request that
        // needs it, and a Summons where nothing ever needs hands costs nothing.
        hands,
        // A directory scan, not a question put to anyone — so it is always available, even in a
        // workspace whose backend has no hands to reach.
        sessions: {
          list: () => readWorkspaceSessions(workspace),
          latest: (name) => readSessionLatest(workspace, name),
        },
        // What makes steering Claim-scoped. Offered alongside the registry and the hands, since all
        // three are needed before a session may be addressed at all (workspace ADR 0010).
        tickets: hub,
        filing: hub,
        audio,
        headphones: args.headphones,
        bargeIn: !args["no-barge-in"],
        callLog: teeCallLog([callLog.port, printed]),
        instructions: composeSummonsInstructions(snapshot, briefing),
        model: args.model,
        voice: args.voice,
        idleTimeoutMs: idleMs,
        onStopped: () => ended(),
        // Straight to the status line when there is one. It is the only place a Summons says what it
        // is doing while it does it, and the only place the mic level and the learned echo floor
        // appear as numbers at all (servant-summon#3, #10).
        onStatus: view ? (status) => view.status(status) : undefined,
        onDebug: debug,
        onError: (message) => complain(message),
      });
      sessionRef = session;

      // A dead mic is not recoverable mid-session, and staying open would look to the user exactly
      // like the agent having nothing to say. Recorded as well as printed: this is the reason the
      // session ended, and the Call log used to show only that it ended.
      onAudioFailure = (message) => {
        complain(message);
        session.note(message);
        void session.stop();
      };

      // Playback died, the conversation did not. Worth saying out loud — a word or two went missing —
      // but not worth hanging up over.
      onAudioLost = (message) => {
        complain(message);
        session.note(message, "info");
      };

      await session.start();
      // One line per fact, because the view prints line by line and a paragraph written as one
      // string would arrive as one line whatever the newlines in it said. What the status line and
      // the hint row already carry is not repeated here.
      for (const line of [
        `talking about workspace "${workspace}" (${scope.label}) — ${snapshot.tickets.length} open ticket(s).`,
        `Call log: ${callLog.path}`,
        `Echo gate: ${args.headphones ? "off (headphones) — talk over it any time" : "on (speakers) — start talking to cut it off"}`,
        ...(args["no-barge-in"] ? ["Barge-in: off — replies always play to the end"] : []),
        ...(view
          ? ["The mic is open; start speaking, or type below. /help lists the keys."]
          : ["The mic is open; just start speaking. Ctrl-C to hang up."]),
      ]) {
        say(line);
      }

      // Not redundant with the view's own Ctrl-C: this is what covers a Summons with no terminal to
      // read keys from, and a `kill -INT` arriving at one that has.
      process.on("SIGINT", () => void session.stop());
      await finished;
    } finally {
      // Before the closing lines below, so they are written to a terminal that is the user's again.
      // The footer goes; the transcript above it stays where the terminal put it.
      terminal?.close();
    }
    // Only the tail is waited on — every entry before it was already on disk when it happened.
    await callLog.close();
    console.log(`\nservant: Summons ended. Read it back with:\n  servant call-log ${callLog.id}`);
  },
});
