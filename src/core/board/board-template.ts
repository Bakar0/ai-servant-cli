// The shipped board page. Bun's ambient types map `*.html` to `HTMLBundle`, but `with { type:
// "text" }` loads it as a plain string — identically under `bun run` and `bun build --compile`, so
// the asset bakes into the standalone binary with no `import.meta.url` filesystem read. The cast
// reflects that reality. Same arrangement as the Call log's template.
import boardHtml from "./board.html" with { type: "text" };

/** The template, with its single `__BOARD_DATA__` JSON slot the request handler fills. */
export const BOARD_TEMPLATE = boardHtml as unknown as string;
