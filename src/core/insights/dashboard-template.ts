// The shipped, self-contained dashboard HTML asset (the `--deep` template). Bun's ambient types map
// `*.html` to `HTMLBundle`, but the `with { type: "text" }` attribute makes Bun load it as a plain
// string at runtime — identically under `bun run` and `bun build --compile`, so the asset is embedded
// in the standalone binary with no `import.meta.url` filesystem read. The cast reflects that reality.
import dashboardHtml from "./dashboard.html" with { type: "text" };

/** The dashboard template, with its single `__DASHBOARD_DATA__` JSON slot the renderer fills. */
export const DASHBOARD_TEMPLATE = dashboardHtml as unknown as string;
