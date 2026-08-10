import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { $ } from "bun";
import { type Claim, parseClaim } from "./claims.ts";
import { tasksCachePath } from "./paths.ts";

// The task tracker lives in the majordomo hub as GitHub Issues, one `ws:<workspace>` label per
// workspace. `servant tasks` aggregates them across workspaces via `gh`, falling back to a cached
// snapshot when offline so navigation never hard-depends on the network.

export const WS_LABEL_PREFIX = "ws:";
export type IssueState = "open" | "closed" | "all";

export interface HubIssue {
  number: number;
  title: string;
  state: string;
  url: string;
  labels: string[];
  /** The `ws:` label with the prefix stripped, or null if the issue carries none. */
  workspace: string | null;
  /** Blockers declared in the body — the inline line and the bulleted section, unioned. */
  blockedBy: number[];
  /**
   * Blockers recorded as GitHub's own issue dependencies, or **null when they were not read**.
   *
   * Null and `[]` are deliberately different. `[]` means the hub was asked and said there are
   * none; null means nobody asked — offline, a hub without the feature, a caller that did not
   * need them. Collapsing the two would turn "we did not look" into "there is no edge", which is
   * the exact silent loss majordomo#23 is about.
   */
  nativeBlockedBy: number[] | null;
  /**
   * The Claim on this ticket — which session is carrying it, and since when — or null when nobody
   * is. Read from the issue's own comments, which arrive in the same `gh issue list` call, so
   * knowing who holds every ticket costs no extra round trip (workspace ADR 0010).
   */
  claim: Claim | null;
}

interface TasksCache {
  ts: number;
  hubRepo: string;
  state: IssueState;
  issues: HubIssue[];
}

/** Injectable `gh issue list` runner (returns raw JSON stdout). Real impl shells out to gh. */
export type GhRunner = (hubRepo: string, state: IssueState) => Promise<string>;

const defaultGhRunner: GhRunner = async (hubRepo, state) => {
  const res =
    await $`gh issue list --repo ${hubRepo} --state ${state} --limit 500 --json number,title,state,url,labels,body,comments`
      .nothrow()
      .quiet();
  if (res.exitCode !== 0) throw new Error(res.stderr.toString().trim() || "gh issue list failed");
  return res.stdout.toString();
};

/** Injectable `gh api` runner (argv after `gh api` → stdout). Real impl shells out. */
export type NativeBlockersRunner = (args: readonly string[]) => Promise<string>;

/** Exported so callers can opt *in* to dependency reads without knowing what `gh api` looks like. */
export const defaultNativeBlockersRunner: NativeBlockersRunner = async (args) => {
  const res = await $`gh api ${args}`.nothrow().quiet();
  if (res.exitCode !== 0) throw new Error(res.stderr.toString().trim() || "gh api failed");
  return res.stdout.toString();
};

function numbersIn(json: string): number[] {
  const raw: unknown = JSON.parse(json);
  if (!Array.isArray(raw)) throw new Error("not a list");
  return raw
    .map((item) =>
      item && typeof item === "object" ? (item as { number?: unknown }).number : undefined,
    )
    .filter((n): n is number => typeof n === "number");
}

/**
 * Blocking edges recorded as GitHub's own issue dependencies — the third form, and the only one
 * that is not in the issue body at all (majordomo#23).
 *
 * Two steps rather than one call per ticket: the issue list carries an
 * `issue_dependencies_summary`, so only the tickets it says have dependencies are asked about.
 * On this hub that is a handful rather than every open issue.
 *
 * Returns **null when nothing could be read**, and omits any single ticket whose own read failed.
 * Both mean "not read", which the caller unions as nothing — falling back to the textual forms
 * rather than reporting a ticket as unblocked on the strength of a request that did not happen.
 */
export async function readNativeBlockers(
  hubRepo: string,
  opts: { runner?: NativeBlockersRunner } = {},
): Promise<Map<number, number[]> | null> {
  const runner = opts.runner ?? defaultNativeBlockersRunner;
  let summaries: { number: number; total: number }[];
  try {
    const raw: unknown = JSON.parse(
      await runner([`repos/${hubRepo}/issues?state=open&per_page=100`, "--paginate"]),
    );
    if (!Array.isArray(raw)) return null;
    summaries = raw.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const o = item as { number?: unknown; issue_dependencies_summary?: unknown };
      const summary = o.issue_dependencies_summary as { total_blocked_by?: unknown } | undefined;
      if (typeof o.number !== "number") return [];
      // A hub without the feature reports no summary at all. Treated as unread rather than as
      // "no dependencies", so such a hub degrades to the text forms instead of silently
      // announcing that nothing is blocked.
      if (typeof summary?.total_blocked_by !== "number") return [];
      return [{ number: o.number, total: summary.total_blocked_by }];
    });
  } catch {
    return null;
  }

  // Note there is no early return for an empty list: a hub with no open issues was still *asked*,
  // and answering null would say "nobody looked" — the distinction this whole type turns on.
  const out = new Map<number, number[]>();
  for (const { number, total } of summaries) {
    if (total === 0) {
      out.set(number, []);
      continue;
    }
    try {
      out.set(
        number,
        numbersIn(await runner([`repos/${hubRepo}/issues/${number}/dependencies/blocked_by`])),
      );
    } catch {
      // Left out of the map entirely: this ticket's edges are unknown, not absent.
    }
  }
  return out;
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
 * reading it as a dependency would invent an edge. Inventing one is the *other* failure — less
 * dangerous than losing one, since it only stalls work rather than dispatching it too early, but
 * still a lie about the frontier.
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
 * `Blocked by: #12, #34` line and the bulleted `## Blocked by` section — unioned.
 *
 * The union is the safe reading, and the reason is asymmetric: this function losing an edge makes
 * `--frontier` call a blocked ticket ready, and `/servant:handoff` then spawns a session onto work
 * whose prerequisite does not exist yet (majordomo#23). Native GitHub dependencies are the third
 * form and cannot be read from the body at all — see `mergeNativeBlockers`.
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
  if (section) {
    for (const line of section.split("\n")) {
      if (/^[ \t]*[-*+][ \t]/.test(line)) for (const n of issueRefs(line)) out.add(n);
    }
  }
  return [...out];
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
    issues.push({
      number: typeof o.number === "number" ? o.number : 0,
      title: asString(o.title),
      state: asString(o.state).toLowerCase(),
      url: asString(o.url),
      labels,
      workspace: workspaceOf(labels),
      blockedBy: parseBlockedBy(asString(o.body)),
      // `gh issue list` cannot report dependencies; they arrive separately, if at all.
      nativeBlockedBy: null,
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

/** Group issues by workspace label; issues with no `ws:` label bucket under "(unlabeled)". */
export function groupByWorkspace(issues: readonly HubIssue[]): Map<string, HubIssue[]> {
  const out = new Map<string, HubIssue[]>();
  for (const issue of issues) {
    const key = issue.workspace ?? "(unlabeled)";
    const bucket = out.get(key);
    if (bucket) bucket.push(issue);
    else out.set(key, [issue]);
  }
  return new Map([...out.entries()].toSorted((a, b) => a[0].localeCompare(b[0])));
}

/** A Claim on a ticket, paired with the ticket it sits on. */
export interface ClaimedIssue {
  issue: HubIssue;
  claim: Claim;
}

/**
 * What this host can say about which sessions are running. Degrades to unknown, and unknown is an
 * ordinary answer — never an error — because liveness is the most valuable thing here and the
 * least safe to depend on (workspace ADR 0010, decision 3).
 */
export type ClaimLiveness = { known: false } | { known: true; liveSessions: readonly string[] };

/**
 * The frontier, in four disjoint buckets. Only two of them are dispatchable, and which two is the
 * whole point: `ready` is free to take, `stale` needs its dead Claim reclaimed first, and the
 * other two are refusals.
 */
export interface Frontier {
  /** Unblocked and unclaimed — safe to dispatch now. */
  ready: HubIssue[];
  /**
   * Unblocked, but claimed by a session that is gone. Dispatchable once the Claim is reclaimed,
   * which `/servant:handoff` does silently — it is cleanup, not a decision.
   */
  stale: ClaimedIssue[];
  /**
   * Claimed by a session that is still running, or whose liveness could not be determined. Both
   * are refusals: a ticket we cannot prove is free must not be handed out twice.
   */
  inFlight: (ClaimedIssue & { liveness: "alive" | "unknown" })[];
  /** Open tickets still waiting, each with the subset of blockers that are still open. */
  blocked: { issue: HubIssue; openBlockers: number[] }[];
}

/** Every blocker a ticket declares, in whatever form. Deduped, since the forms overlap by design. */
export function allBlockersOf(issue: HubIssue): number[] {
  return [...new Set([...issue.blockedBy, ...(issue.nativeBlockedBy ?? [])])];
}

/**
 * Split open tickets into ready vs blocked from their declared blocking edges, in **every** form
 * they take. A blocker counts only while it is still open in the given set; a closed or unknown
 * blocker is treated as satisfied.
 */
export function computeFrontier(
  issues: readonly HubIssue[],
  liveness: ClaimLiveness = { known: false },
): Frontier {
  const open = issues.filter((i) => i.state === "open");
  const openNums = new Set(open.map((i) => i.number));
  const live = new Set(liveness.known ? liveness.liveSessions : []);
  const ready: HubIssue[] = [];
  const stale: ClaimedIssue[] = [];
  const inFlight: (ClaimedIssue & { liveness: "alive" | "unknown" })[] = [];
  const blocked: { issue: HubIssue; openBlockers: number[] }[] = [];

  for (const issue of open) {
    const openBlockers = allBlockersOf(issue).filter((n) => openNums.has(n));
    // Blocked wins over any Claim: whoever is carrying it, the prerequisite still does not exist.
    if (openBlockers.length > 0) {
      blocked.push({ issue, openBlockers });
      continue;
    }
    const claim = issue.claim?.kind === "held" ? issue.claim : null;
    if (!claim) {
      ready.push(issue);
      continue;
    }
    // Staleness is the session being *absent*, never elapsed time — a session idle for days is
    // alive and still legitimately holds its ticket. So an unreadable registry cannot conclude
    // stale, and reports in-flight instead.
    if (!liveness.known) inFlight.push({ issue, claim, liveness: "unknown" });
    else if (live.has(claim.session)) inFlight.push({ issue, claim, liveness: "alive" });
    else stale.push({ issue, claim });
  }

  ready.sort((a, b) => a.number - b.number);
  const byNumber = (a: { issue: HubIssue }, b: { issue: HubIssue }) =>
    a.issue.number - b.issue.number;
  stale.sort(byNumber);
  inFlight.sort(byNumber);
  blocked.sort(byNumber);
  return { ready, stale, inFlight, blocked };
}

async function writeCache(cache: TasksCache): Promise<void> {
  const path = tasksCachePath();
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(cache, null, 2)}\n`);
}

async function readCache(): Promise<TasksCache | null> {
  const file = Bun.file(tasksCachePath());
  if (!(await file.exists())) return null;
  try {
    return (await file.json()) as TasksCache;
  } catch {
    return null;
  }
}

export interface FetchResult {
  issues: HubIssue[];
  /** true when gh failed and we served the last cached snapshot instead. */
  fromCache: boolean;
  /** cache timestamp (ms) when fromCache. */
  cachedAt?: number;
}

/**
 * Fetch hub issues via gh, caching the result. On gh failure, serve the last cached snapshot
 * (marked fromCache) so the command still renders offline. `ts` is passed in (callers stamp it)
 * because Date.now() is unavailable in some sandboxes; omit to skip stamping.
 */
export async function fetchHubTasks(
  hubRepo: string,
  state: IssueState,
  opts: { ghRunner?: GhRunner; nativeRunner?: NativeBlockersRunner; now?: number } = {},
): Promise<FetchResult> {
  const runner = opts.ghRunner ?? defaultGhRunner;
  try {
    const listed = parseGhIssues(await runner(hubRepo, state));
    // Only asked for when the caller wants them — `servant summon` reads this too, and has no use
    // for dependencies (majordomo#23).
    const native = opts.nativeRunner
      ? await readNativeBlockers(hubRepo, { runner: opts.nativeRunner })
      : null;
    const issues = withNativeBlockers(listed, native, await readCache());
    await writeCache({ ts: opts.now ?? 0, hubRepo, state, issues });
    return { issues, fromCache: false };
  } catch {
    const cache = await readCache();
    if (cache) return { issues: cache.issues, fromCache: true, cachedAt: cache.ts };
    return { issues: [], fromCache: false };
  }
}

/**
 * Attach native blockers, keeping the ones already cached when this fetch did not read them.
 *
 * The cache is shared by every caller and only `--frontier` reads dependencies, so without the
 * carry-over a `servant summon` fetch would blank the last-known native edges and the next offline
 * frontier would lose them — the same silent loss, arriving by a different door. A *fresh* read
 * always wins, including a read that found none: that is knowledge, not absence of it.
 */
function withNativeBlockers(
  issues: readonly HubIssue[],
  native: Map<number, number[]> | null,
  cache: TasksCache | null,
): HubIssue[] {
  const cached = new Map(cache?.issues.map((i) => [i.number, i.nativeBlockedBy ?? null]) ?? []);
  return issues.map((issue) => ({
    ...issue,
    nativeBlockedBy: native?.get(issue.number) ?? cached.get(issue.number) ?? null,
  }));
}
