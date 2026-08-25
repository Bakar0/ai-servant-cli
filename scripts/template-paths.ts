/**
 * The mapping between a template's *on-disk* name and the path it means.
 *
 * Templates are data, but two of servant's are shaped exactly like the instruction docs they
 * install as — a `CLAUDE.md` and a tree of `.claude/skills/<name>/SKILL.md` files. Left under
 * their real names, agents working in this repo discover them and load a template as guidance
 * (servant-skill-rework#16). So the tree stores *escaped* names and the embedded manifest
 * reassembles the real ones, which is why every consumer still reads the path it always did.
 *
 * Two rules, both reversible and both general — a future template that would collide gets escaped
 * the same way, with no table to update:
 *
 *   `_name`          → `.name`      a leading underscore on any segment means a dot
 *   `name.tmpl.ext`  → `name.ext`   a `tmpl` component in the basename is dropped
 *
 * The escape goes *before* the extension, not after it, because the manifest imports each template
 * with `with { type: "text" }` and `tsc` types that import from the extension — an unknown one has
 * no declared module and fails typecheck.
 */
import { readdir } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";

const DOT_ESCAPE = "_";
const NAME_ESCAPE = "tmpl";
const GENERATED_MANIFEST = "index.generated.ts";

function unescapeBasename(basename: string): string {
  const parts = basename.split(".");
  // Position 0 is the name itself, never the escape: a template legitimately called `tmpl.md`
  // keeps its name, and only a *later* `tmpl` component is the marker.
  const at = parts.lastIndexOf(NAME_ESCAPE);
  if (at <= 0) return basename;
  parts.splice(at, 1);
  return parts.join(".");
}

/** The real path a template means, given its on-disk path (both relative to `src/templates/`). */
export function templateRelFromDisk(diskRel: string): string {
  const segments = diskRel
    .split("/")
    .map((seg) => (seg.startsWith(DOT_ESCAPE) ? `.${seg.slice(DOT_ESCAPE.length)}` : seg));
  const last = segments.length - 1;
  const basename = segments[last];
  if (basename !== undefined) segments[last] = unescapeBasename(basename);
  return segments.join("/");
}

/**
 * Every template's on-disk path, relative to `src/templates/` and POSIX-separated, sorted — the
 * generated manifest excluded, since it is the output rather than a template.
 *
 * Shared with the tests that guard the tree so all three walkers agree on what "every template"
 * means: a walk that skipped a file would make a drift check pass by not looking.
 */
export async function templateDiskRels(templatesDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  await walk(templatesDir);
  return out
    .map((abs) => relative(templatesDir, abs).split(sep).join(posix.sep))
    .filter((rel) => rel !== GENERATED_MANIFEST)
    .sort();
}
