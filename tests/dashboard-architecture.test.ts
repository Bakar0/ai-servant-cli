import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  type Architecture,
  emptyArchitecture,
  parseArchitecture,
  parseArchitectureText,
} from "../src/core/dashboard/architecture.ts";
import { buildWorkspaceDashboardData } from "../src/core/dashboard/data.ts";
import { setRootOverride, workspaceArchitecturePath, workspacePath } from "../src/core/paths.ts";

describe("parseArchitectureText", () => {
  const yaml = [
    "components:",
    "  - id: a",
    "    label: Component A",
    "    purpose: does a thing",
    "    tech: [TypeScript, Bun]",
    "    path: src/a.ts",
    "    decision: chose a because reasons",
    "    state: built",
    "    phase: P0",
    "    dependsOn: [b]",
    "  - id: b",
    "    label: Component B",
    "    purpose: does b",
    "    tech: [YAML]",
    "    path: src/b.ts",
    "    decision: ADR-001",
    "    state: in-progress",
    "    dependsOn: [missing-target]",
  ].join("\n");

  test("parses components into typed nodes", () => {
    const arch = parseArchitectureText(yaml);
    expect(arch.nodes).toHaveLength(2);
    expect(arch.nodes[0]).toEqual({
      id: "a",
      label: "Component A",
      purpose: "does a thing",
      tech: ["TypeScript", "Bun"],
      path: "src/a.ts",
      decision: "chose a because reasons",
      state: "built",
      phase: "P0",
      dependsOn: ["b"],
    });
  });

  test("derives edges from dependsOn, only between known nodes", () => {
    const arch = parseArchitectureText(yaml);
    // a→b is kept; b→missing-target is dropped (no dangling edges in the diagram).
    expect(arch.edges).toEqual([{ from: "a", to: "b" }]);
  });

  test("defaults state to todo, label to id, and omits an absent phase", () => {
    const arch = parseArchitectureText("components:\n  - id: lonely\n    state: bogus");
    expect(arch.nodes[0]).toMatchObject({ id: "lonely", label: "lonely", state: "todo" });
    expect(arch.nodes[0]).not.toHaveProperty("phase");
    expect(arch.nodes[0]?.tech).toEqual([]);
  });

  test("skips entries without a stable id", () => {
    const arch = parseArchitectureText("components:\n  - label: no id here\n  - id: real");
    expect(arch.nodes.map((n) => n.id)).toEqual(["real"]);
  });

  test("throws on broken YAML", () => {
    expect(() => parseArchitectureText("components: [unclosed")).toThrow();
  });

  test("throws on a valid-YAML wrong shape (no components list)", () => {
    expect(() => parseArchitectureText("just: a scalar map")).toThrow(/components/);
  });
});

describe("parseArchitecture (file reader)", () => {
  let scratch: string;
  const WORKSPACE = "arch-ws";

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "servant-arch-"));
    setRootOverride(join(scratch, ".ai_servant"));
    await mkdir(join(workspacePath(WORKSPACE), "context"), { recursive: true });
  });

  afterEach(async () => {
    setRootOverride(null);
    await rm(scratch, { recursive: true, force: true });
  });

  test("missing source file → empty architecture, no crash, no warning", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(parseArchitecture(WORKSPACE)).toEqual(emptyArchitecture());
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test("malformed source file → empty architecture + a non-fatal warning", async () => {
    await writeFile(workspaceArchitecturePath(WORKSPACE), "components: [unterminated\n  - nope");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(parseArchitecture(WORKSPACE)).toEqual(emptyArchitecture());
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test("well-formed source file → parsed nodes + edges", async () => {
    await writeFile(
      workspaceArchitecturePath(WORKSPACE),
      "components:\n  - id: x\n    dependsOn: [y]\n  - id: y\n",
    );
    const arch = parseArchitecture(WORKSPACE);
    expect(arch.nodes.map((n) => n.id)).toEqual(["x", "y"]);
    expect(arch.edges).toEqual([{ from: "x", to: "y" }]);
  });
});

// ── Live workspace: the seeded real architecture source ──────────────────────────────────────────
const LIVE = "ai_servant";
const HAS_LIVE = existsSync(workspaceArchitecturePath(LIVE));

describe.skipIf(!HAS_LIVE)("against the seeded ai_servant architecture source", () => {
  test("parses ≥5 real components with paths/tech/state, plus dependency edges", () => {
    const arch: Architecture = parseArchitecture(LIVE);
    expect(arch.nodes.length).toBeGreaterThanOrEqual(5);
    for (const node of arch.nodes) {
      expect(node.path.length).toBeGreaterThan(0);
      expect(node.tech.length).toBeGreaterThan(0);
      expect(["built", "in-progress", "todo"]).toContain(node.state);
    }
    expect(arch.edges.length).toBeGreaterThan(0);
    // Every edge endpoint is a real node (no dangling edges).
    const ids = new Set(arch.nodes.map((n) => n.id));
    for (const e of arch.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
    // The reader is one of the seeded components.
    expect(arch.nodes.some((n) => n.id === "architecture-reader")).toBe(true);
  });

  test("the dashboard payload surfaces the populated architecture", async () => {
    const data = await buildWorkspaceDashboardData(LIVE);
    expect(data.architecture.nodes.length).toBeGreaterThanOrEqual(5);
    expect(data.architecture.edges.length).toBeGreaterThan(0);
  });
});
