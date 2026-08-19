// `servant ticket` — the board's write surface, and the one the generated agent prose points at.
//
// It exists because the tracker operations skills perform used to be `gh issue create` and friends
// written into per-workspace markdown. Prose is part of the migration surface (ADR-0011), and prose
// can only be rewritten to something that exists.

import { defineCommand } from "citty";
import { parseSeq, resolveBoardWorkspace } from "../core/board/address.ts";
import { ticketHistory } from "../core/board/history.ts";
import type { HistoryEntry } from "../core/board/history.ts";
import {
  addComment,
  addDependency,
  assertStatus,
  createTicket,
  isOpenStatus,
  listTickets,
  removeDependency,
  requireTicket,
  ticketActions,
  updateTicket,
} from "../core/board/store.ts";
import type { Ticket } from "../core/board/store.ts";
import { applyRootOverride } from "../core/paths.ts";
import { blockerLabel } from "../core/tasks.ts";

const rootArg = {
  type: "string",
  required: false,
  description: "Servant root directory (default: ~/.ai_servant). For throwaway/test setups.",
} as const;

const wsArg = {
  type: "string",
  required: false,
  description: "Which workspace's board. Defaults to the current workspace.",
} as const;

function splitList(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "servant" is the default actor and names nobody; anyone else — the importer — is worth printing. */
const named = (actor: string) => (actor === "servant" ? "" : actor);

/** One transition per line, as wide as its value needs — the CLI has no column to align to. */
function historyLines(history: readonly HistoryEntry[]): string[] {
  if (history.length === 0) return [];
  const lines = ["", "  history:"];
  for (const entry of history) {
    const who = named(entry.actor);
    // An emptied label set has no value to show, and a bare "labels:" reads as a truncation.
    const what = entry.kind === "created" ? "filed" : `${entry.kind}: ${entry.detail || "—"}`;
    lines.push(`  — ${entry.at}  ${what}${who ? ` (${who})` : ""}`);
  }
  return lines;
}

function describe(
  ticket: Ticket,
  all: readonly Ticket[],
  history: readonly HistoryEntry[],
): string {
  const byId = new Map(all.map((t) => [t.id, t]));
  // A closed edge is marked rather than hidden: it is still a real dependency, and it explains why
  // a ticket with blockers listed is nonetheless in the frontier's ready bucket.
  const refs = (ids: readonly number[]) =>
    ids
      .map((id) => byId.get(id))
      .filter((t): t is Ticket => t !== undefined)
      .map(
        (t) => `${blockerLabel(t, ticket)} ${t.title}${isOpenStatus(t.status) ? "" : " (closed)"}`,
      );
  const lines = [
    `${ticket.workspace}#${ticket.seq}  ${ticket.title}`,
    `  status:   ${ticket.status}${isOpenStatus(ticket.status) ? "" : " (closed)"}`,
    `  labels:   ${ticket.labels.length ? ticket.labels.join(", ") : "—"}`,
    `  claim:    ${ticket.claim ? `${ticket.claim.session} since ${ticket.claim.at}` : "—"}`,
    `  blocked by: ${refs(ticket.blockedBy).join(" · ") || "—"}`,
    `  blocks:     ${refs(ticket.blocks).join(" · ") || "—"}`,
    `  url:      ${ticket.url}`,
  ];
  if (ticket.parentId !== null) {
    const parent = byId.get(ticket.parentId);
    if (parent) lines.push(`  part of:  #${parent.seq} ${parent.title}`);
  }
  if (ticket.body.trim()) lines.push("", ticket.body.trimEnd());
  const comments = ticketActions(ticket).filter((a) => a.kind === "comment");
  if (comments.length > 0) {
    lines.push("", "  comments:");
    for (const c of comments) {
      // A session wrote it, or — for anything carried in from the hub, where the authors are
      // people — the actor did. "servant" is the default actor and names nobody, so it is not shown.
      const who = c.session ?? named(c.actor);
      // Indented as a block: an imported comment can be pages of markdown, and indenting only its
      // first line leaves the rest flush against the ticket's own body.
      const body = c.body
        .trimEnd()
        .split("\n")
        .map((line, n) => (n === 0 || !line.trim() ? line : `    ${line}`))
        .join("\n");
      lines.push(`  — ${c.at}${who ? ` (${who})` : ""}\n    ${body}`);
    }
  }
  lines.push(...historyLines(history));
  return lines.join("\n");
}

const newCommand = defineCommand({
  meta: { name: "new", description: "File a ticket on a workspace's board." },
  args: {
    title: { type: "string", required: true, description: "One line naming the work." },
    body: { type: "string", required: false, description: "The ticket body (markdown)." },
    labels: {
      type: "string",
      required: false,
      description: 'Comma-separated labels, e.g. "spec,ready-for-agent".',
    },
    status: {
      type: "string",
      required: false,
      description: "todo (default), in_progress, in_review or done.",
    },
    parent: {
      type: "string",
      required: false,
      description: "Ticket number of the map this is a child of.",
    },
    ws: wsArg,
    json: { type: "boolean", required: false, default: false, description: "Emit JSON." },
    root: rootArg,
  },
  async run({ args }) {
    applyRootOverride(args.root);
    const workspace = await resolveBoardWorkspace({ ws: args.ws });
    const ticket = createTicket({
      workspace,
      title: String(args.title),
      body: args.body ? String(args.body) : "",
      labels: splitList(args.labels),
      ...(args.status ? { status: String(args.status) } : {}),
      ...(args.parent
        ? { parent: { workspace, seq: parseSeq(args.parent, "servant ticket new --parent") } }
        : {}),
    });
    if (args.json) {
      console.log(
        JSON.stringify({
          number: ticket.seq,
          workspace: ticket.workspace,
          id: ticket.id,
          url: ticket.url,
        }),
      );
      return;
    }
    console.log(`servant: filed ${workspace}#${ticket.seq} — ${ticket.title}\n  ${ticket.url}`);
  },
});

const showCommand = defineCommand({
  meta: { name: "show", description: "Read a ticket: body, labels, claim, edges and comments." },
  args: {
    ticket: { type: "positional", required: true, description: "Ticket number." },
    ws: wsArg,
    history: {
      type: "boolean",
      required: false,
      default: false,
      description: "Also print how the ticket got here: filed, label and status changes.",
    },
    json: { type: "boolean", required: false, default: false, description: "Emit JSON." },
    root: rootArg,
  },
  async run({ args }) {
    applyRootOverride(args.root);
    const seq = parseSeq(args.ticket, "servant ticket show");
    const workspace = await resolveBoardWorkspace({ ws: args.ws, seq });
    const ticket = requireTicket(workspace, seq);
    const actions = ticketActions(ticket);
    // Opt-in, like `claim --history`: the default read is the ticket, and a long-lived one's trail
    // would push the body and the comments people opened it for off the screen.
    const history = args.history ? ticketHistory(actions) : [];
    if (args.json) {
      console.log(
        JSON.stringify({
          ...ticket,
          number: ticket.seq,
          comments: actions.filter((a) => a.kind === "comment"),
          ...(args.history ? { history } : {}),
        }),
      );
      return;
    }
    console.log(describe(ticket, listTickets(), history));
  },
});

const commentCommand = defineCommand({
  meta: {
    name: "comment",
    description: "Append a comment, so findings and answers stay attached to the work.",
  },
  args: {
    ticket: { type: "positional", required: true, description: "Ticket number." },
    body: { type: "string", required: true, description: "The comment." },
    session: { type: "string", required: false, description: "Session name to attribute it to." },
    ws: wsArg,
    root: rootArg,
  },
  async run({ args }) {
    applyRootOverride(args.root);
    const seq = parseSeq(args.ticket, "servant ticket comment");
    const workspace = await resolveBoardWorkspace({ ws: args.ws, session: args.session, seq });
    addComment({ workspace, seq }, String(args.body), { session: args.session });
    console.log(`servant: commented on ${workspace}#${seq}`);
  },
});

const labelCommand = defineCommand({
  meta: { name: "label", description: "Add or remove labels. No label needs creating first." },
  args: {
    ticket: { type: "positional", required: true, description: "Ticket number." },
    add: { type: "string", required: false, description: "Comma-separated labels to add." },
    remove: { type: "string", required: false, description: "Comma-separated labels to remove." },
    ws: wsArg,
    root: rootArg,
  },
  async run({ args }) {
    applyRootOverride(args.root);
    const seq = parseSeq(args.ticket, "servant ticket label");
    const workspace = await resolveBoardWorkspace({ ws: args.ws, seq });
    // Read first because this patch is relative: the new label set is the old one plus and minus.
    const ticket = requireTicket(workspace, seq);
    const remove = new Set(splitList(args.remove));
    const labels = [...new Set([...ticket.labels, ...splitList(args.add)])].filter(
      (l) => !remove.has(l),
    );
    updateTicket(ticket, { labels });
    console.log(`servant: ${workspace}#${seq} labels: ${labels.join(", ") || "—"}`);
  },
});

const statusCommand = defineCommand({
  meta: { name: "status", description: "Move a ticket between board states." },
  args: {
    ticket: { type: "positional", required: true, description: "Ticket number." },
    status: {
      type: "positional",
      required: true,
      description: "todo, in_progress, in_review or done.",
    },
    ws: wsArg,
    root: rootArg,
  },
  async run({ args }) {
    applyRootOverride(args.root);
    const seq = parseSeq(args.ticket, "servant ticket status");
    const workspace = await resolveBoardWorkspace({ ws: args.ws, seq });
    const status = assertStatus(String(args.status));
    updateTicket({ workspace, seq }, { status });
    console.log(`servant: ${workspace}#${seq} → ${status}`);
  },
});

const closeCommand = defineCommand({
  meta: {
    name: "close",
    description: "Close a ticket. Anything it was blocking becomes ready immediately.",
  },
  args: {
    ticket: { type: "positional", required: true, description: "Ticket number." },
    comment: { type: "string", required: false, description: "A closing comment." },
    ws: wsArg,
    root: rootArg,
  },
  async run({ args }) {
    applyRootOverride(args.root);
    const seq = parseSeq(args.ticket, "servant ticket close");
    const workspace = await resolveBoardWorkspace({ ws: args.ws, seq });
    if (args.comment) addComment({ workspace, seq }, String(args.comment));
    updateTicket({ workspace, seq }, { status: "done" });
    console.log(`servant: closed ${workspace}#${seq}`);
  },
});

const blockCommand = defineCommand({
  meta: {
    name: "block",
    description: "Record that a ticket waits on another. A cycle is rejected here, not later.",
  },
  args: {
    ticket: { type: "positional", required: true, description: "The waiting ticket." },
    on: { type: "string", required: true, description: "The blocker's ticket number." },
    "on-ws": {
      type: "string",
      required: false,
      description: "The blocker's workspace, when the edge crosses boards.",
    },
    ws: wsArg,
    root: rootArg,
  },
  async run({ args }) {
    applyRootOverride(args.root);
    const seq = parseSeq(args.ticket, "servant ticket block");
    const workspace = await resolveBoardWorkspace({ ws: args.ws, seq });
    const blockerSeq = parseSeq(args.on, "servant ticket block --on");
    const blockerWs = args["on-ws"] ? String(args["on-ws"]) : workspace;
    // Read for its title, which the confirmation line names.
    const blocker = requireTicket(blockerWs, blockerSeq);
    addDependency({ workspace, seq }, blocker);
    console.log(
      `servant: ${workspace}#${seq} is blocked by ${blockerLabel(blocker, { workspace, seq })} ${blocker.title}`,
    );
  },
});

const unblockCommand = defineCommand({
  meta: { name: "unblock", description: "Drop a blocking edge." },
  args: {
    ticket: { type: "positional", required: true, description: "The waiting ticket." },
    on: { type: "string", required: true, description: "The blocker's ticket number." },
    "on-ws": { type: "string", required: false, description: "The blocker's workspace." },
    ws: wsArg,
    root: rootArg,
  },
  async run({ args }) {
    applyRootOverride(args.root);
    const seq = parseSeq(args.ticket, "servant ticket unblock");
    const workspace = await resolveBoardWorkspace({ ws: args.ws, seq });
    const blockerSeq = parseSeq(args.on, "servant ticket unblock --on");
    const blockerWs = args["on-ws"] ? String(args["on-ws"]) : workspace;
    removeDependency({ workspace, seq }, { workspace: blockerWs, seq: blockerSeq });
    console.log(`servant: ${workspace}#${seq} no longer waits on ${blockerWs}#${blockerSeq}`);
  },
});

export const ticketCommand = defineCommand({
  meta: {
    name: "ticket",
    description:
      "File, read and edit tickets on the local board — the tracker every servant command reads. No network, no GitHub login.",
  },
  subCommands: {
    new: newCommand,
    show: showCommand,
    comment: commentCommand,
    label: labelCommand,
    status: statusCommand,
    close: closeCommand,
    block: blockCommand,
    unblock: unblockCommand,
  },
});
