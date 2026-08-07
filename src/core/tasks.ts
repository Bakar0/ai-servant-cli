import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { $ } from "bun";
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
  /** Issue numbers this ticket declares as blockers (parsed from a "Blocked by: #N" body line). */
  blockedBy: number[];
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
    await $`gh issue list --repo ${hubRepo} --state ${state} --limit 500 --json number,title,state,url,labels,body`
      .nothrow()
      .quiet();
  if (res.exitCode !== 0) throw new Error(res.stderr.toString().trim() || "gh issue list failed");
  return res.stdout.toString();
};

function workspaceOf(labels: string[]): string | null {
  const ws = labels.find((l) => l.startsWith(WS_LABEL_PREFIX));
  return ws ? ws.slice(WS_LABEL_PREFIX.length) : null;
}

/** Parse blocker issue numbers from a "Blocked by: #12, #34" line anywhere in the body. */
export function parseBlockedBy(body: string): number[] {
  const out = new Set<number>();
  const re = /blocked by:?\s*((?:#\d+[\s,]*)+)/gi;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = re.exec(body)) !== null) {
    for (const ref of m[1]?.match(/#\d+/g) ?? []) out.add(Number(ref.slice(1)));
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

export interface Frontier {
  /** Open tickets whose blockers (if any) are all closed — safe to dispatch now. */
  ready: HubIssue[];
  /** Open tickets still waiting, each with the subset of blockers that are still open. */
  blocked: { issue: HubIssue; openBlockers: number[] }[];
}

/**
 * Split open tickets into ready vs blocked from their declared blocking edges. A blocker counts
 * only while it's still open in the given set; a closed or unknown blocker is treated as satisfied.
 */
export function computeFrontier(issues: readonly HubIssue[]): Frontier {
  const open = issues.filter((i) => i.state === "open");
  const openNums = new Set(open.map((i) => i.number));
  const ready: HubIssue[] = [];
  const blocked: { issue: HubIssue; openBlockers: number[] }[] = [];
  for (const issue of open) {
    const openBlockers = issue.blockedBy.filter((n) => openNums.has(n));
    if (openBlockers.length === 0) ready.push(issue);
    else blocked.push({ issue, openBlockers });
  }
  ready.sort((a, b) => a.number - b.number);
  blocked.sort((a, b) => a.issue.number - b.issue.number);
  return { ready, blocked };
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
  opts: { ghRunner?: GhRunner; now?: number } = {},
): Promise<FetchResult> {
  const runner = opts.ghRunner ?? defaultGhRunner;
  try {
    const issues = parseGhIssues(await runner(hubRepo, state));
    await writeCache({ ts: opts.now ?? 0, hubRepo, state, issues });
    return { issues, fromCache: false };
  } catch {
    const cache = await readCache();
    if (cache) return { issues: cache.issues, fromCache: true, cachedAt: cache.ts };
    return { issues: [], fromCache: false };
  }
}
