// The one-shot hub importer — the last consumer of `gh` anywhere in servant, and expected to be
// deleted once it has been run (ADR-0011).
//
// It exists in the same ticket as the board because without it the board is empty and there is
// nothing to verify the frontier against, and because deleting the `gh` path in a later ticket
// would leave a window where the hub is unreadable but not yet imported.
//
// Everything hub-shaped lives here on purpose: the three encodings blocking took, the comment-based
// claim protocol, and the `ws:` label that workspace membership used to be. None of it survives
// contact with the board, and none of it should leak into the store.

import { $ } from "bun";
import {
  addDependency,
  createTicket,
  findTicket,
  isOpenStatus,
  listTickets,
  recordAction,
  updateClaim,
  updateTicket,
} from "./store.ts";

export const WS_LABEL_PREFIX = "ws:";

/** Stamped on every claim comment the hub-era protocol wrote. */
export const CLAIM_MARKER = "<!-- servant:claim -->";

/** Injectable `gh issue list` runner (returns raw JSON stdout). Real impl shells out to gh. */
export type HubRunner = (hubRepo: string) => Promise<string>;

const defaultHubRunner: HubRunner = async (hubRepo) => {
  const res =
    await $`gh issue list --repo ${hubRepo} --state all --limit 1000 --json number,title,state,url,labels,body,comments`
      .nothrow()
      .quiet();
  if (res.exitCode !== 0) throw new Error(res.stderr.toString().trim() || "gh issue list failed");
  return res.stdout.toString();
};

/** Injectable `gh api` runner (argv after `gh api` → stdout). Real impl shells out. */
export type HubApiRunner = (args: readonly string[]) => Promise<string>;

const defaultApiRunner: HubApiRunner = async (args) => {
  const res = await $`gh api ${args}`.nothrow().quiet();
  if (res.exitCode !== 0) throw new Error(res.stderr.toString().trim() || "gh api failed");
  return res.stdout.toString();
};

interface HubClaim {
  kind: "held" | "released";
  session: string;
  at: string;
}

export interface HubIssue {
  number: number;
  title: string;
  state: string;
  url: string;
  labels: string[];
  body: string;
  /** The `ws:` label with the prefix stripped, or null if the issue carries none. */
  workspace: string | null;
  /** Blockers declared in the body — the inline line and the bulleted section, unioned. */
  blockedBy: number[];
  claim: HubClaim | null;
}

const HELD_RE = /\*\*Claim(?: transferred)?:\*\*.*?`([^`]+)`\s*—\s*since\s*(\S+)/s;
const RELEASED_RE = /\*\*Claim released:\*\*\s*`([^`]+)`\s*—\s*at\s*(\S+)/;

/** The ticket's Claim under the hub protocol: the *last* servant claim comment wins. */
export function parseClaim(comments: readonly { body?: string }[]): HubClaim | null {
  let latest: HubClaim | null = null;
  for (const comment of comments) {
    const body = comment.body ?? "";
    if (!body.includes(CLAIM_MARKER)) continue;
    const released = RELEASED_RE.exec(body);
    if (released?.[1] && released[2]) {
      latest = { kind: "released", session: released[1], at: released[2] };
      continue;
    }
    // Checked second: a transfer comment names two sessions, and the held pattern picks the last
    // backticked one — the session taking it over.
    const held = HELD_RE.exec(body);
    if (held?.[1] && held[2]) latest = { kind: "held", session: held[1], at: held[2] };
  }
  return latest;
}

function workspaceOf(labels: string[]): string | null {
  const ws = labels.find((l) => l.startsWith(WS_LABEL_PREFIX));
  return ws ? ws.slice(WS_LABEL_PREFIX.length) : null;
}

/**
 * Blank out code — fenced blocks and inline spans — leaving the offsets intact.
 *
 * Code is quotation, not declaration. A ticket that *documents* the format (majordomo#23 does,
 * with a backticked `Blocked by: #15, #17`) would otherwise acquire the blockers it is describing,
 * and a `# comment` inside a shell fence would read as the heading that ends the section — which
 * loses every edge below it.
 */
function withoutCode(body: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, " ");
  return body.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, blank).replace(/`[^`\n]*`/g, blank);
}

/**
 * The `## Blocked by` section `/to-tickets` writes, from its heading to the next one.
 *
 * Bounded at the next heading on purpose: an issue number further down the body is discussion, and
 * reading it as a dependency would invent an edge.
 */
function blockedBySection(body: string): string | null {
  // Trailing punctuation tolerated: these headings are hand-written as often as generated, and
  // `## Blocked by:` dropping the whole section is exactly the silent loss this is about.
  const heading = /^[ \t]*#{1,6}[ \t]*blocked[ \t]+by[ \t]*[:\-—]?[ \t]*$/im.exec(body);
  if (!heading) return null;
  const after = body.slice(heading.index + heading[0].length);
  const next = /^[ \t]*#{1,6}[ \t]+\S/m.exec(after);
  return next ? after.slice(0, next.index) : after;
}

/** Every `#N` in a chunk of text. */
function issueRefs(text: string): number[] {
  return [...text.matchAll(/#(\d+)\b/g)].map((m) => Number(m[1]));
}

/**
 * Blocker issue numbers a ticket body declares, from **both** textual forms — the inline
 * `Blocked by: #12, #34` line and the bulleted `## Blocked by` section — unioned. GitHub's native
 * dependencies are the third form and cannot be read from the body at all.
 */
export function parseBlockedBy(rawBody: string): number[] {
  const body = withoutCode(rawBody);
  const out = new Set<number>();
  // A single newline after the marker is still the same thought; a blank line is not. Without the
  // first, `Blocked by:\n#17` loses its edge; without the second, the marker reaches on into
  // whatever prose follows and invents one.
  const inline = /blocked by:?[ \t]*\n?[ \t]*((?:#\d+[ \t,]*\n?[ \t]*)+)/gi;
  for (const match of body.matchAll(inline)) {
    for (const n of issueRefs(match[1] ?? "")) out.add(n);
  }
  const section = blockedBySection(body);
  // Only list items count inside the section: its own prose ("None — can start immediately") is
  // how a ticket says it has no blockers, and must not be scanned for numbers.
  //
  // A bullet that *itself* opens with "none" is that same statement, written as a list item — and
  // it is often followed by the tickets this one should go *before*. Reading those as blockers
  // reverses the edge, and on majordomo#29 ("None — can start immediately, and should go before
  // #24, #26 and #28") it invented three edges and closed a cycle with #28.
  if (section) {
    for (const line of section.split("\n")) {
      if (!/^[ \t]*[-*+][ \t]/.test(line)) continue;
      if (/^[ \t]*[-*+][ \t]*none\b/i.test(line)) continue;
      for (const n of issueRefs(line)) out.add(n);
    }
  }
  return [...out];
}

/** The map a wayfinder child hangs off, as the hub encoded it when sub-issues were unavailable. */
export function parseParentRef(rawBody: string): number | null {
  const match = /^[ \t]*(?:\*\*)?part of(?:\*\*)?[ \t:]*#(\d+)\b/im.exec(withoutCode(rawBody));
  return match?.[1] ? Number(match[1]) : null;
}

const asString = (v: unknown): string => (typeof v === "string" ? v : "");

/** Parse `gh issue list --json ...` output into HubIssues. Tolerates missing/extra fields. */
export function parseGhIssues(json: string): HubIssue[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const issues: HubIssue[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const labels = Array.isArray(o.labels)
      ? o.labels
          .map((l) => (l && typeof l === "object" ? asString((l as { name?: unknown }).name) : ""))
          .filter(Boolean)
      : [];
    const body = asString(o.body);
    issues.push({
      number: typeof o.number === "number" ? o.number : 0,
      title: asString(o.title),
      state: asString(o.state).toLowerCase(),
      url: asString(o.url),
      labels,
      body,
      workspace: workspaceOf(labels),
      blockedBy: parseBlockedBy(body),
      claim: parseClaim(
        Array.isArray(o.comments)
          ? o.comments.map((c) =>
              c && typeof c === "object" ? { body: asString((c as { body?: unknown }).body) } : {},
            )
          : [],
      ),
    });
  }
  return issues;
}

function numbersIn(json: string): number[] {
  const raw: unknown = JSON.parse(json);
  if (!Array.isArray(raw)) throw new Error("not a list");
  return raw
    .map((item) =>
      item && typeof item === "object" ? (item as { number?: unknown }).number : undefined,
    )
    .filter((n): n is number => typeof n === "number");
}

export interface NativeBlockers {
  /** Blockers per issue number, or null when the listing itself could not be read. */
  edges: Map<number, number[]> | null;
  /** Issues whose own dependency read failed — their edges are unknown, not absent. */
  unreadable: number[];
}

/**
 * Blocking edges recorded as GitHub's own issue dependencies — the third encoding, and the only one
 * that is not in the issue body at all.
 *
 * Two steps rather than one call per ticket: the issue list carries an
 * `issue_dependencies_summary`, so only the tickets it says have dependencies are asked about.
 *
 * Every way this can come up short is reported rather than flattened to "no edges", because an
 * unread dependency and an absent one look identical to the caller and only one of them is safe.
 */
export async function readNativeBlockers(
  hubRepo: string,
  runner: HubApiRunner,
): Promise<NativeBlockers> {
  let summaries: { number: number; total: number }[];
  try {
    const raw: unknown = JSON.parse(
      await runner([`repos/${hubRepo}/issues?state=all&per_page=100`, "--paginate"]),
    );
    if (!Array.isArray(raw)) return { edges: null, unreadable: [] };
    summaries = raw.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const o = item as { number?: unknown; issue_dependencies_summary?: unknown };
      const summary = o.issue_dependencies_summary as { total_blocked_by?: unknown } | undefined;
      if (typeof o.number !== "number") return [];
      // A hub without the feature reports no summary at all. Treated as unread rather than as
      // "no dependencies", so such a hub degrades to the text forms.
      if (typeof summary?.total_blocked_by !== "number") return [];
      return [{ number: o.number, total: summary.total_blocked_by }];
    });
  } catch {
    return { edges: null, unreadable: [] };
  }
  const edges = new Map<number, number[]>();
  const unreadable: number[] = [];
  for (const { number, total } of summaries) {
    if (total === 0) {
      edges.set(number, []);
      continue;
    }
    try {
      edges.set(
        number,
        numbersIn(await runner([`repos/${hubRepo}/issues/${number}/dependencies/blocked_by`])),
      );
    } catch {
      unreadable.push(number);
    }
  }
  return { edges, unreadable };
}

export interface ImportReport {
  /** Boards the import touched, in the order a report should read them. */
  boards: string[];
  created: number;
  updated: number;
  /** Edges written this run (an edge already on the board is not counted again). */
  edges: number;
  /** Live Claims carried over — a session mid-flight keeps its address. */
  claims: number;
  parents: number;
  /**
   * Everything the import could not carry over, one line each. Silent loss is the failure mode
   * that matters here, so this is part of the return value rather than a log line.
   */
  skipped: string[];
}

export interface ImportOptions {
  runner?: HubRunner | undefined;
  apiRunner?: HubApiRunner | undefined;
  now?: string | undefined;
}

/**
 * Read the hub once and populate the board.
 *
 * Idempotent by (workspace, seq): a re-run updates in place rather than duplicating. The hub stays
 * the source of a ticket's *content* — title, body and labels are re-applied — but not of the work
 * done since: a ticket moved to `in_progress` here stays there while the hub still calls it open,
 * and only open-versus-closed is taken from the hub. Claims already on the board are left alone
 * unless the hub names a different holder.
 */
export async function importHub(hubRepo: string, opts: ImportOptions = {}): Promise<ImportReport> {
  const now = opts.now ?? new Date().toISOString();
  const issues = parseGhIssues(await (opts.runner ?? defaultHubRunner)(hubRepo));
  const native = await readNativeBlockers(hubRepo, opts.apiRunner ?? defaultApiRunner);

  const report: ImportReport = {
    boards: [],
    created: 0,
    updated: 0,
    edges: 0,
    claims: 0,
    parents: 0,
    skipped: [],
  };
  // The one loss this import can suffer without noticing: the textual forms are in the bodies we
  // already have, but native dependencies are a separate read, and an unread one looks exactly like
  // a hub with no dependencies. Reported rather than shrugged off, because "0 could not be carried
  // over" would otherwise be a lie.
  if (native.edges === null) {
    report.skipped.push(
      "native GitHub dependencies could not be read at all — any edge recorded only that way is missing; re-run when the hub is reachable",
    );
  }
  for (const number of native.unreadable) {
    report.skipped.push(`#${number} — its native dependencies could not be read`);
  }

  const mine = issues.filter((issue) => issue.workspace !== null && issue.number > 0);
  for (const issue of issues) {
    if (issue.workspace === null) {
      report.skipped.push(`#${issue.number} "${issue.title}" — no ws: label, so no board to join`);
    } else if (issue.number <= 0) {
      report.skipped.push(`"${issue.title}" — no issue number to preserve as a seq`);
    }
  }

  // Pass 1 — tickets. Numbers are preserved as seqs, so existing session names and every
  // cross-reference written anywhere stay valid (ADR-0011 decision 4).
  const byNumber = new Map<number, number>();
  for (const issue of mine) {
    const workspace = issue.workspace as string;
    const labels = issue.labels.filter((l) => !l.startsWith(WS_LABEL_PREFIX));
    const hubClosed = issue.state === "closed";
    const existing = findTicket(workspace, issue.number);
    if (existing) {
      const status = hubClosed
        ? "done"
        : isOpenStatus(existing.status)
          ? existing.status
          : ("todo" as const);
      updateTicket(
        existing.id,
        {
          title: issue.title,
          body: issue.body,
          labels,
          status,
          input: { ...existing.input, hub: { number: issue.number, url: issue.url } },
        },
        { now },
      );
      report.updated += 1;
      byNumber.set(issue.number, existing.id);
    } else {
      const created = createTicket({
        workspace,
        seq: issue.number,
        title: issue.title,
        body: issue.body,
        labels,
        status: hubClosed ? "done" : "todo",
        input: { hub: { number: issue.number, url: issue.url } },
        now,
      });
      report.created += 1;
      byNumber.set(issue.number, created.id);
    }
    if (!report.boards.includes(workspace)) report.boards.push(workspace);
  }
  report.boards.sort();

  // Pass 2 — everything that references another ticket, once every ticket exists.
  for (const issue of mine) {
    const id = byNumber.get(issue.number);
    if (id === undefined) continue;
    // One read per issue: every ticket read pulls the whole edge table, so re-reading it per
    // blocker turned a 77-issue import into hundreds of full-table scans.
    const before = findTicket(issue.workspace as string, issue.number);

    const parentRef = parseParentRef(issue.body);
    if (parentRef !== null) {
      const parentId = byNumber.get(parentRef);
      if (parentId === undefined) {
        report.skipped.push(`#${issue.number} — parent #${parentRef} was not imported`);
      } else if (before?.parentId !== parentId) {
        updateTicket(id, { parentId }, { now });
        report.parents += 1;
      }
    }

    // All three encodings, unioned. Losing an edge would let the frontier dispatch onto an unbuilt
    // prerequisite, so the union is the safe reading even where the forms overlap.
    const blockers = new Set([...issue.blockedBy, ...(native.edges?.get(issue.number) ?? [])]);
    for (const blocker of blockers) {
      const blockerId = byNumber.get(blocker);
      if (blockerId === undefined) {
        report.skipped.push(
          `#${issue.number} — blocker #${blocker} was not imported, so that edge is lost`,
        );
        continue;
      }
      if (before?.blockedBy.includes(blockerId)) continue;
      try {
        addDependency(id, blockerId, { now });
        report.edges += 1;
      } catch (err) {
        report.skipped.push(
          `#${issue.number} — blocked-by #${blocker} rejected: ${(err as Error).message}`,
        );
      }
    }

    // A held Claim is carried over so a session mid-flight on a ticket keeps its address. A
    // released one is nothing to carry: the ticket is nobody's.
    if (issue.claim?.kind === "held") {
      const current = before?.claim ?? null;
      if (current?.session !== issue.claim.session) {
        updateClaim(id, { session: issue.claim.session, at: issue.claim.at });
        recordAction(id, {
          kind: current ? "transferred" : "claimed",
          actor: "import",
          session: issue.claim.session,
          body: current?.session ?? "",
          at: issue.claim.at,
        });
        report.claims += 1;
      }
    }
  }

  return report;
}

/** Every board the import produced, with how many tickets landed on each. */
export function importedBoardSummary(): { workspace: string; tickets: number }[] {
  const counts = new Map<string, number>();
  for (const ticket of listTickets()) {
    counts.set(ticket.workspace, (counts.get(ticket.workspace) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([workspace, tickets]) => ({ workspace, tickets }))
    .toSorted((a, b) => a.workspace.localeCompare(b.workspace));
}
