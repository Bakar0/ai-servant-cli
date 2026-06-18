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
  commands: "/servant:recall body",
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
    expect(fingerprintFromParts(parts({ commands: "changed" }))).not.toBe(base);
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
