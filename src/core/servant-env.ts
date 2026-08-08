import { servantEnvPath } from "./paths.ts";

// Secrets for servant itself, kept at the servant root rather than exported from the user's shell
// profile into every process on the machine. Bun auto-loads `.env` from the *current working
// directory* only and does not walk up — and servant commands run with cwd set to a workspace — so
// the root `.env` has to be read explicitly. Resolving it from the root means `--root` redirects it
// like every other piece of servant state.

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/s.exec(value);
  return quoted?.[2] ?? value;
}

/**
 * Parse `.env` text into a plain map. Lines it cannot read are skipped rather than thrown on: a
 * stray line should cost the user that one variable, not the whole command.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = LINE.exec(line);
    if (match?.[1]) out[match[1]] = unquote(match[2] ?? "");
  }
  return out;
}

/** The servant root's `.env`, or an empty map when there isn't one. */
export async function readServantEnv(): Promise<Record<string, string>> {
  const file = Bun.file(servantEnvPath());
  if (!(await file.exists())) return {};
  try {
    return parseEnvFile(await file.text());
  } catch {
    return {};
  }
}

/**
 * A secret's value, preferring the real environment so an inline `KEY=… servant …` still wins. A
 * blank environment variable counts as absent — it is a gap to fill, not a deliberate empty value.
 */
export function resolveSecret(
  name: string,
  env: Record<string, string | undefined>,
  fileEnv: Record<string, string>,
): string | undefined {
  const fromEnv = env[name]?.trim();
  if (fromEnv) return fromEnv;
  return fileEnv[name]?.trim() || undefined;
}
