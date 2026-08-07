import { getVersion } from "../../version.ts";
import { type Architecture, parseArchitecture } from "./architecture.ts";
import { type PhaseState, type PlanItem, parseGoal, parsePlans } from "./artifacts.ts";

// The workspace dashboard's JSON payload (re-scoped to 4 panels in 2 sections). The renderer injects
// this verbatim into the template's one slot. It carries exactly what the surviving panels need —
// Mission (GOAL.md), Where-we-are (the plan-phase timeline + a "you are here" marker), and the
// Architecture graph (which also feeds the component-map view). All of it comes from deterministic
// workspace-artifact parsing; nothing reads the insights store anymore. Each field degrades on its
// own: a missing artifact yields an empty-but-valid value, never a crash.

/** One phase on the where-we-are timeline. `label`/`note` are optional, best-effort, unset for now. */
export interface WhereWeArePhase {
  id: string;
  label?: string;
  state: PhaseState;
  note?: string;
}

/** A plan rendered as a phase row on the timeline. */
export interface WhereWeArePlan {
  title: string;
  phases: WhereWeArePhase[];
  doneCount: number;
  totalCount: number;
}

/** The plan-phase timeline plus the single "you are here" marker the Panel-3 design needs. */
export interface WhereWeAre {
  plans: WhereWeArePlan[];
  /** First non-done phase of the most-recent active plan — the current build phase. */
  current?: { planTitle: string; phaseId: string };
}

export interface WorkspaceDashboardData {
  workspace: string;
  generatedAt: number;
  version: string;
  /** The one-line mission from GOAL.md (`## Mission`); empty when none is defined. */
  mission: string;
  /** The plan-phase timeline + the current-phase marker. */
  whereWeAre: WhereWeAre;
  /**
   * The parsed architecture source (component nodes + dependency edges) — the single declarative feed
   * for both the architecture diagram and the component-map view. Empty when no source file exists.
   */
  architecture: Architecture;
}

/** A plan is "active" if it has begun, has work left, and isn't a dead/parked plan. */
function isActivePlan(p: PlanItem): boolean {
  return (
    p.totalCount > 0 &&
    p.doneCount < p.totalCount &&
    p.status !== "abandoned" &&
    p.status !== "superseded" &&
    p.status !== "reversed" &&
    p.status !== "done"
  );
}

/**
 * The "you are here" marker: the first non-done phase of the **most-recent** active plan. Plan ids are
 * date-prefixed (`YYYY-MM-DD-HHMM-…`), so the lexicographically-largest active id is the newest live
 * plan — where work currently sits. Undefined when no plan is active.
 */
function deriveCurrent(plans: PlanItem[]): WhereWeAre["current"] {
  const active = plans.filter(isActivePlan).toSorted((a, b) => b.id.localeCompare(a.id));
  const plan = active[0];
  if (!plan) return undefined;
  const phase = plan.phases.find((p) => p.state !== "done");
  if (!phase) return undefined;
  return { planTitle: plan.title, phaseId: phase.id };
}

function buildWhereWeAre(plans: PlanItem[]): WhereWeAre {
  const current = deriveCurrent(plans);
  return {
    plans: plans.map((p) => ({
      title: p.title,
      phases: p.phases.map((ph) => ({
        id: ph.id,
        state: ph.state,
        ...(ph.label ? { label: ph.label } : {}),
      })),
      doneCount: p.doneCount,
      totalCount: p.totalCount,
    })),
    ...(current ? { current } : {}),
  };
}

/**
 * Build the dashboard payload for a workspace: the one-line mission from GOAL.md, the where-we-are
 * plan-phase timeline (with the current-phase marker), and the parsed architecture graph. Pure,
 * deterministic, offline — no insights store, no model, no network.
 */
export function buildWorkspaceDashboardData(workspace: string): WorkspaceDashboardData {
  return {
    workspace,
    generatedAt: Date.now(),
    version: getVersion(),
    mission: parseGoal(workspace).mission,
    whereWeAre: buildWhereWeAre(parsePlans(workspace)),
    architecture: parseArchitecture(workspace),
  };
}
