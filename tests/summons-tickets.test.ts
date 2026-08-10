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
    const tickets = createSummonsTickets({ hubRepo: "acme/hub", workspace: "demo", ghRunner });

    expect(await tickets.claim(23)).toEqual({ known: true, session: "demo-t23" });
  });

  test("a ticket with no Claim is known to have nobody on it", async () => {
    const { ghRunner } = fakeGh(() => JSON.stringify({ comments: [] }));
    const tickets = createSummonsTickets({ hubRepo: "acme/hub", workspace: "demo", ghRunner });

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
    const tickets = createSummonsTickets({ hubRepo: "acme/hub", workspace: "demo", ghRunner });

    expect(await tickets.claim(23)).toEqual({ known: true, session: null });
  });

  test("a hub that could not be reached is unknown, so the caller can fail closed", async () => {
    const tickets = createSummonsTickets({
      hubRepo: "acme/hub",
      workspace: "demo",
      ghRunner: async () => {
        throw new Error("gh: not authenticated");
      },
    });

    expect(await tickets.claim(23)).toEqual({ known: false });
  });
});

describe("filing a ticket by voice", () => {
  const issueUrl = "https://github.com/acme/hub/issues/42";

  test("files it in the hub, labeled so `servant tasks` lists it with everything else", async () => {
    const { ghRunner, calls } = fakeGh(() => `${issueUrl}\n`);
    const tickets = createSummonsTickets({
      hubRepo: "acme/hub",
      workspace: "demo",
      ghRunner,
    });

    const filed = await tickets.file({ title: "Pin the language", body: "Wrong script." });

    expect(filed).toEqual({ number: 42, url: issueUrl });
    const args = calls[0] as string[];
    expect(args.slice(0, 5)).toEqual(["issue", "create", "--repo", "acme/hub", "--label"]);
    expect(args).toContain("ws:demo");
    expect(args[args.indexOf("--title") + 1]).toBe("Pin the language");
    // Deliberately not labeled `ticket`: in this hub that means a tracer bullet from /to-tickets,
    // and something said out loud in a conversation has not been through that.
    expect(args).not.toContain("ticket");
  });

  test("the body says where it came from, so a ticket filed by voice can be traced back", async () => {
    const { ghRunner, calls } = fakeGh(() => `${issueUrl}\n`);
    const tickets = createSummonsTickets({
      hubRepo: "acme/hub",
      workspace: "demo",
      callLogId: "20260810-abc",
      ghRunner,
    });

    await tickets.file({ title: "Pin the language", body: "Wrong script." });

    const body = (calls[0] as string[])[(calls[0] as string[]).indexOf("--body") + 1] as string;
    expect(body).toContain("Wrong script.");
    expect(body).toContain("servant call-log 20260810-abc");
  });

  test("a hub that refuses throws, so the agent can say nothing was filed", async () => {
    const tickets = createSummonsTickets({
      hubRepo: "acme/hub",
      workspace: "demo",
      ghRunner: async () => {
        throw new Error("gh: label not found");
      },
    });

    await expect(tickets.file({ title: "t", body: "b" })).rejects.toThrow("label not found");
  });

  test("an answer with no issue URL in it is a failure, not a ticket nobody can find", async () => {
    const tickets = createSummonsTickets({
      hubRepo: "acme/hub",
      workspace: "demo",
      ghRunner: async () => "Creating issue in acme/hub\n",
    });

    await expect(tickets.file({ title: "t", body: "b" })).rejects.toThrow(/could not/i);
  });
});

describe("noting a change on a ticket", () => {
  test("writes the note to the ticket in the configured hub", async () => {
    const { ghRunner, calls } = fakeGh(() => "");
    const tickets = createSummonsTickets({ hubRepo: "acme/hub", workspace: "demo", ghRunner });

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
      workspace: "demo",
      ghRunner: async () => {
        throw new Error("gh: issue not found");
      },
    });

    await expect(tickets.comment(23, "note")).rejects.toThrow("issue not found");
  });
});
