import { WORKSPACE_DASHBOARD_TEMPLATE } from "./dashboard-template.ts";
import type { WorkspaceDashboardData } from "./data.ts";

// The deterministic renderer: it fills the template's single data slot and adds NO per-run markup.
// The template owns all styling/layout; this module only injects the JSON payload, offline.

/** The exact sentinel the template carries in its `<script type="application/json">` data slot. */
const DATA_SLOT = "__DASHBOARD_DATA__";

/**
 * Serialize the payload for safe embedding inside an HTML `<script>` block: `</` is broken so a
 * `</script>` inside any string can't close the tag early (`<\/script>` is still valid JSON).
 */
function encodeForScript(data: WorkspaceDashboardData): string {
  return JSON.stringify(data).replace(/<\//g, "<\\/");
}

/**
 * Render the full, self-contained dashboard HTML by injecting the payload into the template's single
 * data slot. Deterministic and offline: the returned string references no network resource. Throws
 * if the template asset somehow lacks the slot (a build/asset error, not user input).
 */
export function renderWorkspaceDashboard(data: WorkspaceDashboardData): string {
  if (!WORKSPACE_DASHBOARD_TEMPLATE.includes(DATA_SLOT)) {
    throw new Error(`workspace dashboard template is missing the ${DATA_SLOT} data slot`);
  }
  return WORKSPACE_DASHBOARD_TEMPLATE.replace(DATA_SLOT, encodeForScript(data));
}
