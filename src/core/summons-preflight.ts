import { servantEnvPath } from "./paths.ts";
import { resolveSecret } from "./servant-env.ts";

// Preflight for `servant summon`: the two things that must exist before a Summons can open, each
// failing with a message that says what to do next rather than surfacing a socket or spawn error.

/** The audio tool the sox adapter shells out to for both capture and playback. */
export const SUMMONS_AUDIO_TOOL = "sox";

/** Look up an executable on PATH. Injected so preflight is testable without a real PATH. */
export type CommandLookup = (command: string) => string | null;

/**
 * The API key the Realtime socket authenticates with, from the environment or the servant root's
 * `.env`. A ChatGPT subscription does not grant API access, so the message says where the key comes
 * from as well as what it is called — and names both places it can live.
 */
export function requireOpenAiApiKey(
  env: Record<string, string | undefined>,
  fileEnv: Record<string, string>,
): string {
  const key = resolveSecret("OPENAI_API_KEY", env, fileEnv);
  if (!key) {
    throw new Error(
      "servant summon: OPENAI_API_KEY is not set.\n" +
        "  `servant summon` speaks to the OpenAI Realtime API, which needs a platform API key\n" +
        "  (a ChatGPT subscription does not grant API access).\n" +
        "  Create one at https://platform.openai.com/api-keys, then either:\n" +
        "      export OPENAI_API_KEY=sk-...\n" +
        `    or add it to ${servantEnvPath()} as: OPENAI_API_KEY=sk-...`,
    );
  }
  return key;
}

/** The absolute path to `sox`, or a failure that names the install command. */
export function requireAudioTool(lookup: CommandLookup): string {
  const path = lookup(SUMMONS_AUDIO_TOOL);
  if (!path) {
    throw new Error(
      `servant summon: the audio tool \`${SUMMONS_AUDIO_TOOL}\` was not found on PATH.\n` +
        `  \`servant summon\` records and plays audio through ${SUMMONS_AUDIO_TOOL}. Install it with:\n` +
        `      brew install ${SUMMONS_AUDIO_TOOL}`,
    );
  }
  return path;
}
