import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import { summonCommand } from "../src/commands/summon.ts";
import { setRootOverride } from "../src/core/paths.ts";

let scratch: string;
let seededRoot: string;
let bareRoot: string;
const WS = "summoncmd";
const realKey = process.env.OPENAI_API_KEY;

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "servant-summon-cmd-")));
  seededRoot = join(scratch, "seeded");
  bareRoot = join(scratch, "bare");
  await mkdir(bareRoot, { recursive: true });
  await mkdir(join(seededRoot, "workspaces", WS), { recursive: true });

  setRootOverride(seededRoot);
  const { saveConfig } = await import("../src/core/config.ts");
  await saveConfig({
    version: 1,
    repoSearchRoots: [scratch],
    scanMaxDepth: 4,
    showTips: true,
    hubRepo: "acme/hub",
  });
  setRootOverride(null);
  delete process.env.OPENAI_API_KEY;
});

afterAll(async () => {
  setRootOverride(null);
  if (realKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = realKey;
  await rm(scratch, { recursive: true, force: true });
});

describe("servant summon", () => {
  test("--root is applied before anything reads servant state", async () => {
    // The bare root has no config.json, so the init gate must fire against *it*, not the real root.
    await expect(
      runCommand(summonCommand, { rawArgs: ["--root", bareRoot, "-w", WS] }),
    ).rejects.toThrow(/not initialized/);
  });

  test("refuses to start without an API key, naming the variable", async () => {
    await expect(
      runCommand(summonCommand, { rawArgs: ["--root", seededRoot, "-w", WS] }),
    ).rejects.toThrow(/OPENAI_API_KEY/);
  });

  test("rejects a non-numeric idle timeout before touching the mic or the network", async () => {
    await expect(
      runCommand(summonCommand, {
        rawArgs: ["--root", seededRoot, "-w", WS, "--idle-timeout", "soon"],
      }),
    ).rejects.toThrow(/--idle-timeout/);
  });
});
