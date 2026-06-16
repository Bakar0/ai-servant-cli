import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setRootOverride } from "../src/core/paths.ts";

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "servant-cfg-test-"));
  setRootOverride(tmpRoot);
});

afterAll(async () => {
  setRootOverride(null);
  await rm(tmpRoot, { recursive: true, force: true });
});

const { CONFIG_VERSION, defaultConfig, expandHome, loadConfig, saveConfig, resolvedSearchRoots } =
  await import("../src/core/config.ts");

describe("defaultConfig", () => {
  test("returns expected defaults", () => {
    const cfg = defaultConfig();
    expect(cfg.version).toBe(CONFIG_VERSION);
    expect(cfg.repoSearchRoots).toEqual(["~"]);
    expect(cfg.scanMaxDepth).toBe(4);
    expect(cfg.showTips).toBe(true);
  });
});

describe("expandHome", () => {
  test("expands leading ~/", () => {
    expect(expandHome("~/foo/bar")).toBe(join(homedir(), "foo/bar"));
  });
  test("expands bare ~", () => {
    expect(expandHome("~")).toBe(homedir());
  });
  test("leaves absolute paths alone", () => {
    expect(expandHome("/abs/path")).toBe("/abs/path");
  });
  test("does not expand mid-string ~", () => {
    expect(expandHome("/x/~/y")).toBe("/x/~/y");
  });
});

describe("load/save round trip", () => {
  test("loadConfig without file returns defaults and does NOT write", async () => {
    const cfg = await loadConfig();
    expect(cfg).toEqual(defaultConfig());
    const exists = await Bun.file(join(tmpRoot, "config.json")).exists();
    expect(exists).toBe(false);
  });

  test("saveConfig + loadConfig preserves values", async () => {
    const cfg = {
      version: CONFIG_VERSION,
      repoSearchRoots: ["~/code", "/abs/repos"],
      scanMaxDepth: 6,
      showTips: false,
    };
    await saveConfig(cfg);
    const loaded = await loadConfig();
    expect(loaded).toEqual(cfg);
  });

  test("loadConfig defaults showTips to true when absent", async () => {
    await Bun.write(
      join(tmpRoot, "config.json"),
      JSON.stringify({ repoSearchRoots: ["~/x"], scanMaxDepth: 3 }),
    );
    const loaded = await loadConfig();
    expect(loaded.showTips).toBe(true);
  });

  test("loadConfig backfills version on legacy files missing it", async () => {
    await Bun.write(
      join(tmpRoot, "config.json"),
      JSON.stringify({ repoSearchRoots: ["~/x"], scanMaxDepth: 3 }),
    );
    const loaded = await loadConfig();
    expect(loaded.version).toBe(CONFIG_VERSION);
    expect(loaded.repoSearchRoots).toEqual(["~/x"]);
  });

  test("resolvedSearchRoots expands ~ in loaded values", async () => {
    await saveConfig({
      version: CONFIG_VERSION,
      repoSearchRoots: ["~/code", "/abs/repos"],
      scanMaxDepth: 4,
      showTips: true,
    });
    const loaded = await loadConfig();
    const resolved = resolvedSearchRoots(loaded);
    expect(resolved).toEqual([join(homedir(), "code"), "/abs/repos"]);
  });
});
