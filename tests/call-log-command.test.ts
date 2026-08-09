import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { runCommand } from "citty";
import { callLogCommand } from "../src/commands/call-log.ts";
import { openCallLog } from "../src/core/call-log/store.ts";
import { setRootOverride } from "../src/core/paths.ts";

let root: string;
let recent = "";
let older = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "servant-call-log-cmd-"));
  setRootOverride(root);

  const first = await openCallLog({
    workspace: "demo",
    scope: "workspace demo",
    model: "gpt-realtime",
    voice: "marin",
    now: () => new Date("2026-05-01T09:00:00.000Z"),
  });
  first.port.record({ type: "said", who: "user", text: "the older one" });
  first.port.record({ type: "ended", reason: "hung up" });
  await first.close();
  older = first.id;

  const second = await openCallLog({
    workspace: "demo",
    scope: "repo api",
    model: "gpt-realtime",
    voice: "marin",
    now: () => new Date("2026-06-01T09:00:00.000Z"),
  });
  second.port.record({ type: "said", who: "user", text: "the newer one" });
  second.port.record({
    type: "delegation",
    mode: "delegate",
    label: "the auth refactor",
    task: "refactor auth",
    session: "demo-t28",
    status: "launched",
  });
  await second.close();
  recent = second.id;

  const other = await openCallLog({
    workspace: "elsewhere",
    scope: "workspace elsewhere",
    model: "gpt-realtime",
    voice: "marin",
    now: () => new Date("2026-07-01T09:00:00.000Z"),
  });
  await other.close();
});

afterAll(async () => {
  setRootOverride(null);
  await rm(root, { recursive: true, force: true });
});

/** Capture what the command printed, so the listing is asserted as the user sees it. */
const printed: string[] = [];
const realLog = console.log;
console.log = (...args: unknown[]) => printed.push(args.join(" "));
afterEach(() => {
  printed.length = 0;
});
afterAll(() => {
  console.log = realLog;
});

describe("servant call-log", () => {
  test("lists past Summonses newest first when given nothing to open", async () => {
    await runCommand(callLogCommand, { rawArgs: [] });

    const out = printed.join("\n");
    expect(out).toContain(recent);
    expect(out).toContain(older);
    expect(out.indexOf(recent)).toBeLessThan(out.indexOf(older));
  });

  test("says what each one was, so you can recognise it without opening it", async () => {
    await runCommand(callLogCommand, { rawArgs: ["--list", "-w", "demo"] });

    const line = printed.find((l) => l.includes(recent)) ?? "";
    expect(line).toContain("repo api");
    expect(line).toContain("1 turn");
    expect(line).toContain("1 delegated");
    // No `ended` entry was written for this one — it was cut off, and the listing says so.
    expect(line).toContain("cut off");
  });

  test("narrows the listing to one workspace", async () => {
    await runCommand(callLogCommand, { rawArgs: ["-w", "elsewhere"] });
    expect(printed.join("\n")).not.toContain(recent);
  });

  test("opens the most recent Summons without being told its id", async () => {
    await runCommand(callLogCommand, { rawArgs: ["latest", "-w", "demo", "--no-open"] });

    const path = printed.at(-1) ?? "";
    expect(path).toBe(join(root, "call-logs", "rendered", `${recent}.html`));
    expect(await Bun.file(path).text()).toContain("the newer one");
  });

  test("reopens one by enough of its id to be unique", async () => {
    await runCommand(callLogCommand, { rawArgs: ["20260501", "--no-open"] });
    expect(printed.at(-1)).toContain(older);
  });

  test("prints the raw record when asked for JSON, and renders nothing", async () => {
    await runCommand(callLogCommand, { rawArgs: [recent, "--json"] });

    const parsed = JSON.parse(printed.join("\n")) as {
      summary: { id: string };
      records: unknown[];
    };
    expect(parsed.summary.id).toBe(recent);
    expect(parsed.records.length).toBeGreaterThan(0);
  });

  test("refuses to guess when the reference matches nothing", async () => {
    await expect(runCommand(callLogCommand, { rawArgs: ["no-such-log"] })).rejects.toThrow(
      /No Call log matching/,
    );
  });
});
