import { describe, expect, test } from "bun:test";
import {
  type ClaimGhRunner,
  claimTicket,
  parseClaim,
  readClaim,
  readClaimResult,
  releaseTicketClaim,
} from "../src/core/claims.ts";

const AT = "2026-08-08T09:00:00.000Z";

/** A fake `gh`: records every invocation, answers `issue view` from the comments it is seeded with. */
function fakeGh(comments: { body: string }[] = []) {
  const calls: string[][] = [];
  const runner: ClaimGhRunner = async (args) => {
    calls.push([...args]);
    if (args[0] === "issue" && args[1] === "view") return JSON.stringify({ comments });
    if (args[0] === "issue" && args[1] === "comment") {
      comments.push({ body: args[args.indexOf("--body") + 1] ?? "" });
    }
    return "";
  };
  return { runner, calls, comments };
}

const bodies = (calls: string[][]) =>
  calls.filter((c) => c[1] === "comment").map((c) => c[c.indexOf("--body") + 1] ?? "");

describe("reading a ticket's Claim", () => {
  test("a ticket nobody has claimed has no Claim", () => {
    expect(parseClaim([{ body: "looks good to me" }])).toBeNull();
  });

  test("the latest claim comment is the one that counts", () => {
    const claim = parseClaim([
      { body: "<!-- servant:claim -->\n**Claim:** `ws-t7` — since 2026-08-01T00:00:00Z" },
      { body: "unrelated discussion" },
      { body: "<!-- servant:claim -->\n**Claim:** `ws-t7-redo` — since 2026-08-05T00:00:00Z" },
    ]);
    expect(claim).toEqual({ kind: "held", session: "ws-t7-redo", at: "2026-08-05T00:00:00Z" });
  });

  test("a transfer names the session taking it over, not the one letting go", () => {
    const claim = parseClaim([
      {
        body: "<!-- servant:claim -->\n**Claim transferred:** `old-session` → `new-session` — since 2026-08-06T00:00:00Z",
      },
    ]);
    expect(claim?.session).toBe("new-session");
  });

  test("a released ticket reads as released, not as held", () => {
    const claim = parseClaim([
      { body: "<!-- servant:claim -->\n**Claim:** `ws-t7` — since 2026-08-01T00:00:00Z" },
      { body: "<!-- servant:claim -->\n**Claim released:** `ws-t7` — at 2026-08-02T00:00:00Z" },
    ]);
    expect(claim?.kind).toBe("released");
  });

  test("an unreadable ticket is 'no claim known' rather than a failure", async () => {
    const claim = await readClaim("acme/hub", 7, {
      ghRunner: async () => {
        throw new Error("gh: not authenticated");
      },
    });
    expect(claim).toBeNull();
  });
});

// Steering is scoped to sessions holding a Claim, so it has to fail closed — and it cannot, if a
// hub it could not reach is indistinguishable from a ticket nobody has claimed (ADR 0010).
describe("telling an unreadable ticket from an unclaimed one", () => {
  test("a ticket that read fine and has no Claim is known", async () => {
    const { runner } = fakeGh([{ body: "looks good to me" }]);

    expect(await readClaimResult("acme/hub", 7, { ghRunner: runner })).toEqual({
      known: true,
      claim: null,
    });
  });

  test("a ticket that read fine reports the Claim it carries", async () => {
    const { runner } = fakeGh([
      { body: "<!-- servant:claim -->\n**Claim:** `ws-t7` — since 2026-08-01T00:00:00Z" },
    ]);

    expect(await readClaimResult("acme/hub", 7, { ghRunner: runner })).toEqual({
      known: true,
      claim: { kind: "held", session: "ws-t7", at: "2026-08-01T00:00:00Z" },
    });
  });

  test("a hub that could not be reached is unknown, never 'nobody has claimed it'", async () => {
    const result = await readClaimResult("acme/hub", 7, {
      ghRunner: async () => {
        throw new Error("gh: not authenticated");
      },
    });

    expect(result).toEqual({ known: false });
  });

  test("an answer that is not JSON is unknown too — the shape moved, so nothing is known", async () => {
    const result = await readClaimResult("acme/hub", 7, { ghRunner: async () => "not json" });

    expect(result).toEqual({ known: false });
  });
});

describe("taking a Claim", () => {
  test("names the session and the time, and marks the ticket claimed", async () => {
    const { runner, calls } = fakeGh();

    await claimTicket("acme/hub", 17, "ai-servant-t17", { ghRunner: runner, now: AT });

    expect(bodies(calls)[0]).toContain("`ai-servant-t17`");
    expect(bodies(calls)[0]).toContain(AT);
    expect(calls.some((c) => c.includes("--add-assignee"))).toBe(true);
  });

  test("re-delegating transfers the Claim rather than adding a second one", async () => {
    const { runner, calls, comments } = fakeGh([
      { body: "<!-- servant:claim -->\n**Claim:** `ai-servant-t17` — since 2026-08-01T00:00:00Z" },
    ]);

    const result = await claimTicket("acme/hub", 17, "ai-servant-t17-redo", {
      ghRunner: runner,
      now: AT,
    });

    expect(result.transferredFrom).toBe("ai-servant-t17");
    expect(bodies(calls)[0]).toContain("transferred");
    // Reading the ticket back finds one live Claim, and it is the new session's.
    expect(parseClaim(comments)).toEqual({
      kind: "held",
      session: "ai-servant-t17-redo",
      at: AT,
    });
  });

  test("claiming what this session already holds changes nothing", async () => {
    const { runner, calls } = fakeGh([
      { body: "<!-- servant:claim -->\n**Claim:** `ai-servant-t17` — since 2026-08-01T00:00:00Z" },
    ]);

    const result = await claimTicket("acme/hub", 17, "ai-servant-t17", {
      ghRunner: runner,
      now: AT,
    });

    expect(result.alreadyHeld).toBe(true);
    expect(bodies(calls)).toEqual([]);
  });
});

describe("releasing a Claim", () => {
  test("records who released it and unassigns the ticket", async () => {
    const { runner, calls, comments } = fakeGh([
      { body: "<!-- servant:claim -->\n**Claim:** `ai-servant-t17` — since 2026-08-01T00:00:00Z" },
    ]);

    await releaseTicketClaim("acme/hub", 17, "ai-servant-t17", { ghRunner: runner, now: AT });

    expect(bodies(calls)[0]).toContain("released");
    expect(calls.some((c) => c.includes("--remove-assignee"))).toBe(true);
    expect(parseClaim(comments)?.kind).toBe("released");
  });
});
