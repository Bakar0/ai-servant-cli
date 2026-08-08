// A Claim: the record on a hub ticket saying which session is carrying it, and since when
// (workspace ADR 0010). It lives on the ticket rather than in a local file because the ticket is
// what a human reads when asking "is anyone on this?" — a local file would be invisible in exactly
// the moment it matters.
//
// The session identity cannot live in the assignee field: the hub has one assignable user, so
// assignee is a boolean. The name goes in a comment, which is append-only and so gives an audit
// trail without racing whoever else is editing the body.

import { $ } from "bun";

/** HTML comment stamped on every claim comment, so servant can find its own among the discussion. */
export const CLAIM_MARKER = "<!-- servant:claim -->";

export type ClaimKind = "held" | "released";

export interface Claim {
  kind: ClaimKind;
  /** Session name carrying the ticket — the address other sessions reach it by. */
  session: string;
  /** ISO timestamp the claim comment recorded. */
  at: string;
}

/** Injectable `gh` runner (argv after the binary → stdout). Real impl shells out. */
export type ClaimGhRunner = (args: readonly string[]) => Promise<string>;

const defaultRunner: ClaimGhRunner = async (args) => {
  const res = await $`gh ${args}`.nothrow().quiet();
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.toString().trim() || `gh ${args.join(" ")} failed`);
  }
  return res.stdout.toString();
};

export interface ClaimOptions {
  ghRunner?: ClaimGhRunner | undefined;
  /** ISO timestamp to stamp the comment with; injected so tests don't depend on the clock. */
  now?: string | undefined;
}

function claimBody(session: string, at: string, previous: string | null): string {
  const line =
    previous && previous !== session
      ? `**Claim transferred:** \`${previous}\` → \`${session}\``
      : `**Claim:** \`${session}\``;
  return `${CLAIM_MARKER}\n${line} — since ${at}`;
}

function releaseBody(session: string, at: string): string {
  return `${CLAIM_MARKER}\n**Claim released:** \`${session}\` — at ${at}`;
}

const HELD_RE = /\*\*Claim(?: transferred)?:\*\*.*?`([^`]+)`\s*—\s*since\s*(\S+)/s;
const RELEASED_RE = /\*\*Claim released:\*\*\s*`([^`]+)`\s*—\s*at\s*(\S+)/;

/**
 * The ticket's current Claim: the *last* servant claim comment wins, which is what makes a Claim
 * transfer rather than duplicate — re-handing a ticket appends a new comment and the old one
 * becomes history. Comments must be in chronological order, as `gh` returns them.
 */
export function parseClaim(comments: readonly { body?: string }[]): Claim | null {
  let latest: Claim | null = null;
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

export async function readClaim(
  hubRepo: string,
  ticket: number,
  opts: ClaimOptions = {},
): Promise<Claim | null> {
  const runner = opts.ghRunner ?? defaultRunner;
  let raw: string;
  try {
    raw = await runner(["issue", "view", String(ticket), "--repo", hubRepo, "--json", "comments"]);
  } catch {
    return null; // an unreadable ticket is "no claim known", never a hard stop on the caller
  }
  try {
    const parsed = JSON.parse(raw) as { comments?: { body?: string }[] };
    return parseClaim(parsed.comments ?? []);
  } catch {
    return null;
  }
}

/**
 * Take (or transfer) the Claim on a ticket. Idempotent: a ticket already held by this same session
 * is left alone, so a retried spawn does not litter the ticket with identical comments.
 */
export async function claimTicket(
  hubRepo: string,
  ticket: number,
  session: string,
  opts: ClaimOptions = {},
): Promise<{ transferredFrom: string | null; alreadyHeld: boolean }> {
  const runner = opts.ghRunner ?? defaultRunner;
  const at = opts.now ?? new Date().toISOString();
  const current = await readClaim(hubRepo, ticket, opts);
  if (current?.kind === "held" && current.session === session) {
    return { transferredFrom: null, alreadyHeld: true };
  }
  const previous = current?.kind === "held" ? current.session : null;
  await runner([
    "issue",
    "comment",
    String(ticket),
    "--repo",
    hubRepo,
    "--body",
    claimBody(session, at, previous),
  ]);
  await runner(["issue", "edit", String(ticket), "--repo", hubRepo, "--add-assignee", "@me"]);
  return { transferredFrom: previous, alreadyHeld: false };
}

/** Release the Claim, so `servant tasks --frontier` stops reporting the ticket as in flight. */
export async function releaseTicketClaim(
  hubRepo: string,
  ticket: number,
  session: string,
  opts: ClaimOptions = {},
): Promise<void> {
  const runner = opts.ghRunner ?? defaultRunner;
  const at = opts.now ?? new Date().toISOString();
  await runner([
    "issue",
    "comment",
    String(ticket),
    "--repo",
    hubRepo,
    "--body",
    releaseBody(session, at),
  ]);
  await runner(["issue", "edit", String(ticket), "--repo", hubRepo, "--remove-assignee", "@me"]);
}
