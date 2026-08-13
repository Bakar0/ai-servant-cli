// The outside of the tickets seam, against a real board in a temp servant root — no network, no
// hub, and no fake store: the whole point of the board is that a test can have the real thing.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeBoard, createTicket, requireTicket, ticketActions } from "../src/core/board/store.ts";
import { claimTicket, releaseTicketClaim } from "../src/core/claims.ts";
import { setRootOverride } from "../src/core/paths.ts";
import { createSummonsTickets } from "../src/core/summons-tickets.ts";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "servant-summons-tickets-"));
  setRootOverride(tmpRoot);
});

afterEach(async () => {
  closeBoard();
  setRootOverride(null);
  await rm(tmpRoot, { recursive: true, force: true });
});

const AT = "2026-08-09T00:00:00.000Z";
const tickets = (over: { callLogId?: string } = {}) =>
  createSummonsTickets({ workspace: "demo", ...over });

function seed(seq = 23): number {
  return createTicket({ workspace: "demo", title: "a ticket", seq, now: AT }).seq;
}

describe("who holds a ticket, as steering needs it", () => {
  test("a held Claim names the session carrying it", async () => {
    seed();
    await claimTicket("demo", 23, "demo-t23", { now: AT });
    expect(await tickets().claim(23)).toEqual({ known: true, session: "demo-t23" });
  });

  test("a ticket with no Claim is known to have nobody on it", async () => {
    seed();
    expect(await tickets().claim(23)).toEqual({ known: true, session: null });
  });

  // A released Claim is not a session still reachable at that name — steering must refuse it.
  test("a released Claim reads as nobody, not as its last carrier", async () => {
    seed();
    await claimTicket("demo", 23, "demo-t23", { now: AT });
    await releaseTicketClaim("demo", 23, "demo-t23", { now: "2026-08-09T01:00:00.000Z" });
    expect(await tickets().claim(23)).toEqual({ known: true, session: null });
  });

  test("a ticket that is not on the board is unknown, so the caller can fail closed", async () => {
    expect(await tickets().claim(23)).toEqual({ known: false });
  });
});

describe("filing a ticket by voice", () => {
  test("files it on this workspace's board, so `servant tasks` lists it with everything else", async () => {
    const filed = await tickets().file({ title: "Pin the language", body: "Wrong script." });

    expect(filed.number).toBe(1);
    expect(filed.url).toBe("http://127.0.0.1:7787/w/demo/t/1");
    const ticket = requireTicket("demo", filed.number);
    expect(ticket.title).toBe("Pin the language");
    expect(ticket.workspace).toBe("demo");
    // Deliberately unlabeled: `ticket` in this backlog means a tracer bullet from /to-tickets, and
    // something said out loud in a conversation has not been through that.
    expect(ticket.labels).toEqual([]);
  });

  test("the body says where it came from, so a ticket filed by voice can be traced back", async () => {
    const filed = await tickets({ callLogId: "20260810-abc" }).file({
      title: "Pin the language",
      body: "Wrong script.",
    });
    const body = requireTicket("demo", filed.number).body;
    expect(body).toContain("Wrong script.");
    expect(body).toContain("servant call-log 20260810-abc");
  });
});

describe("noting a change on a ticket", () => {
  test("writes the note onto the ticket's own history", async () => {
    const seq = seed();
    await tickets().comment(seq, "the criteria changed");
    const comments = ticketActions(requireTicket("demo", seq).id).filter(
      (a) => a.kind === "comment",
    );
    expect(comments.map((c) => c.body)).toEqual(["the criteria changed"]);
  });

  test("a ticket that is not there throws, so the caller can say the note did not land", async () => {
    await expect(tickets().comment(99, "note")).rejects.toThrow(/No ticket #99/);
  });
});
