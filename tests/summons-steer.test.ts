// Reading what the Hands session reports back about a steer, and writing what the Worker reads.
// Pure text in, pure verdict out — no transport, no session, no clock.

import { describe, expect, test } from "bun:test";
import {
  composeSteerMessage,
  composeSteerRequest,
  looksLikeStopInstruction,
  parseSteerAck,
} from "../src/core/summons-steer.ts";

describe("reading the delivery acknowledgement", () => {
  test("an explicit delivered marker is the one thing that counts as delivered", () => {
    expect(parseSteerAck("SERVANT-STEER: delivered")).toEqual({ outcome: "delivered" });
  });

  test("a marker at the end of a chatty reply still counts", () => {
    const reply = [
      "I sent the instruction to ai-servant-t23 with SendMessage.",
      "",
      "SERVANT-STEER: delivered",
    ].join("\n");

    expect(parseSteerAck(reply)).toEqual({ outcome: "delivered" });
  });

  test("an explicit failure carries the reason, so the agent can say why", () => {
    expect(parseSteerAck("SERVANT-STEER: failed — no session called ai-servant-t99")).toEqual({
      outcome: "failed",
      reason: "no session called ai-servant-t99",
    });
  });

  // The whole point of AC 3. A Hands session that answered in prose has told us nothing about
  // whether SendMessage ran, and "probably delivered" is the assumption the ticket forbids.
  test("a reply with no marker is unconfirmed — never delivered", () => {
    expect(parseSteerAck("Sure, I passed that along to the session.")).toEqual({
      outcome: "unconfirmed",
    });
  });

  test("an empty reply is unconfirmed", () => {
    expect(parseSteerAck("   ")).toEqual({ outcome: "unconfirmed" });
  });

  // The request text quotes the markers verbatim, so a reply that echoes the instructions before
  // answering carries two. The verdict is the one it finished on.
  test("the last marker wins, so an echoed template does not decide it", () => {
    const reply = [
      "You asked me to end with SERVANT-STEER: delivered or SERVANT-STEER: failed <reason>.",
      "The session was not in the registry.",
      "SERVANT-STEER: failed — session not found",
    ].join("\n");

    expect(parseSteerAck(reply)).toEqual({ outcome: "failed", reason: "session not found" });
  });

  test("a failure with no reason given still reports as failed", () => {
    expect(parseSteerAck("SERVANT-STEER: failed")).toEqual({ outcome: "failed", reason: "" });
  });
});

describe("what the steered session is told", () => {
  test("the instruction reaches it verbatim — the user's words, not a paraphrase", () => {
    const message = composeSteerMessage({ instruction: "rebase onto main before you go further" });

    expect(message).toContain("rebase onto main before you go further");
  });

  // AC 8. A session that pivots mid-edit leaves the tree in a state nobody asked for, and nothing
  // downstream catches it — so the rule travels with every instruction rather than being assumed.
  test("every instruction carries the next-safe-point rule", () => {
    const message = composeSteerMessage({ instruction: "drop that approach" });

    expect(message.toLowerCase()).toContain("safe point");
    expect(message.toLowerCase()).toContain("never");
  });

  test("a stop is announced as a stop the user confirmed out loud", () => {
    const message = composeSteerMessage({ instruction: "abandon this", stop: true });

    expect(message.toLowerCase()).toContain("confirmed");
  });
});

describe("what the Hands session is asked to do", () => {
  test("it is told which session to message, by the name that is its address", () => {
    const request = composeSteerRequest({
      target: "ai-servant-t23",
      message: "rebase first",
    });

    expect(request).toContain("ai-servant-t23");
    expect(request).toContain("rebase first");
  });

  test("it is told to report with the marker the reply is read for", () => {
    const request = composeSteerRequest({ target: "ai-servant-t23", message: "rebase first" });

    expect(request).toContain("SERVANT-STEER: delivered");
    expect(request).toContain("SERVANT-STEER: failed");
  });

  // Decision 5: messaging is a push channel. A relay that waits for the Worker to answer would
  // burn the Summons' two-minute deadline waiting on a session that applies things deliberately
  // later — and would report "applied" as if it were "delivered", which is the conflation AC 3 is.
  test("it is told not to wait for the session to act on it", () => {
    const request = composeSteerRequest({ target: "ai-servant-t23", message: "rebase first" });

    expect(request.toLowerCase()).toContain("do not wait");
  });
});

describe("spotting an instruction that is really a stop", () => {
  test.each([
    "stop what you are doing",
    "abandon that work",
    "give up on the refactor",
    "kill that session",
    "cancel it",
    "drop everything and stand down",
  ])("%p is stop-shaped, so it cannot slip past the gate as a redirect", (text) => {
    expect(looksLikeStopInstruction(text)).toBe(true);
  });

  test.each([
    "rebase onto main before you go further",
    "also check the tests",
    "drop that approach and use a map instead",
    "stop using the old parser and switch to the new one",
  ])("%p is a redirect, not a stop", (text) => {
    expect(looksLikeStopInstruction(text)).toBe(false);
  });
});

// Found in review. The gerund exception that lets "stop using the old parser" through was also
// letting "stop everything" through, because "everything" ends in -ing. False negatives here are
// the expensive direction: an un-Guarded stop destroys work nothing downstream catches.
describe("stop-shaped instructions the gerund exception used to swallow", () => {
  test.each([
    "stop everything",
    "stop everything you are doing",
    "abort",
    "abort the run",
    "shut it down",
    "halt",
    "drop it",
    "cancel",
    "wrap it up",
    "call it off",
  ])("%p is stop-shaped", (text) => {
    expect(looksLikeStopInstruction(text)).toBe(true);
  });

  test.each([
    "stop using the old parser and switch to the new one",
    "stop calling that endpoint twice",
    "cancel the pending timeout in the retry loop",
    "abort the fetch when the signal fires",
  ])("%p is still a redirect about code, not a stop", (text) => {
    expect(looksLikeStopInstruction(text)).toBe(false);
  });
});
