import { fillDataSlot } from "../html-artifact.ts";
import { WORKSPACE_DASHBOARD_TEMPLATE } from "./dashboard-template.ts";
import type { WorkspaceDashboardData } from "./data.ts";

// The deterministic renderer: it fills the template's single data slot and adds NO per-run markup.
// The template owns all styling/layout; this module only injects the JSON payload, offline.

/** The exact sentinel the template carries in its `<script type="application/json">` data slot. */
const DATA_SLOT = "__DASHBOARD_DATA__";

/**
 * Render the full, self-contained dashboard HTML by injecting the payload into the template's single
 * data slot. Deterministic and offline: the returned string references no network resource. Throws
 * if the template asset somehow lacks the slot (a build/asset error, not user input).
 */
export function renderWorkspaceDashboard(data: WorkspaceDashboardData): string {
  return fillDataSlot(WORKSPACE_DASHBOARD_TEMPLATE, DATA_SLOT, data);
}
