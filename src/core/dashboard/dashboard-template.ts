// The shipped, self-contained workspace-dashboard HTML asset. Bun's ambient types map `*.html` to
// `HTMLBundle`, but the `with { type: "text" }` attribute makes Bun load it as a plain string at
// runtime — identically under `bun run` and `bun build --compile`, so the asset bakes into the
// standalone binary with no `import.meta.url` filesystem read. The cast reflects that reality.
import dashboardHtml from "./dashboard.html" with { type: "text" };

/** The template, with its single `__DASHBOARD_DATA__` JSON slot the renderer fills. */
export const WORKSPACE_DASHBOARD_TEMPLATE = dashboardHtml as unknown as string;
