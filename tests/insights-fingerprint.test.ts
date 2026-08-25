import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FINE_TUNE_ASPECTS, writeOverlay } from "../src/core/fine-tune.ts";
import {
  type FingerprintParts,
  composeSetupParts,
  extractEmbeddedClaudeMd,
  fingerprintFromParts,
} from "../src/core/insights/fingerprint.ts";
import { setRootOverride } from "../src/core/paths.ts";
import { TEMPLATES } from "../src/templates/index.generated.ts";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "servant-insights-fp-"));
  setRootOverride(tmpRoot);
});

afterEach(async () => {
  setRootOverride(null);
  await rm(tmpRoot, { recursive: true, force: true });
});

const parts = (over: Partial<FingerprintParts> = {}): FingerprintParts => ({
  version: "2.1.0",
  claudeMd: "# Servant Workspace\nrules here",
  coreSkills: "core skill body",
  knowledgeSection: "api-gw:3\ntags:auth(2)",
  ...over,
});

describe("fingerprintFromParts", () => {
  test("is a stable 12-char hex hash for identical parts", () => {
    const a = fingerprintFromParts(parts());
    const b = fingerprintFromParts(parts());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  test("changes when any setup part changes", () => {
    const base = fingerprintFromParts(parts());
    expect(fingerprintFromParts(parts({ version: "2.2.0" }))).not.toBe(base);
    expect(fingerprintFromParts(parts({ claudeMd: "# different" }))).not.toBe(base);
    expect(fingerprintFromParts(parts({ coreSkills: "changed" }))).not.toBe(base);
    expect(fingerprintFromParts(parts({ knowledgeSection: "api-gw:4\ntags:auth(2)" }))).not.toBe(
      base,
    );
  });

  test("ignores leading/trailing whitespace differences in parts", () => {
    const a = fingerprintFromParts(parts({ claudeMd: "# x\nbody" }));
    const b = fingerprintFromParts(parts({ claudeMd: "  # x\nbody  \n" }));
    expect(a).toBe(b);
  });
});

describe("composeSetupParts + overlay", () => {
  test("a written fine-tune overlay changes the composed fingerprint", async () => {
    const before = await composeSetupParts();
    const fpBefore = fingerprintFromParts({ version: "2.1.0", ...before });

    const general = FINE_TUNE_ASPECTS.find((a) => a.id === "general");
    if (!general) throw new Error("expected a 'general' aspect");
    await writeOverlay(general, "Always prefer tabs over spaces.");

    const after = await composeSetupParts();
    const fpAfter = fingerprintFromParts({ version: "2.1.0", ...after });

    expect(after.claudeMd).not.toBe(before.claudeMd);
    expect(fpAfter).not.toBe(fpBefore);
  });
});

describe("composeSetupParts — the core skills are the setup", () => {
  const CORE_SKILL_TEMPLATES = TEMPLATES.filter((t) =>
    t.rel.startsWith("servant_root/.claude/skills/"),
  );

  test("carries every core skill servant ships, derived from the manifest", async () => {
    const { coreSkills } = await composeSetupParts();

    expect(CORE_SKILL_TEMPLATES.length).toBeGreaterThan(0);
    for (const t of CORE_SKILL_TEMPLATES) {
      expect(coreSkills).toContain(t.content.trim());
    }
  });

  test("names exactly the manifest's core skills — no more, no fewer", async () => {
    // The guard the old hardcoded list failed. Coverage alone would not catch a stray extra asset,
    // so this pins the set: whatever the manifest ships is what the fingerprint hashes, and a skill
    // added or retired tomorrow needs no list updated anywhere.
    const { coreSkills } = await composeSetupParts();

    const hashed = coreSkills.split("\n").filter((l) => l.startsWith(".claude/skills/"));
    const shipped = CORE_SKILL_TEMPLATES.map((t) => t.rel.replace("servant_root/", ""));
    expect(hashed.toSorted()).toEqual(shipped.toSorted());
  });

  test("renaming a skill moves the fingerprint even when its bytes do not", async () => {
    // Paths are hashed alongside bodies, so moving identical instructions between two skills is a
    // setup change rather than a silent no-op.
    const base = { version: "2.1.0", claudeMd: "", knowledgeSection: "" };
    const a = fingerprintFromParts({ ...base, coreSkills: ".claude/skills/x/SKILL.md\nbody" });
    const b = fingerprintFromParts({ ...base, coreSkills: ".claude/skills/y/SKILL.md\nbody" });
    expect(a).not.toBe(b);
  });

  test("editing a core skill through its overlay moves the fingerprint", async () => {
    // The whole point of servant-skill-rework#13: tuning a core skill must register as a setup
    // change, or the digest's before/after cannot see skill tuning at all.
    const before = await composeSetupParts();
    const fpBefore = fingerprintFromParts({ version: "2.1.0", ...before });

    const recall = FINE_TUNE_ASPECTS.find((a) => a.id === "recall");
    if (!recall) throw new Error("expected a 'recall' aspect");
    expect(recall.assets).toContain(".claude/skills/servant-recall/SKILL.md");
    await writeOverlay(recall, "Always search topics before projects.");

    const after = await composeSetupParts();
    expect(after.claudeMd).toBe(before.claudeMd);
    expect(after.coreSkills).not.toBe(before.coreSkills);
    expect(fingerprintFromParts({ version: "2.1.0", ...after })).not.toBe(fpBefore);
  });
});

describe("extractEmbeddedClaudeMd", () => {
  test("pulls a # claudeMd block out of a system-reminder text record", () => {
    const records = [
      { message: { role: "user", content: "hello" } },
      {
        message: {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>\n# claudeMd\n# Servant Workspace\nrules" },
          ],
        },
      },
    ];
    const embedded = extractEmbeddedClaudeMd(records);
    expect(embedded).toContain("# Servant Workspace");
  });

  test("returns null when no CLAUDE.md is embedded", () => {
    expect(extractEmbeddedClaudeMd([{ message: { role: "user", content: "nope" } }])).toBeNull();
  });
});
