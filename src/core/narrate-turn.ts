import { readJsonlLines } from "./claude-session.ts";

// A Turn, off the transcript and into markdown the Ear-copy pipeline can take.
//
// This is the one module in the feature that knows what a Claude transcript looks like. The pipeline
// next door takes markdown and nothing else, which is what keeps `cat README.md | servant narrate -`
// an entry point rather than a rewrite (ticket #1's handoff).
//
// A Turn is every assistant entry since the last thing the *user* actually said (workspace
// CONTEXT.md). That qualifier is the whole difficulty: a tool result comes back as an entry of type
// "user", so the obvious reading of "since the last user message" cuts a Turn into one fragment per
// tool call and narrates the last two sentences of a twelve-paragraph answer.

/** One answer as it appears on screen, ready to narrate. */
export interface Turn {
  /** Which session it was said in. Part of a Turn's identity, and half of its cache path. */
  sessionId: string;
  /**
   * The session's tab name, when it has one — what a person calls it, rather than what the
   * filesystem does. A uuid prefix identifies a session and tells you nothing about it, and the
   * picker's whole job is to be read.
   */
  sessionName: string;
  jsonlPath: string;
  /** The first assistant entry's uuid — stable across the Turn growing, so it keys the cache. */
  uuid: string;
  /** 0-based position in the session. What `servant narrate --turn 3` means. */
  index: number;
  /** What was asked. The Player prints it, so you can hear which answer you are about to hear. */
  prompt: string;
  /**
   * Narratable markdown, in the pieces it was folded from: text blocks as written, tool calls as
   * beats, thinking dropped.
   *
   * Kept as pieces and not only as the joined string, because a follower has to know what it has
   * already narrated and re-splitting the join on blank lines is not the same question. A text
   * block can contain blank lines of its own — inside a fenced code block, most obviously — and
   * splitting there would hand the pipeline half a fence.
   */
  blocks: readonly string[];
  /** The pieces, joined. What the pipeline is handed. */
  markdown: string;
  startedAtMs: number;
  /** Assistant entries folded in so far. What tells a follower that the Turn has grown. */
  entries: number;
  /** False while the Turn is still being written — the case this feature actually exists for. */
  complete: boolean;
}

interface Entry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  origin?: { kind?: string };
  customTitle?: string;
  message?: { role?: string; content?: unknown; stop_reason?: string | null };
}

interface ContentBlock {
  type?: string;
  text?: unknown;
  name?: unknown;
}

/**
 * Every Turn in a transcript, oldest first.
 *
 * Sidechains are another agent's conversation happening inside this one, and meta entries are the
 * harness talking to itself. Neither is on screen as part of the answer, so neither is narrated.
 */
export async function readTurns(jsonlPath: string): Promise<Turn[]> {
  const turns: Turn[] = [];
  const sessionId = sessionIdOf(jsonlPath);
  let prompt = "";
  let open: Entry[] = [];
  // Renaming a tab appends another one of these, so the last is the name it goes by now.
  let sessionName = "";

  const close = (): void => {
    if (open.length === 0) return;
    const turn = buildTurn(open, prompt, turns.length, sessionId, jsonlPath);
    if (turn) turns.push(turn);
    open = [];
  };

  for await (const record of readJsonlLines(jsonlPath)) {
    const entry = record as Entry;
    if (entry.type === "custom-title" && typeof entry.customTitle === "string") {
      sessionName = entry.customTitle;
    }
    if (entry.isSidechain) continue;
    if (entry.type === "user" && !entry.isMeta && isSpokenByTheUser(entry)) {
      close();
      prompt = flatten(textOf(entry));
      continue;
    }
    if (entry.type === "assistant") open.push(entry);
  }
  close();
  // Stamped after the sweep rather than during it: a tab named halfway through a session is still
  // that session's name for the Turns before it.
  return turns.map((turn) => ({ ...turn, sessionName }));
}

/** The newest Turn, which is what a bare `servant narrate` means. */
export async function latestTurn(jsonlPath: string): Promise<Turn | null> {
  const turns = await readTurns(jsonlPath);
  return turns[turns.length - 1] ?? null;
}

export interface FollowOptions {
  /** How often to look for new entries. Cheap: the file is read, not parsed incrementally. */
  pollMs?: number;
  /** Injected by the suite, so following a growing Turn is tested without waiting for one. */
  wait?: (ms: number) => Promise<void>;
  /** Stop following, whatever the Turn is doing. */
  signal?: AbortSignal;
}

/**
 * Follow a Turn as it is written, yielding only what is new each time.
 *
 * This is the actual use case — the wall of text is still arriving and you have already stopped
 * reading it — and it is only possible because entries land on block completion. There is no
 * half-written sentence to guard against: an entry that exists is final, so what has not been
 * yielded yet is exactly what has appeared since the last look.
 *
 * Yields markdown, block-aligned, which the pipeline can be handed as a continuation.
 */
export async function* followTurn(
  jsonlPath: string,
  turnUuid: string,
  options: FollowOptions = {},
): AsyncGenerator<string> {
  const pollMs = options.pollMs ?? 250;
  const wait = options.wait ?? ((ms: number) => Bun.sleep(ms));
  let emitted = 0;

  while (!options.signal?.aborted) {
    const turn = (await readTurns(jsonlPath)).find((candidate) => candidate.uuid === turnUuid);
    if (!turn) return;
    if (turn.blocks.length > emitted) {
      yield turn.blocks.slice(emitted).join(BLOCK_SEPARATOR);
      emitted = turn.blocks.length;
    }
    if (turn.complete) return;
    await wait(pollMs);
  }
}

const BLOCK_SEPARATOR = "\n\n";

/**
 * Everything a Turn is worth searching by, on one line.
 *
 * Applied to the haystack *and* to what is pasted in, which is the only thing that makes the picker
 * work: text copied off a terminal is hard-wrapped at the pane width, so a phrase copied out of one
 * paragraph comes back with newlines through the middle of it — and fzf's query is a single line
 * that submits at the first one.
 */
export function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** What the picker matches against: the question and the whole answer, flattened together. */
export function haystack(turn: Turn): string {
  return flatten(`${turn.prompt} ${turn.markdown}`);
}

/** A transcript is named for its session, so the id is in the path and nowhere in the entries. */
export function sessionIdOf(jsonlPath: string): string {
  return (jsonlPath.split("/").pop() ?? "").replace(/\.jsonl$/, "");
}

function buildTurn(
  entries: Entry[],
  prompt: string,
  index: number,
  sessionId: string,
  jsonlPath: string,
): Turn | null {
  const uuid = entries.find((entry) => typeof entry.uuid === "string")?.uuid;
  if (!uuid) return null;
  const blocks = foldEntries(entries);
  const markdown = blocks.join(BLOCK_SEPARATOR);
  if (!markdown.trim()) return null;
  const startedAt = entries.find((entry) => entry.timestamp)?.timestamp;
  return {
    sessionId,
    sessionName: "",
    jsonlPath,
    uuid,
    index,
    prompt,
    blocks,
    markdown,
    startedAtMs: startedAt ? Date.parse(startedAt) : 0,
    entries: entries.length,
    complete: isFinished(entries[entries.length - 1]),
  };
}

/**
 * A Turn's entries as narratable markdown.
 *
 * Text is passed through untouched — deciding what is speakable is the pipeline's job, and doing
 * any of it here would put the same rules in two places. Tool calls become one beat per run, so
 * eleven Bash calls are a clause rather than eleven clauses. Thinking is dropped, because it is
 * collapsed on screen too and narrating it would describe a screen the listener is not looking at.
 */
function foldEntries(entries: Entry[]): string[] {
  const chunks: string[] = [];
  let tools: string[] = [];

  const flushTools = (): void => {
    if (tools.length === 0) return;
    chunks.push(toolBeat(tools, chunks.length === 0));
    tools = [];
  };

  for (const entry of entries) {
    for (const block of blocksOf(entry)) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        flushTools();
        chunks.push(block.text.trim());
      }
      if (block.type === "tool_use" && typeof block.name === "string") tools.push(block.name);
    }
  }
  flushTools();
  return chunks;
}

/** How a tool run is described. Grouped, because the listener wants the shape and not the log. */
const TOOL_VERBS: Record<string, { verb: string; noun: string }> = {
  Bash: { verb: "ran", noun: "command" },
  BashOutput: { verb: "ran", noun: "command" },
  Read: { verb: "read", noun: "file" },
  NotebookEdit: { verb: "edited", noun: "file" },
  Edit: { verb: "edited", noun: "file" },
  Write: { verb: "wrote", noun: "file" },
  Grep: { verb: "ran", noun: "search" },
  Glob: { verb: "ran", noun: "search" },
  WebFetch: { verb: "looked up", noun: "page" },
  WebSearch: { verb: "ran", noun: "web search" },
  Task: { verb: "sent out", noun: "agent" },
  Agent: { verb: "sent out", noun: "agent" },
  Skill: { verb: "loaded", noun: "skill" },
  TodoWrite: { verb: "updated", noun: "plan" },
};

/**
 * One run of tool calls as one clause: "then ran four commands and read two files".
 *
 * Counted by what the call *did* rather than by tool name, since "ran a Grep and a Glob" tells a
 * listener nothing they can use. The lead beat of a Turn drops the "then", which otherwise opens a
 * Narration by referring back to nothing.
 */
export function toolBeat(names: readonly string[], leading = false): string {
  const groups = new Map<string, { verb: string; noun: string; count: number }>();
  for (const name of names) {
    const known = TOOL_VERBS[name] ?? { verb: "used", noun: describeUnknown(name) };
    const key = `${known.verb} ${known.noun}`;
    const seen = groups.get(key);
    if (seen) seen.count += 1;
    else groups.set(key, { ...known, count: 1 });
  }
  const clauses = [...groups.values()].map(
    ({ verb, noun, count }) =>
      `${verb} ${count === 1 ? `${article(noun)} ${noun}` : `${number(count)} ${plural(noun)}`}`,
  );
  const joined = joinWithAnd(clauses);
  return leading ? `${capitalize(joined)}.` : `Then ${joined}.`;
}

/** "an agent", not "a agent". Spoken text, so the article is heard and a wrong one is jarring. */
function article(noun: string): string {
  return /^[aeiou]/i.test(noun) ? "an" : "a";
}

/** "searches", not "searchs". The nouns above are ordinary English; the sibilant rule covers them. */
function plural(noun: string): string {
  return /(s|x|z|ch|sh)$/i.test(noun) ? `${noun}es` : `${noun}s`;
}

/** A tool nobody taught this module about, said as words rather than as its CamelCase name. */
function describeUnknown(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return `${words} tool`;
}

/** Small numbers as words. Nothing is wrong with "12", but "four commands" is what a person says. */
const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

function number(count: number): string {
  return WORDS[count] ?? String(count);
}

function joinWithAnd(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function blocksOf(entry: Entry): ContentBlock[] {
  const content = entry.message?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content as ContentBlock[];
}

/**
 * Kinds of "user" entry that are not the user.
 *
 * A background task reporting back arrives as an ordinary user message with ordinary text in it,
 * and reading it as a prompt cuts one answer in half — the Player would offer you the tail of a
 * reply as though it were its own, labelled with a chunk of XML as the question that prompted it.
 *
 * Surveyed across every transcript on this machine: `origin.kind` is "human" (1617), or
 * "task-notification" (439), or absent (782, on older transcripts). So this names what to exclude
 * rather than what to allow — an entry that says nothing about where it came from is the user,
 * which is what it was before the field existed.
 */
const NOT_THE_USER = new Set(["task-notification"]);

/**
 * Whether a "user" entry is the user. A tool result wears the same type, and reading it as a new
 * prompt is what splits one answer into a dozen Turns.
 */
function isSpokenByTheUser(entry: Entry): boolean {
  if (entry.origin?.kind && NOT_THE_USER.has(entry.origin.kind)) return false;
  const content = entry.message?.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) =>
      (block as ContentBlock)?.type === "text" &&
      typeof (block as ContentBlock).text === "string" &&
      String((block as ContentBlock).text).trim().length > 0,
  );
}

function textOf(entry: Entry): string {
  return blocksOf(entry)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join(" ");
}

/**
 * A Turn is over when its last entry stopped for a reason other than wanting a tool. An entry that
 * is still the tail of a running Turn says `tool_use`, and one that has not said anything yet says
 * nothing at all — both mean "more is coming".
 */
function isFinished(entry: Entry | undefined): boolean {
  const reason = entry?.message?.stop_reason;
  return typeof reason === "string" && reason !== "tool_use";
}
