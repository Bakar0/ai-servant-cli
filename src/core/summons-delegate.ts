// The outside of the delegation seam: what actually happens when the user says yes. Spawning,
// claiming and transcript-reading all live here, so the controller's gate and dispatch discipline
// can be tested against a fake with no tabs, no `gh` and no clock (workspace ADR 0009).

import { listWorkspaceSessions } from "./claude-session.ts";
import { claimTicket, releaseTicketClaim } from "./claims.ts";
import { type SessionLiveness, readSessionLiveness } from "./session-registry.ts";
import { launchWorkspaceSession } from "./spawn.ts";
import type {
  DelegationHandle,
  DelegationReport,
  DelegationRequest,
  DelegationStatus,
  SummonsActions,
} from "./summons.ts";

/** Spoken aloud, so a wall of text helps nobody — the user can open the tab for the rest. */
const MAX_SPOKEN_LATEST_CHARS = 1_200;

/**
 * The permission mode a read-only delegation runs in. This is what buys `research` its exemption
 * from the confirm-gate: the exemption rests on the session being unable to write, not on the
 * model having honestly labelled the request. Mislabel a refactor as research and it still cannot
 * touch a file — it explores and reports instead.
 */
const READ_ONLY_PERMISSION_MODE = "plan";

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A Worker session's name, and therefore its address. Ticketed work is `<workspace>-t<ticket>`,
 * which anything holding the ticket can compute without searching for it (workspace ADR 0010).
 * Ad-hoc work has no ticket to be derived from, so it is addressed by its spoken label instead.
 *
 * The workspace is slugged on the way in (`ai_servant` → `ai-servant-t17`), so this function, not
 * the template, is the thing to call — hand-building the name from a workspace containing anything
 * but `[a-z0-9]` produces an address that resolves to nothing.
 */
export function delegationSessionName(workspace: string, request: DelegationRequest): string {
  const base = slug(workspace);
  return request.ticket ? `${base}-t${request.ticket}` : `${base}-${slug(request.label)}`;
}

/**
 * The marker that ties a transcript back to the delegation that started it. Observation resolves
 * through this rather than through the session registry, because the registry entry disappears
 * the moment the session exits — which is exactly when "what did it conclude?" gets asked.
 */
function marker(sessionName: string): string {
  return `servant delegation: ${sessionName}`;
}

export interface DelegationPromptContext {
  workspace: string;
  hubRepo: string;
  sessionName: string;
  request: DelegationRequest;
}

/**
 * The first message the delegated session wakes up to. It carries the task, the conversation it
 * came out of, and — for ticketed work — the instruction to release its Claim when it is done,
 * since nothing watches the session to release it on its behalf.
 */
export function composeDelegationPrompt(ctx: DelegationPromptContext): string {
  const { request, sessionName, hubRepo } = ctx;
  const parts = [
    marker(sessionName),
    `You were handed this ${request.readOnly ? "question" : "task"} out loud, during a spoken Summons of the "${ctx.workspace}" workspace. The user is away from the keyboard, so work it end to end and leave your conclusion as your final message — that message is what gets read back to them, out loud, so make it answer the question on its own.`,
    request.readOnly
      ? `## Question\n\n${request.task}\n\nThis is a read-only investigation and the session is in plan mode: find the answer and report it. Do not propose to start editing.`
      : `## Task\n\n${request.task}`,
  ];
  if (request.repo) {
    parts.push(
      `## Repo\n\nThe work is in the mounted repo \`repos/\` worktree for \`${request.repo}\`.`,
    );
  }
  if (request.ticket) {
    parts.push(
      `## Ticket\n\nThis carries issue #${request.ticket} in ${hubRepo}, and this session holds the Claim on it. When the work is finished, release it:\n\n\`\`\`\nservant claim ${request.ticket} --release --session ${sessionName}\n\`\`\``,
    );
  }
  if (request.conversation) {
    parts.push(`## How it came up\n\n${request.conversation}`);
  }
  return `${parts.join("\n\n")}\n`;
}

/**
 * What to say a session is doing, from its liveness and how much it has said.
 *
 * "Finished" is claimed only on positive evidence that it stopped, because the controller frees a
 * repo on that word — an unreadable registry must therefore stay `unknown`, never `finished`.
 * Being alive is not the same as working either: a session that has finished sits at its prompt.
 */
function statusOf(live: SessionLiveness, assistantTurns: number): DelegationStatus {
  if (!live.known) return "unknown";
  if (live.session && live.session.status !== "idle") return "running";
  if (assistantTurns === 0) return live.session ? "running" : "unknown";
  return "finished";
}

export interface SummonsActionsDeps {
  workspace: string;
  hubRepo: string;
  terminal?: string | undefined;
  /** Injected in tests; default to the real spawn, `gh` and transcript/registry readers. */
  launch?: typeof launchWorkspaceSession;
  claim?: typeof claimTicket;
  release?: typeof releaseTicketClaim;
  listSessions?: typeof listWorkspaceSessions;
  liveness?: typeof readSessionLiveness;
}

export function createSummonsActions(deps: SummonsActionsDeps): SummonsActions {
  const launch = deps.launch ?? launchWorkspaceSession;
  const claim = deps.claim ?? claimTicket;
  const release = deps.release ?? releaseTicketClaim;
  const listSessions = deps.listSessions ?? listWorkspaceSessions;
  const liveness = deps.liveness ?? readSessionLiveness;

  return {
    async delegate(request: DelegationRequest): Promise<DelegationHandle> {
      const sessionName = delegationSessionName(deps.workspace, request);
      const ticket = request.ticket;
      // Claimed first, deliberately: the window this closes is a session running unclaimed, which
      // is exactly when a second one gets dispatched onto the same ticket and the same worktree.
      if (ticket) await claim(deps.hubRepo, ticket, sessionName, {});
      try {
        await launch({
          workspace: deps.workspace,
          prompt: composeDelegationPrompt({
            workspace: deps.workspace,
            hubRepo: deps.hubRepo,
            sessionName,
            request,
          }),
          sessionName,
          terminal: deps.terminal,
          permissionMode: request.readOnly ? READ_ONLY_PERMISSION_MODE : undefined,
        });
      } catch (err) {
        // A Claim with no session behind it would read as in-flight work forever.
        if (ticket) await release(deps.hubRepo, ticket, sessionName, {}).catch(() => {});
        throw err;
      }
      return { label: request.label, sessionName, ticket, repo: request.repo };
    },

    async observe(handle: DelegationHandle): Promise<DelegationReport> {
      const live = await liveness(handle.sessionName);
      const sessions = await listSessions({ workspaceName: deps.workspace });
      const meta = sessions.find((s) => s.firstUserMessage?.includes(marker(handle.sessionName)));
      const latest = meta?.lastAssistantMessage?.trim() ?? null;
      return {
        status: statusOf(live, meta?.assistantTurns ?? 0),
        latest:
          latest && latest.length > MAX_SPOKEN_LATEST_CHARS
            ? `${latest.slice(0, MAX_SPOKEN_LATEST_CHARS)}…`
            : latest,
        turns: meta?.assistantTurns ?? 0,
      };
    },
  };
}
