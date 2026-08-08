import { isAbsolute, join, relative, resolve } from "node:path";
import { SUMMONS_IGNORED_DIRS, walkScopeFiles } from "./summons-files.ts";
import type { WorkspaceReader } from "./summons.ts";

// The Summons agent's local reads, confined to the session's scope root. Everything here is
// read-only by construction — there is no counterpart that writes (workspace ADR 0009).

// Caps: the agent speaks its answers, so a huge file or a thousand hits helps nobody, and each
// result is round-tripped through the Realtime socket.
const MAX_FILE_BYTES = 200_000;
const MAX_GLOB_MATCHES = 200;
const MAX_GREP_MATCHES = 60;
const MAX_LINE_CHARS = 300;

/** Keep a model-supplied path inside the session's scope — `--repo` is a boundary, not a hint. */
function confine(root: string, path: string): string {
  const base = resolve(root);
  const full = resolve(base, path);
  const rel = relative(base, full);
  if (rel.startsWith("..") || isAbsolute(path)) {
    throw new Error(`"${path}" is outside this session's scope.`);
  }
  return full;
}

export function createWorkspaceReader(root: string): WorkspaceReader {
  return {
    async readFile(path) {
      const file = Bun.file(confine(root, path));
      if (!(await file.exists())) throw new Error(`No such file: ${path}`);
      const text = await file.text();
      return text.length > MAX_FILE_BYTES ? `${text.slice(0, MAX_FILE_BYTES)}\n…(truncated)` : text;
    },

    async glob(pattern) {
      const matches: string[] = [];
      for await (const path of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
        if (path.split("/").some((segment) => SUMMONS_IGNORED_DIRS.has(segment))) continue;
        matches.push(path);
        if (matches.length >= MAX_GLOB_MATCHES) break;
      }
      return matches.toSorted();
    },

    async grep(pattern, options) {
      let re: RegExp;
      try {
        re = new RegExp(pattern, "i");
      } catch {
        throw new Error(`"${pattern}" is not a valid regular expression.`);
      }
      const narrow = options.glob ? new Bun.Glob(options.glob) : null;
      const hits: string[] = [];
      for (const rel of await walkScopeFiles(root)) {
        if (hits.length >= MAX_GREP_MATCHES) break;
        if (narrow && !narrow.match(rel)) continue;
        const file = Bun.file(join(root, rel));
        if (file.size > MAX_FILE_BYTES) continue;
        let text: string;
        try {
          text = await file.text();
        } catch {
          continue; // binary or unreadable — not something the agent can talk about anyway
        }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length && hits.length < MAX_GREP_MATCHES; i++) {
          const line = lines[i] ?? "";
          if (re.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, MAX_LINE_CHARS)}`);
        }
      }
      return hits;
    },
  };
}
