import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;
const originalEnv = process.env.AI_SERVANT_ROOT;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "servant-cfg-test-"));
  process.env.AI_SERVANT_ROOT = tmpRoot;
});

afterAll(async () => {
  if (originalEnv === undefined) Reflect.deleteProperty(process.env, "AI_SERVANT_ROOT");
  else process.env.AI_SERVANT_ROOT = originalEnv;
  await rm(tmpRoot, { recursive: true, force: true });
});

const { defaultConfig, expandHome, loadConfig, saveConfig, resolvedSearchRoots } = await import(
  "../src/core/config.ts"
);

describe("defaultConfig", () => {
  test("returns expected defaults", () => {
    const cfg = defaultConfig();
    expect(cfg.repoSearchRoots).toEqual(["~/private", "~/code"]);
    expect(cfg.scanMaxDepth).toBe(4);
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
    const cfg = { repoSearchRoots: ["~/code", "/abs/repos"], scanMaxDepth: 6 };
    await saveConfig(cfg);
    const loaded = await loadConfig();
    expect(loaded).toEqual(cfg);
  });

  test("resolvedSearchRoots expands ~ in loaded values", async () => {
    await saveConfig({ repoSearchRoots: ["~/code", "/abs/repos"], scanMaxDepth: 4 });
    const loaded = await loadConfig();
    const resolved = resolvedSearchRoots(loaded);
    expect(resolved).toEqual([join(homedir(), "code"), "/abs/repos"]);
  });
});
