import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { templateDiskRels, templateRelFromDisk } from "../scripts/template-paths.ts";
import { TEMPLATES } from "../src/templates/index.generated.ts";

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(here, "..", "src", "templates");

describe("embedded template manifest", () => {
  test("covers every file under src/templates/ (no drift)", async () => {
    const onDisk = (await templateDiskRels(templatesDir)).map(templateRelFromDisk).sort();
    const inManifest = TEMPLATES.map((t) => t.rel).sort();
    expect(inManifest).toEqual(onDisk);
  });

  // Escaping is only invisible while it stays injective: two disk names that unescape to the same
  // path would make one of them silently unreachable, and which one wins would be sort order.
  test("no two on-disk names mean the same path", async () => {
    const rels = (await templateDiskRels(templatesDir)).map(templateRelFromDisk);
    expect(rels.length).toBe(new Set(rels).size);
  });

  test("an escaped on-disk name unescapes to the path it means", () => {
    expect(templateRelFromDisk("servant_root/CLAUDE.tmpl.md")).toBe("servant_root/CLAUDE.md");
    expect(templateRelFromDisk("servant_root/_claude/skills/servant-recall/SKILL.md")).toBe(
      "servant_root/.claude/skills/servant-recall/SKILL.md",
    );
    expect(templateRelFromDisk("claude/statusline.sh")).toBe("claude/statusline.sh");
  });

  test("every embedded template has non-empty content", () => {
    for (const t of TEMPLATES) {
      expect(t.content.length).toBeGreaterThan(0);
    }
  });
});
