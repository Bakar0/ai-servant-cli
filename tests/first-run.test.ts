import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";

let scratch: string;
const originalEnv = process.env.AI_SERVANT_ROOT;

function stringStream(s: string): Readable {
  const r = new Readable();
  r.push(s);
  r.push(null);
  return r;
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "servant-first-run-"));
  process.env.AI_SERVANT_ROOT = scratch;
});

afterAll(async () => {
  if (originalEnv === undefined) Reflect.deleteProperty(process.env, "AI_SERVANT_ROOT");
  else process.env.AI_SERVANT_ROOT = originalEnv;
  await rm(scratch, { recursive: true, force: true });
});

const { ensureConfigInteractive } = await import("../src/commands/repo/first-run.ts");
const { configExists, loadConfig } = await import("../src/core/config.ts");

describe("ensureConfigInteractive", () => {
  test("non-interactive: returns defaults without writing", async () => {
    const cfg = await ensureConfigInteractive({
      input: stringStream(""),
      output: new PassThrough(),
      forceInteractive: false,
    });
    expect(cfg.repoSearchRoots).toEqual(["~/private", "~/code"]);
    expect(await configExists()).toBe(false);
  });

  test("interactive with empty input: accepts defaults and writes config", async () => {
    const cfg = await ensureConfigInteractive({
      input: stringStream("\n"),
      output: new PassThrough(),
      forceInteractive: true,
    });
    expect(cfg.repoSearchRoots).toEqual(["~/private", "~/code"]);
    expect(await configExists()).toBe(true);
    const loaded = await loadConfig();
    expect(loaded.repoSearchRoots).toEqual(["~/private", "~/code"]);
  });

  test("subsequent call with config present returns it without re-prompting", async () => {
    // No input provided — if it tried to prompt it would hang or read nothing.
    const cfg = await ensureConfigInteractive({
      input: stringStream(""),
      output: new PassThrough(),
      forceInteractive: true,
    });
    expect(cfg.repoSearchRoots).toEqual(["~/private", "~/code"]);
  });
});
