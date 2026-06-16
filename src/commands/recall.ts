import { defineCommand } from "citty";
import { renderNote, searchNotes } from "../core/knowledge.ts";
import { applyRootOverride } from "../core/paths.ts";

const DEFAULT_LIMIT = 8;

export const recallCommand = defineCommand({
  meta: {
    name: "recall",
    description:
      "Search the servant knowledge base (projects + topics) by tag and content; prints matching note bodies inline, ranked.",
  },
  args: {
    query: {
      type: "positional",
      required: true,
      description: "Search terms (tags and content). Space-separated.",
    },
    limit: {
      type: "string",
      required: false,
      alias: "n",
      description: `Max notes to print (default: ${DEFAULT_LIMIT}).`,
    },
    root: {
      type: "string",
      required: false,
      description: "Servant root directory (default: ~/.ai_servant). For throwaway/test setups.",
    },
  },
  async run({ args }) {
    applyRootOverride(args.root);
    // Prefer `_` (citty collects every positional there, so unquoted multi-word queries
    // like `servant recall sqlite wal` work); fall back to the named positional.
    const positionals =
      Array.isArray(args._) && args._.length > 0 ? args._.map(String) : [String(args.query ?? "")];
    const query = positionals.join(" ").trim();
    if (!query) throw new Error("Pass a search query, e.g. `servant recall sqlite wal`.");
    const limit = Number.parseInt(args.limit ?? "", 10) || DEFAULT_LIMIT;

    const hits = await searchNotes(query);
    if (hits.length === 0) {
      console.log(`servant: no knowledge notes match "${query}".`);
      return;
    }

    const shown = hits.slice(0, limit);
    console.log(
      `servant: ${hits.length} match(es) for "${query}"${
        hits.length > shown.length ? ` (showing ${shown.length})` : ""
      }\n`,
    );
    console.log(shown.map((h) => renderNote(h.note, h.path)).join("\n\n---\n\n"));
  },
});
