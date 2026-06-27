import { existsSync, readFileSync } from "node:fs";
import { workspaceArchitecturePath } from "../paths.ts";

// The architecture source is the single human-maintained declarative file (one per workspace) that
// feeds BOTH dashboard architecture panels — the diagram and the component map — so they never
// drift. This reader parses it into a typed graph (component nodes + edges derived from each
// component's `dependsOn`). It degrades like the artifact parsers: a missing file yields an empty
// architecture, a malformed file yields an empty architecture plus a non-fatal warning — never a
// crash. Parsing uses Bun's native YAML support (no added dependency).

/** A component's build-state — drives the diagram's node coloring. */
export type ComponentState = "built" | "in-progress" | "todo";

const COMPONENT_STATES: ReadonlySet<string> = new Set<ComponentState>([
  "built",
  "in-progress",
  "todo",
]);

/** One component being built in the workspace (a node in the architecture graph). */
export interface Component {
  /** Stable kebab-case key; also the edge endpoint id. */
  id: string;
  /** Display name. */
  label: string;
  /** What it does — one line. */
  purpose: string;
  /** Packages / tools / languages it uses. */
  tech: string[];
  /** Where it's implemented (repo- or workspace-relative). */
  path: string;
  /** The key decision behind it + why, or an `ADR-NNN` reference. */
  decision: string;
  /** Build-state; defaults to `todo` when absent/invalid. */
  state: ComponentState;
  /** Other component ids it depends on — the source of the diagram's edges. */
  dependsOn: string[];
  /** Optional build-phase id (e.g. `P0`, `R3`) linking the diagram to "where we are". */
  phase?: string;
}

/** A directed dependency edge between two component ids. */
export interface Edge {
  from: string;
  to: string;
}

/** The parsed architecture: component nodes plus edges derived from their `dependsOn`. */
export interface Architecture {
  nodes: Component[];
  edges: Edge[];
}

export function emptyArchitecture(): Architecture {
  return { nodes: [], edges: [] };
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === "string" ? v.trim() : String(v ?? "").trim()))
    .filter((v) => v.length > 0);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeState(value: unknown): ComponentState {
  const s = asString(value).toLowerCase();
  return COMPONENT_STATES.has(s) ? (s as ComponentState) : "todo";
}

function toComponent(raw: unknown): Component | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = asString(r.id);
  if (!id) return null; // a component without a stable id can't be a node or an edge endpoint
  const phase = asString(r.phase);
  return {
    id,
    label: asString(r.label) || id,
    purpose: asString(r.purpose),
    tech: asStringList(r.tech),
    path: asString(r.path),
    decision: asString(r.decision),
    state: normalizeState(r.state),
    dependsOn: asStringList(r.dependsOn),
    ...(phase ? { phase } : {}),
  };
}

/**
 * Parse architecture-source text (YAML) into a typed graph. Edges are emitted only between known
 * component ids, so a typo'd `dependsOn` target is dropped rather than producing a dangling edge in
 * the diagram. Throws on broken YAML or a top-level shape without a `components` list — the caller
 * turns that into an empty-but-valid architecture plus a warning.
 */
export function parseArchitectureText(text: string): Architecture {
  const doc: unknown = Bun.YAML.parse(text);
  const components = (doc as { components?: unknown } | null)?.components;
  if (!Array.isArray(components)) {
    throw new Error("architecture source: expected a top-level `components` list");
  }
  const nodes: Component[] = [];
  for (const raw of components) {
    const node = toComponent(raw);
    if (node) nodes.push(node);
  }
  const known = new Set(nodes.map((n) => n.id));
  const edges: Edge[] = [];
  for (const node of nodes) {
    for (const to of node.dependsOn) {
      if (known.has(to)) edges.push({ from: node.id, to });
    }
  }
  return { nodes, edges };
}

/**
 * Locate and parse a workspace's architecture source. A missing file → empty architecture (the
 * panels show a "define your architecture" empty state). A malformed file → empty architecture + a
 * non-fatal warning. Never throws.
 */
export function parseArchitecture(workspace: string): Architecture {
  const path = workspaceArchitecturePath(workspace);
  if (!existsSync(path)) return emptyArchitecture();
  try {
    return parseArchitectureText(readFileSync(path, "utf8"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[dashboard] ignoring malformed architecture source at ${path}: ${reason}`);
    return emptyArchitecture();
  }
}
