import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Turn, flatten, haystack } from "../core/narrate-turn.ts";
import { relativeAge } from "./resume-picker.ts";

// Picking the Turn to narrate, by pasting a fragment of it.
//
// Two things about that gesture decide the whole design, and getting either wrong makes the picker
// useless rather than merely worse:
//
//   - Text copied off a terminal is hard-wrapped at the pane width, so a phrase copied out of one
//     paragraph arrives with newlines through the middle of it. fzf's query is a single line and
//     submits at the first newline, so a paste of three wrapped lines searches for the first one
//     and then picks whatever it was on.
//
//     Both sides are flattened, and each side is flattened where it can be. The haystack is
//     flattened here — which is what makes the truncation survivable at all, since the first
//     wrapped line is then still an exact substring of it. The query is flattened wherever it
//     reaches us as text: `--find` hands it in whole, newlines and all, and it arrives as one line.
//     fzf 0.73 offers no hook to normalize what is typed into its own prompt (there is no `paste`
//     event and no `toggle-exact` action — both checked), so pasting straight into the prompt is
//     the case the flattened haystack carries rather than the case we can fix.
//   - The haystack is the whole message body, not a title, because the fragment could be from
//     anywhere in a twelve-paragraph answer. Fuzzy matching across that much text matches nearly
//     everything and ranks a pasted phrase badly, so it is exact by default.

/**
 * Under `--exact`, a leading `'` is fzf's own "make this term fuzzy" prefix — so the toggle is one
 * `transform-query` that adds or removes it. There is no `toggle-exact` action to bind (checked on
 * fzf 0.73), and the trailing-colon form of the bind is used because the shell in it has brackets
 * fzf's parenthesised form would try to balance.
 */
const FUZZY_TOGGLE = `ctrl-f:transform-query:q={q}; case "$q" in \\'*) printf %s "\${q#\\'}";; *) printf "'%s" "$q";; esac`;

export interface PickTurnOptions {
  prompt?: string;
  /** A fragment to open the picker on, flattened first. What `--find` hands over. */
  query?: string;
  /** Injected by the suite. The default spawns the real fzf. */
  run?: (args: string[], input: string) => Promise<{ code: number; stdout: string }>;
}

/**
 * The line fzf sees: a hidden key, what is shown, and everything that is searchable.
 *
 * The key is the Turn's place in the list handed to the picker, not `turn.index`. The list spans
 * sessions and every session numbers its Turns from zero, so the index is not a key at all — two
 * sessions' third replies would both claim to be "2" and the picker would return whichever it
 * found first.
 */
export function turnPickerLine(turn: Turn, at: number): string {
  return `${at}\t${turnLabel(turn)}\t${haystack(turn)}`;
}

/** What is displayed. Short, because the matching is done against the body behind it. */
export function turnLabel(turn: Turn, now: number = Date.now()): string {
  const age = relativeAge(turn.startedAtMs || now, now).padEnd(4);
  const asked = flatten(turn.prompt) || "(no prompt)";
  const words = turn.markdown.split(/\s+/).filter(Boolean).length;
  // The session, because a list that spans them has to say which reply came from where — two
  // sessions in one directory ask each other's questions all the time.
  return `${age}  ${turn.sessionId.slice(0, 8)}  ${asked.slice(0, 62).padEnd(62)}  ${String(words).padStart(5)} words`;
}

export async function pickTurn(turns: Turn[], options: PickTurnOptions = {}): Promise<Turn | null> {
  if (turns.length === 0) return null;
  const run = options.run ?? runFzf;
  const previews = await mkdtemp(join(tmpdir(), "servant-narrate-pick-"));
  try {
    await Promise.all(
      turns.map((turn, at) => Bun.write(join(previews, String(at)), preview(turn))),
    );
    const { code, stdout } = await run(
      [
        "--exact",
        "--delimiter=\t",
        // Shown: the label. Searched: the label and the whole body behind it.
        "--with-nth=2",
        "--nth=2..",
        `--bind=${FUZZY_TOGGLE}`,
        `--preview=cat ${previews}/{1}`,
        "--preview-window=right,55%,wrap",
        ...(options.query ? [`--query=${flatten(options.query)}`] : []),
        `--prompt=${options.prompt ?? "narrate> "}`,
        "--header=paste a fragment of the reply · ^F fuzzy · every session in this directory",
        "--height=90%",
        "--layout=reverse",
        "--border",
      ],
      turns.map(turnPickerLine).join("\n"),
    );
    if (code !== 0) return null;
    const chosen = stdout.split("\n").find((line) => line.length > 0);
    return turns[Number(chosen?.split("\t")[0])] ?? null;
  } finally {
    await rm(previews, { recursive: true, force: true });
  }
}

function preview(turn: Turn): string {
  const where = `session ${turn.sessionId} · turn ${turn.index + 1}`;
  return `${where}\n\n${turn.prompt}\n${"─".repeat(40)}\n${turn.markdown}\n`;
}

async function runFzf(args: string[], input: string): Promise<{ code: number; stdout: string }> {
  const fzf = Bun.which("fzf");
  if (!fzf) {
    throw new Error(
      "fzf is required to pick a turn interactively. Install it (e.g. `brew install fzf`), or pass --turn.",
    );
  }
  const proc = Bun.spawn([fzf, ...args], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  void proc.stdin.write(input);
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  return { code: await proc.exited, stdout };
}
