// `servant ticket` — the board's write surface, and the one the generated agent prose points at.
//
// It exists because the tracker operations skills perform used to be `gh issue create` and friends
// written into per-workspace markdown. Prose is part of the migration surface (ADR-0011), and prose
// can only be rewritten to something that exists.

import { defineCommand } from "citty";
import { parseSeq, resolveBoardWorkspace } from "../core/board/address.ts";
import {
  addComment,
  addDependency,
  assertStatus,
  createTicket,
  isOpenStatus,
  listTickets,
  recordAction,
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

function describe(ticket: Ticket, all: readonly Ticket[]): string {
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
  const comments = ticketActions(ticket.id).filter((a) => a.kind === "comment");
  if (comments.length > 0) {
    lines.push("", "  comments:");
    for (const c of comments) {
      lines.push(`  — ${c.at}${c.session ? ` (${c.session})` : ""}\n    ${c.body}`);
    }
  }
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
      ...(args.parent ? { parentSeq: parseSeq(args.parent, "servant ticket new --parent") } : {}),
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
    json: { type: "boolean", required: false, default: false, description: "Emit JSON." },
    root: rootArg,
  },
  async run({ args }) {
    applyRootOverride(args.root);
    const seq = parseSeq(args.ticket, "servant ticket show");
    const workspace = await resolveBoardWorkspace({ ws: args.ws, seq });
    const ticket = requireTicket(workspace, seq);
    if (args.json) {
      console.log(
        JSON.stringify({
          ...ticket,
          number: ticket.seq,
          comments: ticketActions(ticket.id).filter((a) => a.kind === "comment"),
        }),
      );
      return;
    }
    console.log(describe(ticket, listTickets()));
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
    const ticket = requireTicket(workspace, seq);
    addComment(ticket.id, String(args.body), { session: args.session });
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
    const ticket = requireTicket(workspace, seq);
    const remove = new Set(splitList(args.remove));
    const labels = [...new Set([...ticket.labels, ...splitList(args.add)])].filter(
      (l) => !remove.has(l),
    );
    updateTicket(ticket.id, { labels });
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
    const ticket = requireTicket(workspace, seq);
    const status = assertStatus(String(args.status));
    updateTicket(ticket.id, { status });
    recordAction(ticket.id, { kind: "status", body: status });
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
    const ticket = requireTicket(workspace, seq);
    if (args.comment) addComment(ticket.id, String(args.comment));
    updateTicket(ticket.id, { status: "done" });
    recordAction(ticket.id, { kind: "status", body: "done" });
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
    const ticket = requireTicket(workspace, seq);
    const blocker = requireTicket(blockerWs, blockerSeq);
    addDependency(ticket.id, blocker.id);
    console.log(
      `servant: ${workspace}#${seq} is blocked by ${blockerLabel(blocker, ticket)} ${blocker.title}`,
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
    const ticket = requireTicket(workspace, seq);
    const blocker = requireTicket(blockerWs, blockerSeq);
    removeDependency(ticket.id, blocker.id);
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
