import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeBoard, createTicket, requireTicket, ticketActions } from "../src/core/board/store.ts";
import {
  claimHistory,
  claimTicket,
  readClaim,
  readClaimResult,
  releaseTicketClaim,
} from "../src/core/claims.ts";
import { setRootOverride } from "../src/core/paths.ts";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "servant-claims-"));
  setRootOverride(tmpRoot);
});

afterEach(async () => {
  closeBoard();
  setRootOverride(null);
  await rm(tmpRoot, { recursive: true, force: true });
});

const AT = "2026-06-16T12:00:00.000Z";
const LATER = "2026-06-16T13:00:00.000Z";
const LATEST = "2026-06-16T14:00:00.000Z";

function ticket(seq = 17): number {
  return createTicket({ workspace: "ai-servant", title: "a ticket", seq, now: AT }).seq;
}

describe("reading a Claim", () => {
  test("an unclaimed ticket reads as known-and-nobody, not as unknown", async () => {
    ticket();
    expect(await readClaimResult("ai-servant", 17)).toEqual({ known: true, claim: null });
  });

  test("a ticket that is not on the board reads as unknown", async () => {
    // Fail-closed: steering is scoped to Claim holders, and a ticket we cannot find is not the
    // same answer as a ticket nobody holds (ADR-0010 decision 9, kept by ADR-0011).
    expect(await readClaimResult("ai-servant", 99)).toEqual({ known: false });
    expect(await readClaimResult("no-such-workspace", 1)).toEqual({ known: false });
  });

  test("readClaim flattens unknown to no-claim, never to a hard stop", async () => {
    expect(await readClaim("ai-servant", 99)).toBeNull();
  });
});

describe("taking a Claim", () => {
  test("claiming records the session and the time", async () => {
    ticket();
    const result = await claimTicket("ai-servant", 17, "ai-servant-t17", { now: AT });
    expect(result).toEqual({ transferredFrom: null, alreadyHeld: false });
    expect(await readClaim("ai-servant", 17)).toEqual({ session: "ai-servant-t17", at: AT });
  });

  test("re-claiming a ticket this session already holds is a no-op", async () => {
    ticket();
    await claimTicket("ai-servant", 17, "ai-servant-t17", { now: AT });
    const again = await claimTicket("ai-servant", 17, "ai-servant-t17", { now: LATER });
    expect(again).toEqual({ transferredFrom: null, alreadyHeld: true });
    // Neither the "since" nor the history moved — a retried spawn leaves no trace.
    expect(await readClaim("ai-servant", 17)).toEqual({ session: "ai-servant-t17", at: AT });
    expect(await claimHistory("ai-servant", 17)).toHaveLength(1);
  });

  test("claiming a ticket someone else holds is an explicit, recorded transfer", async () => {
    ticket();
    await claimTicket("ai-servant", 17, "ai-servant-t17", { now: AT });
    const result = await claimTicket("ai-servant", 17, "ai-servant-t17-redo", { now: LATER });
    expect(result).toEqual({ transferredFrom: "ai-servant-t17", alreadyHeld: false });
    expect(await readClaim("ai-servant", 17)).toEqual({
      session: "ai-servant-t17-redo",
      at: LATER,
    });
    expect(await claimHistory("ai-servant", 17)).toEqual([
      { kind: "claimed", session: "ai-servant-t17", at: AT, from: null },
      { kind: "transferred", session: "ai-servant-t17-redo", at: LATER, from: "ai-servant-t17" },
    ]);
  });

  test("claiming a ticket that is not on the board fails loudly", async () => {
    expect(claimTicket("ai-servant", 99, "ai-servant-t99")).rejects.toThrow(/No ticket #99/);
  });
});

describe("releasing a Claim", () => {
  test("release supersedes the hold, and the ticket reads as nobody's", async () => {
    ticket();
    await claimTicket("ai-servant", 17, "ai-servant-t17", { now: AT });
    await releaseTicketClaim("ai-servant", 17, "ai-servant-t17", { now: LATER });
    expect(await readClaim("ai-servant", 17)).toBeNull();
    expect(await readClaimResult("ai-servant", 17)).toEqual({ known: true, claim: null });
  });

  test("the most recent record wins across a release and a re-claim", async () => {
    ticket();
    await claimTicket("ai-servant", 17, "ai-servant-t17", { now: AT });
    await releaseTicketClaim("ai-servant", 17, "ai-servant-t17", { now: LATER });
    await claimTicket("ai-servant", 17, "ai-servant-t17-again", { now: LATEST });
    expect(await readClaim("ai-servant", 17)).toEqual({
      session: "ai-servant-t17-again",
      at: LATEST,
    });
    // A re-claim after a release is not a transfer: nobody was holding it.
    expect((await claimHistory("ai-servant", 17)).map((r) => r.kind)).toEqual([
      "claimed",
      "released",
      "claimed",
    ]);
  });

  test("releasing an unheld ticket is quiet, and still recorded", async () => {
    ticket();
    await releaseTicketClaim("ai-servant", 17, "ai-servant-t17", { now: AT });
    expect(await readClaim("ai-servant", 17)).toBeNull();
    expect((await claimHistory("ai-servant", 17)).map((r) => r.kind)).toEqual(["released"]);
  });

  test("history survives on the ticket's own append-only log", async () => {
    const seq = ticket();
    await claimTicket("ai-servant", seq, "ai-servant-t17", { now: AT });
    await releaseTicketClaim("ai-servant", seq, "ai-servant-t17", { now: LATER });
    // Keyed on the global id, as every stored thing is.
    const kinds = ticketActions(requireTicket("ai-servant", seq)).map((a) => a.kind);
    expect(kinds).toEqual(["created", "claimed", "released"]);
  });
});
