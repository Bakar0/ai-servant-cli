import { defineCommand } from "citty";
import { assertValidSessionId, findSessionJsonl } from "../core/claude-session.ts";
import { createSoxSpeaker } from "../core/narrate-audio.ts";
import { openNarrationCache, sweepNarrationCache } from "../core/narrate-cache.ts";
import { acquirePlayerLock, playerLockHolder } from "../core/narrate-lock.ts";
import { createOpenAiEarCopyModel } from "../core/narrate-model.ts";
import { createNarrationPlayer } from "../core/narrate-player.ts";
import { narrateTurnStream, newestSessionForCwd } from "../core/narrate-session.ts";
import { type Turn, readTurns } from "../core/narrate-turn.ts";
import { createNarrationView } from "../core/narrate-view.ts";
import {
  DEFAULT_NARRATION_VOICE,
  type SpeechModel,
  createOpenAiSpeechModel,
  createSaySpeechModel,
} from "../core/narrate-voice.ts";
import { applyRootOverride } from "../core/paths.ts";
import { readServantEnv, resolveSecret } from "../core/servant-env.ts";
import { pickTurn } from "../ui/narrate-picker.ts";

// The entry point. Deliberately thin, and deliberately not scoped to a servant workspace: narration
// is for any Claude Code session (workspace GOAL.md), so there is no `requireInit` here and nothing
// below reads a workspace. All it needs is a transcript and the servant root's `.env`.

export const narrateCommand = defineCommand({
  meta: {
    name: "narrate",
    description:
      "Read a reply out loud, rewritten for the ear. Opens a player with pause, ±5s, segment skip and tempo. Defaults to the newest turn of the newest session in this directory.",
  },
  args: {
    session: {
      type: "string",
      required: false,
      description: "Claude session id to narrate (default: the newest one for this directory).",
    },
    turn: {
      type: "string",
      required: false,
      description: "Which turn, 1-based as the picker shows them (default: the newest).",
    },
    pick: {
      type: "boolean",
      required: false,
      default: false,
      description:
        "Choose the turn in an fzf picker. Paste a fragment copied off the terminal to find it; matching is exact, ^F makes it fuzzy.",
    },
    find: {
      type: "string",
      required: false,
      description:
        "Open the picker on a fragment of the reply. Paste it here, in quotes, and the line breaks a terminal put through it are ironed out before it is searched for.",
    },
    follow: {
      type: "boolean",
      required: false,
      default: false,
      description:
        "Keep narrating as the reply is written. On by default when the turn is still running — this is what narrating a wall of text that is still arriving means.",
    },
    voice: {
      type: "string",
      required: false,
      default: DEFAULT_NARRATION_VOICE,
      description: `Speech-API voice (default: ${DEFAULT_NARRATION_VOICE}). Not a \`say\` voice: --offline uses the system one.`,
    },
    offline: {
      type: "boolean",
      required: false,
      default: false,
      description:
        "Use macOS `say` and skip the rewrite. Chosen up front for the whole narration, never mid-stream: a voice that changed halfway would sound like a fault.",
    },
    // Declared as `cache`, not `no-cache`, because citty reads `--no-x` as the negation of `x`: an
    // arg literally named "no-cache" is set by `--no-no-cache` and is left alone by `--no-cache`,
    // which quietly sets `cache: false` on an arg that does not exist. The flag on the command line
    // is `--no-cache` either way; this is the declaration that makes it do something.
    cache: {
      type: "boolean",
      required: false,
      default: true,
      description:
        "--no-cache synthesizes everything afresh. For hearing a rewrite-prompt change immediately.",
    },
    root: {
      type: "string",
      required: false,
      description: "Servant root directory (default: ~/.ai_servant). For throwaway/test setups.",
    },
  },
  async run({ args }) {
    applyRootOverride(args.root);

    // Before a word is spoken, and before anything expensive: it is the one moment in a Narration's
    // life when nothing is playing and a few file deletions cost nothing.
    await sweepNarrationCache();

    const session = await resolveSession(args.session);
    const turns = await readTurns(session.jsonlPath);
    if (turns.length === 0) throw new Error(`No turns to narrate in ${session.jsonlPath}.`);

    const turn = await chooseTurn(turns, args);
    // Said out loud, always. A Player narrating the wrong session sounds exactly like one narrating
    // the right session, so the id it locked onto is the only way a mismatch is ever visible.
    console.log(
      `servant: narrating turn ${turn.index + 1}/${turns.length} of session ${session.sessionId}`,
    );

    const held = await playerLockHolder();
    if (held !== null) {
      throw new Error(
        `Another narration is already playing (pid ${held}). Two players means two voices — quit that one first.`,
      );
    }
    const lock = await acquirePlayerLock();
    if (!lock)
      throw new Error("Another narration took the player between the check and the claim.");

    const key = resolveSecret("OPENAI_API_KEY", process.env, await readServantEnv());
    const offline = args.offline || !key;
    const speech: SpeechModel =
      offline || !key
        ? createSaySpeechModel()
        : createOpenAiSpeechModel({ apiKey: key, voice: args.voice });
    // Offline means offline for both hops. Rewriting over the network and then speaking with `say`
    // would be a stranger thing than either: the rewrite is the slower half.
    const model = offline || !key ? undefined : createOpenAiEarCopyModel({ apiKey: key });
    if (offline) {
      console.log(
        key
          ? "servant: --offline — `say` in the system voice, and the rules' own words rather than a rewrite."
          : "servant: no OPENAI_API_KEY — falling back to `say` in the system voice, and the rules' own words.",
      );
    }

    const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
    // Imported here rather than at the top of the file: this is the one module with a native
    // dependency behind it, and every other `servant` command would pay OpenTUI's FFI load at
    // startup for something only a Player on a terminal needs (as `summon` does).
    const terminal = interactive
      ? await (await import("../core/narrate-terminal.ts")).openNarrationTerminal()
      : undefined;

    try {
      // Both halves are late-bound against each other: the view is built on the Player it drives,
      // and the Player publishes its first state while it is still being constructed.
      let view: ReturnType<typeof createNarrationView> | undefined;
      let speakerDied: (message: string) => void = (message) =>
        console.error(`servant narrate: ${message}`);

      const player = createNarrationPlayer({
        events: narrateTurnStream(session.jsonlPath, turn, {
          ...(model ? { model } : {}),
          ...(args.follow ? { follow: true } : {}),
        }),
        speech,
        speaker: createSoxSpeaker({ onLost: (message) => speakerDied(message) }),
        ...(args.cache ? { cache: openNarrationCache(session.sessionId, turn.uuid) } : {}),
        onState: (state) => view?.update(state),
      });

      // A dead `sox` is the one failure the Player cannot see for itself: the position keeps moving
      // and the room is silent. Turned into an ordinary halt, which is a thing on screen with an `r`.
      speakerDied = (message) => player.note(message);

      view = terminal
        ? createNarrationView({
            screen: terminal.screen,
            transport: player,
            title: { sessionId: session.sessionId, turn: turn.index, prompt: turn.prompt },
            width: () => terminal.width(),
          })
        : undefined;
      terminal?.attach((action) => view?.key(action));
      view?.update(player.state());

      process.on("SIGINT", () => void player.stop());

      if (terminal) {
        // The Player stays up at the end of the Narration, so the last paragraph can be heard again
        // without narrating the Turn a second time. `q` is what ends it.
        await player.done;
      } else {
        // No terminal, no Transport, nothing to stay open for: play it and go.
        await waitForEnd(player);
        await player.stop();
      }
    } finally {
      terminal?.close();
      await lock.release();
    }
  },
});

async function resolveSession(id: unknown): Promise<{ sessionId: string; jsonlPath: string }> {
  if (typeof id === "string" && id.length > 0) {
    assertValidSessionId(id);
    const jsonlPath = await findSessionJsonl(id);
    if (!jsonlPath) throw new Error(`No transcript found for session ${id}.`);
    return { sessionId: id, jsonlPath };
  }
  const newest = await newestSessionForCwd(process.cwd());
  if (!newest) {
    throw new Error(
      `No Claude sessions found for ${process.cwd()}. Pass --session <id> to narrate one from elsewhere.`,
    );
  }
  return newest;
}

async function chooseTurn(
  turns: Turn[],
  args: { pick?: boolean; find?: string; turn?: string },
): Promise<Turn> {
  if (args.pick || args.find) {
    const picked = await pickTurn(turns, args.find ? { query: args.find } : {});
    if (!picked) throw new Error("Nothing picked.");
    return picked;
  }
  if (args.turn) {
    const wanted = Number(args.turn);
    const turn = turns[wanted - 1];
    if (!turn) throw new Error(`No turn ${wanted} — this session has ${turns.length}.`);
    return turn;
  }
  const last = turns[turns.length - 1];
  if (!last) throw new Error("No turns to narrate.");
  return last;
}

/**
 * Piped or redirected: play to the end and stop, since there is no keyboard to quit with — and stop
 * at a halt too, because there is also no `r` to answer it with. What halted it is printed, so a
 * narration that ended early says why instead of just being short.
 */
async function waitForEnd(player: { state(): { finished: boolean; halted: string | null } }) {
  for (;;) {
    const state = player.state();
    if (state.finished) return;
    if (state.halted) {
      console.error(`servant narrate: stopped — ${state.halted}`);
      return;
    }
    await Bun.sleep(100);
  }
}
