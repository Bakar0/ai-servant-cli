// What the viewer draws, computed here rather than in the browser.
//
// The prototype (branch `prototype/map-view`, variant B) worked out the layout rules in client-side
// JavaScript; every one of them is arithmetic over the board, so it lives in TypeScript where it can
// be asserted against a real database. What ships to the page is a finished view model, and the page
// paints it — which is also what makes an SSE push a re-render rather than a diff protocol.
//
// Depth comes from `openBlockerDepths()` and is never recomputed here. That is the whole reason the
// first tree column cannot disagree with `servant tasks --frontier`: both narrow the same set by the
// same predicate, so the agreement is structural rather than a pair of implementations kept in step.

import { blockerLabel } from "../tasks.ts";
import type { ClaimLiveness } from "../tasks.ts";
import { computeFrontier } from "../tasks.ts";
import type { Ticket, TicketStatus } from "./store.ts";
import { isOpenStatus, listTickets, openBlockerDepths, sessionLastSeen } from "./store.ts";

/**
 * The five board columns. `blocked` and `ready` are derived from open dependencies and are
 * deliberately absent from `TicketStatus` — a stored "ready" could disagree with the graph.
 */
export type BoardColumn = "blocked" | "ready" | "in_progress" | "in_review" | "done";

export const BOARD_COLUMNS: readonly { key: BoardColumn; label: string }[] = [
  { key: "blocked", label: "Blocked" },
  { key: "ready", label: "Ready" },
  { key: "in_progress", label: "In progress" },
  { key: "in_review", label: "In review" },
  { key: "done", label: "Done" },
];

/**
 * A ticket's kind, from its `wayfinder:<type>` label. Plain tickets read as tasks.
 *
 * `map` is in here even though it is not a child type: the map is a ticket on the board like any
 * other, so it appears in the tree, and a card that looked like an ordinary task would invite
 * someone to dispatch a session at the map itself.
 */
export type WayfinderType = "task" | "research" | "prototype" | "grilling" | "map";

const WAYFINDER_TYPES = new Set<string>(["task", "research", "prototype", "grilling", "map"]);

export const MAP_LABEL = "wayfinder:map";

/** How a blocker is named on a card. Qualified only when the edge leaves the board. */
export interface BlockerRef {
  seq: number;
  workspace: string;
  label: string;
  /** False when the blocker sits on another board, so the tree has no node to draw an edge from. */
  onBoard: boolean;
}

export interface ClaimView {
  session: string;
  since: string;
  /** From the last-seen projection, which is a cache — `state` is what liveness actually says. */
  lastSeen: string | null;
  age: string | null;
  state: "alive" | "gone" | "unknown";
}

export interface CardView {
  seq: number;
  title: string;
  status: TicketStatus;
  column: BoardColumn;
  type: WayfinderType;
  /** Open-blocker depth: 0 is the frontier, `null` is done and receded. */
  depth: number | null;
  /** Position within a tree column, grouping a fan's children together. */
  order: number;
  claim: ClaimView | null;
  openBlockers: BlockerRef[];
  /** Seqs on this board waiting on this card. */
  blocks: number[];
  /** Set only when this card is a fan — a blocker feeding two or more tickets. */
  fanColor: string | null;
  /** The card's left border: its own fan colour, else the colour of the edge that reaches it. */
  stripe: string;
  /**
   * The command that dispatches this ticket, ready to paste. Null on a blocked or claimed ticket:
   * the board holds no queue and starts no process (ADR-0011 decision 7), so the one thing it must
   * not do is offer a dispatch that would collide with a session already carrying the work.
   */
  dispatch: string | null;
  url: string;
}

export interface TreeColumn {
  label: string;
  /** Null on the receded Done column, which is not a depth. */
  depth: number | null;
  seqs: number[];
}

export interface EdgeView {
  from: number;
  to: number;
  color: string;
  /** True when the blocker fans out to 2+ tickets — the only case colour is allowed to mean. */
  fan: boolean;
}

export interface FanView {
  seq: number;
  color: string;
  count: number;
}

/** The wayfinder map's prose, which frames the canvas rather than sitting in it. */
export interface MapView {
  seq: number;
  title: string;
  destination: string;
  outOfScope: string;
  /** "Not yet specified" — the edge of the map, rendered as fog. */
  fog: string[];
  decisions: string[];
  url: string;
}

export interface BoardView {
  workspace: string;
  generatedAt: string;
  map: MapView | null;
  cards: CardView[];
  tree: TreeColumn[];
  columns: { key: BoardColumn; label: string; seqs: number[] }[];
  edges: EdgeView[];
  fans: FanView[];
  /** Every seq reachable up or down the dependency graph from each seq, precomputed for hover. */
  chains: Record<string, number[]>;
  /** False when this host could not read the session registry — claims then read as "unknown". */
  livenessKnown: boolean;
}

/**
 * Fan hues. Six because a seventh fan on one board is past the point where colour is doing the
 * grouping work anyway, and the cycle is more honest than an unreadable near-duplicate.
 */
const FAN_HUES = ["#e0704f", "#48a6c9", "#c58ae0", "#8fbf4a", "#e0b040", "#4fc0a0"];
const NEUTRAL_EDGE = "#39405a";
const NO_STRIPE = "var(--line)";

const DEPTH_LABELS = ["Now", "Next", "Then", "Later"];

function depthLabel(depth: number): string {
  return DEPTH_LABELS[depth] ?? `+${depth}`;
}

function wayfinderType(labels: readonly string[]): WayfinderType {
  for (const label of labels) {
    const suffix = label.startsWith("wayfinder:") ? label.slice("wayfinder:".length) : null;
    if (suffix && WAYFINDER_TYPES.has(suffix)) return suffix as WayfinderType;
  }
  return "task";
}

/**
 * How long ago, at the coarseness the question deserves: whether a session is still there is a
 * "minutes or days" question, and a seconds column would imply a precision the projection lacks.
 */
export function formatAge(iso: string, nowIso: string): string | null {
  const then = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(then) || Number.isNaN(now)) return null;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * POSIX single-quoting, skipped where it would only add noise — this string is read by a human
 * before it is run, and `--ws 'kanban'` is worse to read than `--ws kanban`.
 *
 * Not `JSON.stringify`: that escapes for JSON, and a double-quoted shell word still interpolates
 * `$` and backticks — a ticket title containing either would run as a command.
 */
function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The command that puts a session on this ticket, as a single line that runs as-is.
 *
 * Two commands rather than one because `servant spawn` deliberately does not write Claims — without
 * the `servant claim`, the spawned session carries a ticket the frontier still reports as free.
 */
export function dispatchCommand(workspace: string, seq: number, title: string): string {
  const session = `${workspace}-t${seq}`;
  const prompt =
    `Run /implement #${seq} — "${title}" — on the ${workspace} board. ` +
    "Follow its acceptance criteria, drive /tdd at the seams, and close with /code-review " +
    "before committing.";
  return (
    `servant claim ${seq} --ws ${shellQuote(workspace)} --session ${shellQuote(session)} && ` +
    `servant spawn -w ${shellQuote(workspace)} --prompt ${shellQuote(prompt)}`
  );
}

/**
 * Split a wayfinder map body into its `## ` sections.
 *
 * Tolerant on purpose: the map is prose a human and an agent both edit, so a missing section is an
 * empty one rather than a parse failure that would blank the whole frame.
 */
export function splitSections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let heading: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (heading !== null) out.set(heading.toLowerCase(), buffer.join("\n").trim());
  };
  for (const line of body.split(/\r?\n/)) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match?.[1]) {
      flush();
      heading = match[1];
      buffer = [];
    } else if (heading !== null) {
      buffer.push(line);
    }
  }
  flush();
  return out;
}

/** The section's content lines. The `<!-- -->` guidance in the map template is not content. */
function contentLines(section: string | undefined): string[] {
  if (!section) return [];
  return section
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function bullets(section: string | undefined): string[] {
  return contentLines(section)
    .map((line) => /^[-*]\s+(.*)$/.exec(line)?.[1]?.trim() ?? "")
    .filter(Boolean);
}

function prose(section: string | undefined): string {
  return contentLines(section).join(" ");
}

function toMapView(ticket: Ticket): MapView {
  const sections = splitSections(ticket.body);
  const fogSection = sections.get("not yet specified");
  const fogBullets = bullets(fogSection);
  return {
    seq: ticket.seq,
    title: ticket.title,
    destination: prose(sections.get("destination")),
    outOfScope: prose(sections.get("out of scope")),
    // A fog patch is coarser than a ticket, so it is written as prose as often as as a list; falling
    // back to the paragraph keeps the edge of the map visible either way.
    fog: fogBullets.length > 0 ? fogBullets : prose(fogSection) ? [prose(fogSection)] : [],
    decisions: bullets(sections.get("decisions so far")),
    url: ticket.url,
  };
}

export interface BuildViewOptions {
  now?: string;
  /** Injected so the view is asserted without a process table. Defaults to "could not look". */
  liveness?: ClaimLiveness;
}

/**
 * The whole view model for one board.
 *
 * Reads every ticket, not just this workspace's: a blocker on another board is still a blocker, and
 * narrowing first would show a cross-board dependency as satisfied because it was not in the set.
 */
export function buildBoardView(workspace: string, opts: BuildViewOptions = {}): BoardView {
  const now = opts.now ?? new Date().toISOString();
  const liveness = opts.liveness ?? { known: false };
  const all = listTickets();
  const byId = new Map(all.map((t) => [t.id, t]));
  const openIds = new Set(all.filter((t) => isOpenStatus(t.status)).map((t) => t.id));
  const depths = openBlockerDepths(workspace);
  const frontier = computeFrontier(all, liveness, { workspace });

  const mine = all.filter((t) => t.workspace === workspace);
  const onBoard = new Map(mine.map((t) => [t.id, t]));

  // A fan is counted over this board's edges only: an off-board dependent has no node here, so
  // colouring for it would promise a group the reader cannot see.
  const dependents = new Map<number, number[]>();
  for (const ticket of mine) {
    for (const blockerId of ticket.blockedBy) {
      if (!onBoard.has(blockerId)) continue;
      const list = dependents.get(blockerId);
      if (list) list.push(ticket.id);
      else dependents.set(blockerId, [ticket.id]);
    }
  }
  const fanColor = new Map<number, string>();
  [...dependents.entries()]
    .filter(([, kids]) => kids.length >= 2)
    .toSorted((a, b) => b[1].length - a[1].length || a[0] - b[0])
    .forEach(([id], i) => fanColor.set(id, FAN_HUES[i % FAN_HUES.length] as string));

  const edgeColor = (blockerId: number) => fanColor.get(blockerId) ?? NEUTRAL_EDGE;
  // The blocker a card is drawn beneath. Prefer a fan so a group's children take its colour;
  // otherwise the first edge, which is at least stable.
  const primaryBlocker = (ticket: Ticket): number | undefined =>
    ticket.blockedBy.find((id) => onBoard.has(id) && fanColor.has(id)) ??
    ticket.blockedBy.find((id) => onBoard.has(id));

  const order = orderCards(mine, depths, primaryBlocker);

  // The frontier is the authority on what is dispatchable, so the card reads it rather than
  // re-deriving "unblocked and free" — that second derivation is exactly the drift the derived
  // columns exist to prevent.
  const readySeqs = new Set(frontier.ready.map((t) => t.seq));

  const cards = mine
    .map((ticket) =>
      toCard({
        ticket,
        byId,
        openIds,
        depths,
        order,
        fanColor,
        edgeColor,
        primaryBlocker,
        readySeqs,
        now,
      }),
    )
    .toSorted((a, b) => a.order - b.order);

  const cardsBySeq = new Map(cards.map((c) => [c.seq, c]));
  const tree = buildTree(cards);
  const columns = BOARD_COLUMNS.map(({ key, label }) => ({
    key,
    label,
    seqs: cards.filter((c) => c.column === key).map((c) => c.seq),
  }));

  const edges: EdgeView[] = [];
  for (const ticket of mine) {
    for (const blockerId of ticket.blockedBy) {
      const blocker = onBoard.get(blockerId);
      if (!blocker) continue;
      edges.push({
        from: blocker.seq,
        to: ticket.seq,
        color: edgeColor(blockerId),
        fan: fanColor.has(blockerId),
      });
    }
  }

  const fans: FanView[] = [...fanColor.entries()]
    .map(([id, color]) => ({
      seq: onBoard.get(id)?.seq ?? 0,
      color,
      count: dependents.get(id)?.length ?? 0,
    }))
    .filter((f) => f.seq > 0)
    .toSorted((a, b) => b.count - a.count || a.seq - b.seq);

  const mapTicket = mine.find((t) => t.labels.includes(MAP_LABEL));

  // Liveness likewise comes from the frontier, which owns the PID check — not repeated here
  // (ADR-0011 decision 3).
  const staleSeqs = new Set(frontier.stale.map((c) => c.ticket.seq));
  const aliveSeqs = new Set(
    frontier.inFlight.filter((c) => c.liveness === "alive").map((c) => c.ticket.seq),
  );
  for (const card of cards) {
    if (!card.claim) continue;
    card.claim.state = aliveSeqs.has(card.seq)
      ? "alive"
      : staleSeqs.has(card.seq)
        ? "gone"
        : "unknown";
  }

  return {
    workspace,
    generatedAt: now,
    map: mapTicket ? toMapView(mapTicket) : null,
    cards,
    tree,
    columns,
    edges,
    fans,
    chains: buildChains(edges, [...cardsBySeq.keys()]),
    livenessKnown: liveness.known,
  };
}

/**
 * Position within a tree column, ordered by the blocker a card hangs off.
 *
 * Barycentre by primary blocker: a fan's children end up adjacent instead of scattered down the
 * column, which is what stops the edges crossing into an unreadable braid.
 */
function orderCards(
  mine: readonly Ticket[],
  depths: Map<number, number | null>,
  primaryBlocker: (t: Ticket) => number | undefined,
): Map<number, number> {
  const order = new Map<number, number>();
  const done = mine.filter((t) => depths.get(t.id) === null).toSorted((a, b) => a.seq - b.seq);
  done.forEach((t, i) => order.set(t.id, i));
  const open = mine.filter((t) => typeof depths.get(t.id) === "number");
  const maxDepth = open.reduce((max, t) => Math.max(max, depths.get(t.id) as number), 0);
  for (let depth = 0; depth <= maxDepth; depth++) {
    const here = open
      .filter((t) => depths.get(t.id) === depth)
      .toSorted((a, b) => {
        const pa = primaryBlocker(a);
        const pb = primaryBlocker(b);
        const ka = pa === undefined ? -1 : (order.get(pa) ?? 0);
        const kb = pb === undefined ? -1 : (order.get(pb) ?? 0);
        return ka - kb || (pa ?? 0) - (pb ?? 0) || a.seq - b.seq;
      });
    here.forEach((t, i) => order.set(t.id, (depth + 1) * 1000 + i));
  }
  return order;
}

function buildTree(cards: readonly CardView[]): TreeColumn[] {
  const doneSeqs = cards.filter((c) => c.depth === null).map((c) => c.seq);
  const open = cards.filter((c) => c.depth !== null);
  const maxDepth = open.reduce((max, c) => Math.max(max, c.depth as number), 0);
  // Done leads, receded, at the far left — the direction work migrates as blockers close.
  const columns: TreeColumn[] = [{ label: "Done", depth: null, seqs: doneSeqs }];
  for (let depth = 0; depth <= maxDepth; depth++) {
    columns.push({
      label: depthLabel(depth),
      depth,
      seqs: open.filter((c) => c.depth === depth).map((c) => c.seq),
    });
  }
  return columns;
}

/** Every seq up-chain or down-chain of each seq. Precomputed so hover is a lookup, not a walk. */
function buildChains(
  edges: readonly EdgeView[],
  seqs: readonly number[],
): Record<string, number[]> {
  const up = new Map<number, number[]>();
  const down = new Map<number, number[]>();
  const link = (graph: Map<number, number[]>, from: number, to: number) => {
    const list = graph.get(from);
    if (list) list.push(to);
    else graph.set(from, [to]);
  };
  for (const edge of edges) {
    link(up, edge.to, edge.from);
    link(down, edge.from, edge.to);
  }
  const walk = (start: number, graph: Map<number, number[]>, into: Set<number>) => {
    const stack = [...(graph.get(start) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop() as number;
      if (into.has(next)) continue;
      into.add(next);
      stack.push(...(graph.get(next) ?? []));
    }
  };
  const out: Record<string, number[]> = {};
  for (const seq of seqs) {
    const chain = new Set<number>();
    walk(seq, up, chain);
    walk(seq, down, chain);
    chain.delete(seq);
    out[String(seq)] = [...chain].toSorted((a, b) => a - b);
  }
  return out;
}

function toCard(ctx: {
  ticket: Ticket;
  byId: Map<number, Ticket>;
  openIds: Set<number>;
  depths: Map<number, number | null>;
  order: Map<number, number>;
  fanColor: Map<number, string>;
  edgeColor: (id: number) => string;
  primaryBlocker: (t: Ticket) => number | undefined;
  readySeqs: Set<number>;
  now: string;
}): CardView {
  const { ticket, byId, openIds, depths, order, fanColor, edgeColor, primaryBlocker } = ctx;
  const openBlockers: BlockerRef[] = ticket.blockedBy
    .filter((id) => openIds.has(id))
    .map((id) => byId.get(id))
    .filter((t): t is Ticket => t !== undefined)
    .map((blocker) => ({
      seq: blocker.seq,
      workspace: blocker.workspace,
      label: blockerLabel(blocker, ticket),
      onBoard: blocker.workspace === ticket.workspace,
    }));

  const column: BoardColumn =
    ticket.status === "done"
      ? "done"
      : ticket.status === "in_review"
        ? "in_review"
        : ticket.status === "in_progress"
          ? "in_progress"
          : openBlockers.length > 0
            ? "blocked"
            : "ready";

  const own = fanColor.get(ticket.id) ?? null;
  const parent = primaryBlocker(ticket);

  return {
    seq: ticket.seq,
    title: ticket.title,
    status: ticket.status,
    column,
    type: wayfinderType(ticket.labels),
    depth: depths.get(ticket.id) ?? null,
    order: order.get(ticket.id) ?? 0,
    claim: ticket.claim ? claimView(ticket.claim.session, ticket.claim.at, ctx.now) : null,
    openBlockers,
    blocks: ticket.blocks
      .map((id) => byId.get(id))
      .filter((t): t is Ticket => t !== undefined && t.workspace === ticket.workspace)
      .map((t) => t.seq),
    fanColor: own,
    stripe: own ?? (parent === undefined ? NO_STRIPE : edgeColor(parent)),
    dispatch: ctx.readySeqs.has(ticket.seq)
      ? dispatchCommand(ticket.workspace, ticket.seq, ticket.title)
      : null,
    url: ticket.url,
  };
}

function claimView(session: string, since: string, now: string): ClaimView {
  const seen = sessionLastSeen(session);
  return {
    session,
    since,
    lastSeen: seen?.lastSeen ?? null,
    age: formatAge(seen?.lastSeen ?? since, now),
    // Overwritten from the frontier's buckets once they are known. "unknown" is the safe default:
    // a claim this host cannot vouch for must never read as free.
    state: "unknown",
  };
}
