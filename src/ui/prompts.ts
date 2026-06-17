import { createInterface } from "node:readline";

export function readLine(input: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    // terminal:false disables tty handling — the prompt is already written by the caller.
    const rl = createInterface({ input: input, terminal: false });
    let resolved = false;
    const done = (s: string) => {
      if (resolved) return;
      resolved = true;
      rl.close();
      // Pause the input stream so it doesn't keep the event loop alive (matters for process.stdin).
      if (typeof (input as NodeJS.ReadStream).pause === "function") {
        (input as NodeJS.ReadStream).pause();
      }
      resolve(s);
    };
    rl.once("line", (line) => done(line));
    rl.once("close", () => done(""));
  });
}

export type PromptOpts = {
  default?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
};

export async function promptText(message: string, opts: PromptOpts = {}): Promise<string> {
  const output = opts.output ?? process.stderr;
  const input = opts.input ?? process.stdin;
  const suffix = opts.default !== undefined ? ` [${opts.default}]` : "";
  output.write(`${message}${suffix}: `);
  const raw = (await readLine(input)).trim();
  if (raw) return raw;
  if (opts.default !== undefined) return opts.default;
  return "";
}

export async function confirm(
  message: string,
  defaultYes = false,
  opts: PromptOpts = {},
): Promise<boolean> {
  const yn = defaultYes ? "Y/n" : "y/N";
  const raw = await promptText(`${message} (${yn})`, opts);
  if (!raw) return defaultYes;
  const lower = raw.toLowerCase();
  if (lower === "y" || lower === "yes") return true;
  if (lower === "n" || lower === "no") return false;
  return defaultYes;
}
