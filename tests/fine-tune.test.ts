import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRootOverride } from "../src/core/paths.ts";

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "servant-fine-tune-"));
  setRootOverride(tmpRoot);
});

afterAll(async () => {
  setRootOverride(null);
  await rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(join(tmpRoot, ".claude"), { recursive: true, force: true });
  await rm(join(tmpRoot, "CLAUDE.md"), { force: true });
  await rm(join(tmpRoot, "fine-tune"), { recursive: true, force: true });
});

const { ensureServantAssets } = await import("../src/core/claude-setup.ts");
const { aiServantRoot, claudeCommandsDir, fineTuneAspectPath } = await import(
  "../src/core/paths.ts"
);
const { composeAsset, getAspect, readOverlayBody, resetOverlay, writeOverlay, isCustomized } =
  await import("../src/core/fine-tune.ts");
const { buildExtractionPrompt } = await import("../src/core/extract-prompt.ts");

function aspect(id: string) {
  const a = getAspect(id);
  if (!a) throw new Error(`missing aspect ${id}`);
  return a;
}

const delegatePath = () => join(claudeCommandsDir(), "servant", "delegate.md");

describe("composeAsset", () => {
  test("returns the base unchanged when there is no overlay", () => {
    expect(composeAsset("delegate", "BASE", null)).toBe("BASE");
  });

  test("appends the overlay after the base, fenced by markers", () => {
    const out = composeAsset("delegate", "BASE", "do it my way");
    expect(out.startsWith("BASE")).toBe(true);
    expect(out).toContain("<!-- servant:fine-tune:start id=delegate -->");
    expect(out).toContain("do it my way");
    expect(out).toContain("<!-- servant:fine-tune:end -->");
    // base must come before the overlay section
    expect(out.indexOf("BASE")).toBeLessThan(out.indexOf("do it my way"));
  });
});

describe("overlay read/write", () => {
  test("writeOverlay strips comments on read and reports customized", async () => {
    await writeOverlay(aspect("delegate"), "always use the RFC template");
    expect(await isCustomized("delegate")).toBe(true);
    expect(await readOverlayBody("delegate")).toBe("always use the RFC template");
    // the raw file carries the guidance scaffold comment
    const raw = await readFile(fineTuneAspectPath("delegate"), "utf8");
    expect(raw).toContain("servant fine-tune — `delegate`");
  });

  test("a scaffold-only overlay (no real content) is not customized", async () => {
    await writeOverlay(aspect("delegate"), "   ");
    expect(await isCustomized("delegate")).toBe(false);
    expect(await readOverlayBody("delegate")).toBeNull();
  });
});

describe("ensureServantAssets composition", () => {
  test("missing overlay → delivered asset equals pure base", async () => {
    await ensureServantAssets();
    const delivered = await readFile(delegatePath(), "utf8");
    expect(delivered).not.toContain("servant:fine-tune:start");
    expect(delivered).toContain("Agent Brief");
  });

  test("overlay is appended into the delivered slash command", async () => {
    await writeOverlay(aspect("delegate"), "always use the RFC template");
    await ensureServantAssets();
    const delivered = await readFile(delegatePath(), "utf8");
    expect(delivered).toContain("Agent Brief"); // base preserved
    expect(delivered).toContain("always use the RFC template"); // overlay applied
    expect(delivered).toContain("## Local fine-tuning");
  });

  test("overlay content survives a re-sync (simulated CLI update)", async () => {
    await writeOverlay(aspect("delegate"), "always use the RFC template");
    await ensureServantAssets();
    const first = await readFile(delegatePath(), "utf8");
    // Re-running sync (as an update would) must not drop the overlay and must be idempotent.
    await ensureServantAssets();
    const second = await readFile(delegatePath(), "utf8");
    expect(second).toBe(first);
    expect(second).toContain("always use the RFC template");
  });

  test("reset reverts the delivered asset to pure base", async () => {
    await writeOverlay(aspect("delegate"), "always use the RFC template");
    await ensureServantAssets();
    await resetOverlay("delegate");
    await ensureServantAssets();
    const delivered = await readFile(delegatePath(), "utf8");
    expect(delivered).not.toContain("always use the RFC template");
    expect(delivered).not.toContain("servant:fine-tune:start");
  });

  test("general overlay lands in the root CLAUDE.md", async () => {
    await writeOverlay(aspect("general"), "house rule: prefer Bun");
    await ensureServantAssets();
    const claudeMd = await readFile(join(aiServantRoot(), "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("Servant Workspace"); // base
    expect(claudeMd).toContain("house rule: prefer Bun"); // overlay
  });
});

describe("memory-extraction overlay reaches both surfaces", () => {
  test("the headless extraction prompt appends the overlay", () => {
    const prompt = buildExtractionPrompt({
      transcriptPath: "/x.jsonl",
      fromTurn: 0,
      cwd: "/ws",
      fineTuneOverlay: "always capture deploy runbooks",
    });
    expect(prompt).toContain("Local fine-tuning (user overrides");
    expect(prompt).toContain("always capture deploy runbooks");
  });

  test("the extract-memories slash command also gets the overlay", async () => {
    await writeOverlay(aspect("memory-extraction"), "always capture deploy runbooks");
    await ensureServantAssets();
    const cmd = await readFile(join(claudeCommandsDir(), "servant", "extract-memories.md"), "utf8");
    expect(cmd).toContain("--reconcile"); // base
    expect(cmd).toContain("always capture deploy runbooks"); // overlay
  });
});
