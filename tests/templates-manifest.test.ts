import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TEMPLATES } from "../src/templates/index.generated.ts";

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(here, "..", "src", "templates");
const GENERATED = "index.generated.ts";

async function listTemplateFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  await walk(root);
  return out;
}

function toPosix(rel: string): string {
  return sep === "/" ? rel : rel.split(sep).join(posix.sep);
}

describe("embedded template manifest", () => {
  test("covers every file under src/templates/ (no drift)", async () => {
    const onDisk = (await listTemplateFiles(templatesDir))
      .map((abs) => toPosix(relative(templatesDir, abs)))
      .filter((rel) => rel !== GENERATED)
      .sort();
    const inManifest = TEMPLATES.map((t) => t.rel).sort();
    expect(inManifest).toEqual(onDisk);
  });

  test("every embedded template has non-empty content", () => {
    for (const t of TEMPLATES) {
      expect(t.content.length).toBeGreaterThan(0);
    }
  });
});
