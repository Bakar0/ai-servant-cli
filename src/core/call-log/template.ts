// The shipped, self-contained Call log HTML asset. Bun's ambient types map `*.html` to `HTMLBundle`,
// but the `with { type: "text" }` attribute makes Bun load it as a plain string at runtime —
// identically under `bun run` and `bun build --compile`, so the asset bakes into the standalone
// binary with no `import.meta.url` filesystem read. The cast reflects that reality.
import callLogHtml from "./call-log.html" with { type: "text" };

/** The template, with its single `__CALL_LOG_DATA__` JSON slot the renderer fills. */
export const CALL_LOG_TEMPLATE = callLogHtml as unknown as string;
