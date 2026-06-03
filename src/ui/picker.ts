import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLine } from "./prompts.ts";

export type PickerOpts<T> = {
  format: (item: T) => string;
  preview?: (item: T) => string;
  prompt?: string;
  header?: string;
  multi?: boolean;
  // For tests: read input from this stream instead of stdin (numbered fallback path).
  input?: NodeJS.ReadableStream;
  // For tests: write to this stream instead of stderr (numbered fallback path).
  output?: NodeJS.WritableStream;
  // For tests: force a backend instead of auto-detecting.
  backend?: "fzf" | "numbered";
};

function findFzf(): string | null {
  return Bun.which("fzf");
}

let warnedNoFzf = false;
function warnFzfMissing(out: NodeJS.WritableStream): void {
  if (warnedNoFzf) return;
  warnedNoFzf = true;
  out.write(
    [
      "servant: fzf not found on PATH — using basic numbered picker.",
      "         For live fuzzy filtering, arrow nav, and (with --multi) tab-to-toggle:",
      "           brew install fzf",
      "",
    ].join("\n"),
  );
}

async function pickWithFzf<T>(
  items: T[],
  opts: PickerOpts<T>,
  fzfPath: string,
): Promise<T[] | null> {
  // Each line: "<index>\t<display>". --with-nth=2.. hides the index column from the user but we
  // use it to map the selection back to the original item, immune to duplicate display strings.
  const lines = items.map((it, i) => `${i}\t${opts.format(it)}`);

  const args = [
    "--ansi",
    "--height=80%",
    "--layout=reverse",
    "--border",
    "--delimiter=\t",
    "--with-nth=2..",
    `--prompt=${opts.prompt ?? "select"}> `,
  ];
  if (opts.multi) {
    args.push("--multi");
    args.push("--bind=tab:toggle+down,shift-tab:toggle+up,ctrl-a:toggle-all");
  }
  if (opts.header) args.push(`--header=${opts.header}`);

  let previewDir: string | null = null;
  if (opts.preview) {
    // Write each preview to /tmp/<previewDir>/<index>, then have fzf cat by {1}.
    previewDir = await mkdtemp(join(tmpdir(), "servant-picker-"));
    const previewFn = opts.preview;
    await Promise.all(
      items.map((it, i) => Bun.write(join(previewDir as string, String(i)), previewFn(it))),
    );
    args.push(`--preview=cat ${previewDir}/{1}`);
    args.push("--preview-window=right,50%,wrap");
  }

  try {
    const proc = Bun.spawn([fzfPath, ...args], {
      // stdin: pipe so we can feed items.
      // fzf reads keystrokes directly from /dev/tty, so interactivity works even when stdin is
      // piped and stdout is captured.
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    proc.stdin.write(lines.join("\n"));
    await proc.stdin.end();

    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    // 0 = selection made; 1 = no match; 130 = cancelled (ESC / Ctrl-C).
    if (code !== 0) return null;

    const selected: T[] = [];
    for (const line of out.split("\n")) {
      if (!line) continue;
      const key = Number(line.split("\t")[0]);
      if (!Number.isInteger(key) || key < 0 || key >= items.length) continue;
      const item = items[key];
      if (item !== undefined) selected.push(item);
    }
    return selected.length > 0 ? selected : null;
  } finally {
    if (previewDir) await rm(previewDir, { recursive: true, force: true });
  }
}

async function pickNumbered<T>(items: T[], opts: PickerOpts<T>): Promise<T[] | null> {
  const output = opts.output ?? process.stderr;
  const input = opts.input ?? process.stdin;

  if (items.length === 0) return null;

  const lines: string[] = [];
  if (opts.prompt) lines.push(opts.prompt);
  items.forEach((it, i) => {
    lines.push(`  ${i + 1}) ${opts.format(it)}`);
  });
  const help = opts.multi
    ? `Enter selections [1-${items.length}], comma- or space-separated (empty to cancel): `
    : `Enter selection [1-${items.length}] (empty to cancel): `;
  lines.push(help);
  output.write(lines.join("\n"));

  const raw = (await readLine(input)).trim();
  if (!raw) return null;

  if (opts.multi) {
    const tokens = raw.split(/[,\s]+/).filter(Boolean);
    const picks: T[] = [];
    for (const tok of tokens) {
      const n = Number(tok);
      if (!Number.isInteger(n) || n < 1 || n > items.length) return null;
      const it = items[n - 1];
      if (it !== undefined) picks.push(it);
    }
    return picks.length > 0 ? picks : null;
  }

  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > items.length) return null;
  const it = items[n - 1];
  return it !== undefined ? [it] : null;
}

export async function pickFromList<T>(items: T[], opts: PickerOpts<T>): Promise<T | null> {
  // multi defaults to false here so the numbered fallback doesn't ask for comma-separated input
  // for callers that only need one.
  const all = await pickAll(items, opts);
  return all && all.length > 0 ? (all[0] ?? null) : null;
}

export async function pickMultipleFromList<T>(
  items: T[],
  opts: PickerOpts<T>,
): Promise<T[] | null> {
  return pickAll(items, { ...opts, multi: true });
}

async function pickAll<T>(items: T[], opts: PickerOpts<T>): Promise<T[] | null> {
  if (items.length === 0) return null;
  if (items.length === 1 && !opts.multi) return [items[0] as T];

  if (opts.backend === "numbered") return pickNumbered(items, opts);
  const fzfPath = opts.backend === "fzf" ? (findFzf() ?? "fzf") : findFzf();
  if (fzfPath) return pickWithFzf(items, opts, fzfPath);

  warnFzfMissing(opts.output ?? process.stderr);
  return pickNumbered(items, opts);
}
