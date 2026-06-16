import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { $ } from "bun";
import { defineCommand } from "citty";
import { queueDepth, readDrainStatus } from "../core/extract-queue.ts";
import {
  type StoredNote,
  listAllNotes,
  listProjectRepos,
  projectOfScope,
  readTopicNotes,
} from "../core/knowledge.ts";
import { applyRootOverride, knowledgeRoot } from "../core/paths.ts";
import { pickFromList } from "../ui/picker.ts";

const DEFAULT_RECENT = 5;

// A note row decomposed into the columns the browser shows: type | scope | name | description.
// For a project note, scope is the repo; for a topic, its tags (topics have no repo scope).
interface BrowseRow extends StoredNote {
  type: string;
  scope: string;
  raw: string;
  label: string;
}

const truncate = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s;

/** Build aligned `type  scope  name  description` rows plus a matching header line. */
async function buildBrowseRows(
  notes: StoredNote[],
): Promise<{ rows: BrowseRow[]; header: string }> {
  const base = await Promise.all(
    notes.map(async (n) => {
      const repo = projectOfScope(n.note.scope);
      let raw: string;
      try {
        raw = await readFile(n.path, "utf8");
      } catch {
        raw = "(could not read note file)";
      }
      return {
        ...n,
        type: repo ? "project" : "topic",
        scope: truncate(repo ?? (n.note.tags.join(", ") || "—"), 22),
        name: truncate(n.note.name, 32),
        raw,
      };
    }),
  );
  const wType = Math.max(4, ...base.map((r) => r.type.length));
  const wScope = Math.max(5, ...base.map((r) => r.scope.length));
  const pad = (s: string, w: number) => s.padEnd(w);
  // Visible columns stop at NAME (the description is noise in a list); fzf still matches the
  // full note content via searchText (see the pickFromList call), so notes remain findable.
  const rows = base.map((r) => ({
    ...r,
    label: `${pad(r.type, wType)}  ${pad(r.scope, wScope)}  ${r.name}`,
  }));
  const header = `${pad("TYPE", wType)}  ${pad("SCOPE", wScope)}  NAME`;
  return { rows, header };
}

async function recentCaptures(limit: number): Promise<string[]> {
  const root = knowledgeRoot();
  if (!existsSync(`${root}/.git`)) return [];
  const proc = await $`git -C ${root} log --pretty=format:%cr%x09%s -n ${limit}`.nothrow().quiet();
  if (proc.exitCode !== 0) return [];
  return proc.stdout
    .toString()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function formatAge(ts: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

async function printDigest(
  noteCount: number,
  repoCount: number,
  topicCount: number,
): Promise<void> {
  console.log("servant knowledge base");
  console.log(
    `  notes:    ${noteCount - topicCount} project (${repoCount} repos) · ${topicCount} topic`,
  );
  console.log(`  queue:    ${await queueDepth()} pending extraction job(s)`);

  const status = await readDrainStatus();
  if (status) {
    const err = status.error ? ` · error: ${status.error}` : "";
    console.log(`  last run: ${formatAge(status.ts)} · processed ${status.processed} job(s)${err}`);
    for (const summary of status.summaries ?? []) console.log(`            ↳ ${summary}`);
  } else {
    console.log("  last run: never");
  }

  const captures = await recentCaptures(DEFAULT_RECENT);
  if (captures.length > 0) {
    console.log("\nrecent captures:");
    for (const line of captures) {
      const [age, subject] = line.split("\t");
      console.log(`  ${subject}  (${age})`);
    }
  }
}

export const memoriesCommand = defineCommand({
  meta: {
    name: "memories",
    description:
      "Browse the servant knowledge base in an fzf picker (type to filter, preview the note); prints a status digest first. Use --digest for non-interactive output.",
  },
  args: {
    digest: {
      type: "boolean",
      required: false,
      default: false,
      description: "Print the status digest only; don't open the interactive browser.",
    },
    root: {
      type: "string",
      required: false,
      description: "Servant root directory (default: ~/.ai_servant). For throwaway/test setups.",
    },
  },
  async run({ args }) {
    applyRootOverride(args.root);

    if (!existsSync(knowledgeRoot())) {
      console.log("servant: no knowledge base yet — it appears on first capture or spawn.");
      return;
    }

    const notes = await listAllNotes();
    const repoCount = (await listProjectRepos()).length;
    const topicCount = (await readTopicNotes()).length;
    await printDigest(notes.length, repoCount, topicCount);

    if (notes.length === 0) {
      console.log(
        "\nNo notes captured yet — they're written when a servant session ends (auto), or via",
      );
      console.log("/servant:extract-memories in-session. Then browse them here.");
      return;
    }

    // Browse unless asked for digest-only or running non-interactively (piped / CI).
    const interactive = Boolean(process.stdin.isTTY) && !args.digest;
    if (!interactive) return;

    const { rows, header } = await buildBrowseRows(notes);
    const picked = await pickFromList(rows, {
      format: (r) => r.label,
      preview: (r) => r.raw, // the note file as-is (frontmatter + body)
      prompt: "memory",
      header,
    });
    if (picked) console.log(`\n# ${picked.path}\n\n${picked.raw}`);
  },
});
