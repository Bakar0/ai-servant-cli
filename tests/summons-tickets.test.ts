// The outside of the tickets seam, against a fake `gh` — no network, no hub, no real issue.

import { describe, expect, test } from "bun:test";
import type { ClaimGhRunner } from "../src/core/claims.ts";
import { createSummonsTickets } from "../src/core/summons-tickets.ts";

function fakeGh(answer: (args: readonly string[]) => string) {
  const calls: string[][] = [];
  const ghRunner: ClaimGhRunner = async (args) => {
    calls.push([...args]);
    return answer(args);
  };
  return { ghRunner, calls };
}

const claimComment = (session: string) =>
  JSON.stringify({
    comments: [
      { body: `<!-- servant:claim -->\n**Claim:** \`${session}\` — since 2026-08-09T00:00:00Z` },
    ],
  });

describe("who holds a ticket, as steering needs it", () => {
  test("a held Claim names the session carrying it", async () => {
    const { ghRunner } = fakeGh(() => claimComment("demo-t23"));
    const tickets = createSummonsTickets({ hubRepo: "acme/hub", ghRunner });

    expect(await tickets.claim(23)).toEqual({ known: true, session: "demo-t23" });
  });

  test("a ticket with no Claim is known to have nobody on it", async () => {
    const { ghRunner } = fakeGh(() => JSON.stringify({ comments: [] }));
    const tickets = createSummonsTickets({ hubRepo: "acme/hub", ghRunner });

    expect(await tickets.claim(23)).toEqual({ known: true, session: null });
  });

  // A released Claim is not a session still reachable at that name — steering must refuse it.
  test("a released Claim reads as nobody, not as its last carrier", async () => {
    const { ghRunner } = fakeGh(() =>
      JSON.stringify({
        comments: [
          { body: "<!-- servant:claim -->\n**Claim:** `demo-t23` — since 2026-08-09T00:00:00Z" },
          {
            body: "<!-- servant:claim -->\n**Claim released:** `demo-t23` — at 2026-08-09T01:00:00Z",
          },
        ],
      }),
    );
    const tickets = createSummonsTickets({ hubRepo: "acme/hub", ghRunner });

    expect(await tickets.claim(23)).toEqual({ known: true, session: null });
  });

  test("a hub that could not be reached is unknown, so the caller can fail closed", async () => {
    const tickets = createSummonsTickets({
      hubRepo: "acme/hub",
      ghRunner: async () => {
        throw new Error("gh: not authenticated");
      },
    });

    expect(await tickets.claim(23)).toEqual({ known: false });
  });
});

describe("noting a change on a ticket", () => {
  test("writes the note to the ticket in the configured hub", async () => {
    const { ghRunner, calls } = fakeGh(() => "");
    const tickets = createSummonsTickets({ hubRepo: "acme/hub", ghRunner });

    await tickets.comment(23, "the criteria changed");

    expect(calls[0]).toEqual([
      "issue",
      "comment",
      "23",
      "--repo",
      "acme/hub",
      "--body",
      "the criteria changed",
    ]);
  });

  test("a hub that refuses the write throws, so the caller can say the note did not land", async () => {
    const tickets = createSummonsTickets({
      hubRepo: "acme/hub",
      ghRunner: async () => {
        throw new Error("gh: issue not found");
      },
    });

    await expect(tickets.comment(23, "note")).rejects.toThrow("issue not found");
  });
});
