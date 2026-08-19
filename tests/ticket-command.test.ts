// The board's CLI surface — the one the generated agent prose points at, driven the way an agent
// drives it. A real SQLite board in a temp servant root; nothing here is faked.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ArgsDef, type CommandDef, runCommand } from "citty";
import {
  carryComment,
  closeBoard,
  requireTicket,
  ticketActions,
  updateTicket,
} from "../src/core/board/store.ts";
import { claimCommand } from "../src/commands/claim.ts";
import { tasksCommand } from "../src/commands/tasks.ts";
import { ticketCommand } from "../src/commands/ticket.ts";
import { setRootOverride } from "../src/core/paths.ts";

let tmpRoot: string;
const WS = "demo";

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "servant-ticket-cmd-"));
  setRootOverride(tmpRoot);
});

afterEach(async () => {
  closeBoard();
  setRootOverride(null);
  await rm(tmpRoot, { recursive: true, force: true });
});

/** Run a subcommand with the temp root pinned, capturing whatever it printed. */
async function run<T extends ArgsDef>(
  command: CommandDef<T>,
  ...rawArgs: string[]
): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await runCommand(command, { rawArgs: [...rawArgs, "--root", tmpRoot, "--ws", WS] });
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

const newTicket = async (title: string, ...extra: string[]) => {
  const out = await run(ticketCommand, "new", "--title", title, "--json", ...extra);
  return JSON.parse(out) as { number: number; workspace: string; id: number; url: string };
};

describe("servant ticket new", () => {
  test("files a ticket, numbering it small and per board", async () => {
    expect((await newTicket("first")).number).toBe(1);
    expect((await newTicket("second")).number).toBe(2);
    expect(requireTicket(WS, 2).title).toBe("second");
  });

  test("carries body, labels and status", async () => {
    const filed = await newTicket(
      "specced",
      "--body",
      "the whole spec",
      "--labels",
      "spec,ready-for-agent",
      "--status",
      "in_progress",
    );
    expect(requireTicket(WS, filed.number)).toMatchObject({
      body: "the whole spec",
      labels: ["spec", "ready-for-agent"],
      status: "in_progress",
    });
  });

  test("a map child is linked to its map structurally, not by a line in the body", async () => {
    const map = await newTicket("the map", "--labels", "wayfinder:map");
    const child = await newTicket("a question", "--parent", String(map.number));
    expect(requireTicket(WS, child.number).parentId).toBe(requireTicket(WS, map.number).id);
  });

  test("an unknown status is refused rather than stored", async () => {
    await expect(run(ticketCommand, "new", "--title", "x", "--status", "wibble")).rejects.toThrow(
      /status/i,
    );
  });
});

describe("servant ticket show / comment / label / close", () => {
  test("show reports the ticket, its edges in both directions, and its comments", async () => {
    const core = await newTicket("core");
    const tenant = await newTicket("tenant");
    await run(ticketCommand, "block", String(tenant.number), "--on", String(core.number));
    await run(ticketCommand, "comment", String(tenant.number), "--body", "found the cause");

    const shown = await run(ticketCommand, "show", String(tenant.number));
    expect(shown).toContain("tenant");
    expect(shown).toContain(`#${core.number} core`);
    expect(shown).toContain("found the cause");

    const blocker = await run(ticketCommand, "show", String(core.number));
    expect(blocker).toContain(`blocks:`);
    expect(blocker).toContain(`#${tenant.number} tenant`);
  });

  test("show names a carried comment's author, and indents every line of it", async () => {
    const t = await newTicket("viewer");
    carryComment(requireTicket(WS, t.number), {
      externalId: "IC_1",
      actor: "Barak-Zen",
      body: "Variant B won.\n\n> the criterion needed refining\n",
      at: "2026-08-14T09:00:00Z",
    });
    const shown = await run(ticketCommand, "show", String(t.number));
    expect(shown).toContain("— 2026-08-14T09:00:00Z (Barak-Zen)");
    expect(shown).toContain("    Variant B won.\n\n    > the criterion needed refining");
  });

  test("--history prints how the ticket got here, and the default read does not", async () => {
    const t = await newTicket("moved");
    await run(ticketCommand, "label", String(t.number), "--add", "ticket,ready-for-agent");
    await run(ticketCommand, "status", String(t.number), "in_progress");
    await run(ticketCommand, "comment", String(t.number), "--body", "picked it up");

    const plain = await run(ticketCommand, "show", String(t.number));
    expect(plain).toContain("picked it up");
    expect(plain).not.toContain("history:");

    const shown = await run(ticketCommand, "show", String(t.number), "--history");
    const history = shown.slice(shown.indexOf("history:"));
    expect(history).toContain("filed");
    expect(history).toContain("labels: ticket, ready-for-agent");
    expect(history).toContain("status: in_progress");
    // Comments stay in their own block: the two streams read differently, so they render apart.
    expect(history).not.toContain("picked it up");

    const asJson = await run(ticketCommand, "show", String(t.number), "--history", "--json");
    expect(JSON.parse(asJson).history.map((h: { kind: string }) => h.kind)).toEqual([
      "created",
      "labels",
      "status",
    ]);
    expect(JSON.parse(await run(ticketCommand, "show", String(t.number), "--json")).history).toBe(
      undefined,
    );
  });

  test("--history shows an emptied label set as a value, not a dangling colon", async () => {
    const t = await newTicket("stripped", "--labels", "ticket");
    await run(ticketCommand, "label", String(t.number), "--remove", "ticket");

    const shown = await run(ticketCommand, "show", String(t.number), "--history");
    expect(shown).toContain("labels: —");
    expect(shown).not.toMatch(/labels: *$/m);
  });

  test("--history names the importer, and says nothing where the actor is servant itself", async () => {
    const t = await newTicket("carried");
    updateTicket(requireTicket(WS, t.number), { status: "done" }, { actor: "import" });

    const shown = await run(ticketCommand, "show", String(t.number), "--history");
    expect(shown).toContain("status: done (import)");
    // "servant" is the default actor and names nobody, so it is not printed.
    expect(shown).toMatch(/ {2}filed$/m);
  });

  test("labels are added and removed with no label needing to exist first", async () => {
    const t = await newTicket("labelled", "--labels", "ticket");
    await run(ticketCommand, "label", String(t.number), "--add", "needs-info,repo:alpha");
    await run(ticketCommand, "label", String(t.number), "--remove", "ticket");
    expect(requireTicket(WS, t.number).labels).toEqual(["needs-info", "repo:alpha"]);
  });

  test("closing records the comment and frees whatever it blocked", async () => {
    const core = await newTicket("core");
    const tenant = await newTicket("tenant");
    await run(ticketCommand, "block", String(tenant.number), "--on", String(core.number));
    await run(ticketCommand, "close", String(core.number), "--comment", "shipped");

    expect(requireTicket(WS, core.number).status).toBe("done");
    expect(ticketActions(requireTicket(WS, core.number)).map((a) => a.kind)).toEqual([
      "created",
      "comment",
      "status",
    ]);
    const frontier = await run(tasksCommand, "--frontier", "--json");
    expect(JSON.parse(frontier).ready.map((t: { number: number }) => t.number)).toEqual([
      tenant.number,
    ]);
  });

  test("a ticket that is not on this board fails loudly rather than dispatching the wrong work", async () => {
    await expect(run(ticketCommand, "show", "99")).rejects.toThrow(/No ticket #99/);
  });
});

describe("servant ticket block", () => {
  test("a cycle is refused at the moment it is added", async () => {
    const a = await newTicket("a");
    const b = await newTicket("b");
    await run(ticketCommand, "block", String(b.number), "--on", String(a.number));
    await expect(
      run(ticketCommand, "block", String(a.number), "--on", String(b.number)),
    ).rejects.toThrow(/cycle/i);
  });

  test("unblock drops the edge and the ticket returns to the frontier", async () => {
    const a = await newTicket("a");
    const b = await newTicket("b");
    await run(ticketCommand, "block", String(b.number), "--on", String(a.number));
    await run(ticketCommand, "unblock", String(b.number), "--on", String(a.number));
    expect(requireTicket(WS, b.number).blockedBy).toEqual([]);
  });
});

describe("servant tasks", () => {
  test("lists the board and reports the frontier with no network involved", async () => {
    const core = await newTicket("core");
    const waiting = await newTicket("waiting");
    await run(ticketCommand, "block", String(waiting.number), "--on", String(core.number));

    const listed = await run(tasksCommand);
    expect(listed).toContain("core");
    expect(listed).toContain(WS);

    const frontier = JSON.parse(await run(tasksCommand, "--frontier", "--json")) as {
      ready: { number: number }[];
      blocked: { number: number; blockedBy: number[] }[];
    };
    expect(frontier.ready.map((t) => t.number)).toEqual([core.number]);
    expect(frontier.blocked[0]?.blockedBy).toEqual([core.number]);
  });
});

describe("servant claim", () => {
  test("claims, transfers, releases, and keeps the history", async () => {
    const t = await newTicket("carried");
    await run(claimCommand, String(t.number), "--session", `${WS}-t${t.number}`);
    expect(requireTicket(WS, t.number).claim?.session).toBe(`${WS}-t${t.number}`);

    const again = await run(claimCommand, String(t.number), "--session", `${WS}-t${t.number}`);
    expect(again).toContain("already claimed");

    await run(claimCommand, String(t.number), "--session", "other-session");
    expect(requireTicket(WS, t.number).claim?.session).toBe("other-session");

    await run(claimCommand, String(t.number), "--release", "--session", "other-session");
    expect(requireTicket(WS, t.number).claim).toBeNull();

    const history = await run(claimCommand, String(t.number), "--history");
    expect(history).toContain("claimed");
    expect(history).toContain("transferred");
    expect(history).toContain("released");
  });

  test("a claimed ticket leaves the ready bucket", async () => {
    const t = await newTicket("carried");
    await run(claimCommand, String(t.number), "--session", `${WS}-t${t.number}`);
    const frontier = JSON.parse(await run(tasksCommand, "--frontier", "--json")) as {
      ready: unknown[];
      stale: unknown[];
      inFlight: { claim: { session: string } }[];
    };
    expect(frontier.ready).toEqual([]);
    // Whether it reads stale or in-flight depends on the session registry this host has; both
    // are refusals to hand it out twice, and neither is `ready`.
    expect(frontier.stale.length + frontier.inFlight.length).toBe(1);
  });
});

describe("addressing a ticket without --ws", () => {
  test("the session name is enough, because it already encodes the board", async () => {
    const t = await newTicket("carried");
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    try {
      await runCommand(claimCommand, {
        rawArgs: [String(t.number), "--session", `${WS}-t${t.number}`, "--root", tmpRoot],
      });
    } finally {
      console.log = original;
    }
    expect(requireTicket(WS, t.number).claim?.session).toBe(`${WS}-t${t.number}`);
  });
});
