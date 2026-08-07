import { describe, expect, test } from "bun:test";
import type { WorkspaceDashboardData } from "../src/core/dashboard/data.ts";
import { renderWorkspaceDashboard } from "../src/core/dashboard/render.ts";

const SAMPLE: WorkspaceDashboardData = {
  workspace: "ai_servant",
  generatedAt: Date.parse("2026-06-26T23:53:00Z"),
  version: "v1.2.3",
  mission: "Build and improve the servant CLI tooling.",
  whereWeAre: {
    plans: [
      {
        title: "workspace dashboard",
        phases: [
          { id: "P0", state: "done" },
          { id: "P1", state: "active" },
          { id: "P2", state: "remaining" },
        ],
        doneCount: 1,
        totalCount: 3,
      },
    ],
    current: { planTitle: "workspace dashboard", phaseId: "P1" },
  },
  architecture: {
    nodes: [
      {
        id: "dashboard-data",
        label: "payload builder",
        purpose: "assembles the payload",
        tech: ["TypeScript"],
        path: "src/core/dashboard/data.ts",
        decision: "one builder",
        state: "built",
        dependsOn: [],
      },
    ],
    edges: [],
  },
};

/** Pull the JSON the renderer injected into the dashboard's data slot. */
function extractSlot(html: string): unknown {
  const m = html.match(/<script id="dashboard-data" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m || m[1] === undefined) throw new Error("data slot not found");
  return JSON.parse(m[1]);
}

describe("renderWorkspaceDashboard", () => {
  test("renders the masthead and the two surviving sections", () => {
    const html = renderWorkspaceDashboard(SAMPLE);
    expect(html).toContain("workspace dashboard");
    expect(html).toContain("Delivery roadmap");
    expect(html).toContain("Architecture");
    // The cut sections are gone from the template entirely.
    expect(html).not.toContain("Cost & Effort");
    expect(html).not.toContain("Session feed");
    expect(html).not.toContain("Dead-end ledger");
  });

  test("is fully self-contained / offline — no CDN or network resources", () => {
    const html = renderWorkspaceDashboard(SAMPLE);
    // No external resource tags at all.
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script[^>]+\bsrc=/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toContain("@import");
    // No runtime network APIs.
    expect(html).not.toContain("fetch(");
    expect(html).not.toContain("XMLHttpRequest");
    expect(html).not.toContain("WebSocket");
    // None of the design bundle's runtime/CDN machinery leaked in during the port.
    expect(html).not.toContain("cdn.jsdelivr.net");
    expect(html).not.toContain("lucide");
    expect(html).not.toContain("_ds_bundle");
    expect(html).not.toContain("<x-dc");
    expect(html).not.toContain("sc-for");
    expect(html).not.toContain("mask-image");
    // The only permitted absolute URI is the SVG/XML namespace (a URI, never fetched).
    const stripped = html.replaceAll("http://www.w3.org/2000/svg", "");
    expect(stripped).not.toContain("http://");
    expect(stripped).not.toContain("https://");
  });

  test("round-trips the payload through the single data slot", () => {
    const html = renderWorkspaceDashboard(SAMPLE);
    const slot = extractSlot(html) as WorkspaceDashboardData;
    expect(slot).toEqual(SAMPLE);
  });

  test("escapes a literal </script> in the data so the slot can't be broken out of", () => {
    const evil: WorkspaceDashboardData = {
      ...SAMPLE,
      workspace: "evil</script><script>alert(1)</script>",
    };
    const html = renderWorkspaceDashboard(evil);
    // The raw closing tag must be neutralized inside the JSON slot...
    expect(html).toContain("<\\/script>");
    // ...and the parsed payload still round-trips the original string intact.
    const slot = extractSlot(html) as WorkspaceDashboardData;
    expect(slot.workspace).toBe("evil</script><script>alert(1)</script>");
  });
});
