import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setRootOverride } from "../src/core/paths.ts";

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "servant-init-"));
});

afterAll(async () => {
  setRootOverride(null);
  await rm(scratch, { recursive: true, force: true });
});

beforeEach(() => setRootOverride(scratch));
afterEach(() => setRootOverride(scratch));

const { runInit } = await import("../src/commands/init.ts");
const { configExists, loadConfig, requireInit } = await import("../src/core/config.ts");

function sink() {
  return new PassThrough();
}

describe("runInit", () => {
  test("requireInit throws before init, succeeds after", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "servant-init-gate-"));
    setRootOverride(fresh);
    try {
      await expect(requireInit()).rejects.toThrow(/not initialized/);
      await runInit({ root: fresh, yes: true, interactive: false, output: sink() });
      const cfg = await requireInit();
      expect(cfg.repoSearchRoots).toEqual(["~"]);
    } finally {
      setRootOverride(scratch);
      await rm(fresh, { recursive: true, force: true });
    }
  });

  test("writes default config and syncs assets", async () => {
    await runInit({ root: scratch, yes: true, interactive: false, output: sink() });
    expect(await configExists()).toBe(true);
    const cfg = await loadConfig();
    expect(cfg.repoSearchRoots).toEqual(["~"]);
    expect(await Bun.file(join(scratch, "CLAUDE.md")).exists()).toBe(true);
    expect(
      await Bun.file(join(scratch, ".claude", "commands", "servant", "goal.md")).exists(),
    ).toBe(true);
  });

  test("is idempotent — a second run preserves existing config", async () => {
    await runInit({ root: scratch, yes: true, interactive: false, output: sink() });
    // Hand-edit the config, then re-run: values must survive (no clobber).
    const { saveConfig, CONFIG_VERSION } = await import("../src/core/config.ts");
    await saveConfig({ version: CONFIG_VERSION, repoSearchRoots: ["~/work"], scanMaxDepth: 7 });
    await runInit({ root: scratch, yes: true, interactive: false, output: sink() });
    const cfg = await loadConfig();
    expect(cfg.repoSearchRoots).toEqual(["~/work"]);
    expect(cfg.scanMaxDepth).toBe(7);
  });

  test("--force overwrites config with defaults", async () => {
    const { saveConfig, CONFIG_VERSION } = await import("../src/core/config.ts");
    await saveConfig({ version: CONFIG_VERSION, repoSearchRoots: ["~/work"], scanMaxDepth: 7 });
    await runInit({ root: scratch, yes: true, force: true, interactive: false, output: sink() });
    const cfg = await loadConfig();
    expect(cfg.repoSearchRoots).toEqual(["~"]);
  });

  test("--root points state at the given directory", async () => {
    const alt = await mkdtemp(join(tmpdir(), "servant-init-alt-"));
    try {
      await runInit({ root: alt, yes: true, interactive: false, output: sink() });
      expect(await Bun.file(join(alt, "config.json")).exists()).toBe(true);
    } finally {
      setRootOverride(scratch);
      await rm(alt, { recursive: true, force: true });
    }
  });

  test("interactive: declining the status line installs nothing extra", async () => {
    await runInit({
      root: scratch,
      interactive: true,
      output: sink(),
      confirmFn: async () => false,
    });
    expect(await configExists()).toBe(true);
  });
});
