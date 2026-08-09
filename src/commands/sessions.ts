import { defineCommand } from "citty";
import { applyRootOverride } from "../core/paths.ts";
import { resolveWorkspaceName } from "../core/workspace.ts";
import { type WorkspaceSession, readWorkspaceSessions } from "../core/workspace-sessions.ts";

// Deliberately print-and-exit, with no picker and no prompt anywhere in it. `servant resume` with
// no id opens an interactive picker, which is the right thing for a person at a keyboard and a trap
// for everything else — a headless Hands session asked "what is running?" reached for it and hung
// until its Summons was killed. This is the command that question has to have.

function describe(session: WorkspaceSession): string {
  const carrying =
    session.kind === "worker" && session.ticket
      ? `ticket #${session.ticket}`
      : session.kind === "hands"
        ? "a Summons' hands"
        : "no ticket";
  return `  ${session.name}\n      ${carrying} · ${session.status ?? "status unknown"} · pid ${session.pid}`;
}

export const sessionsCommand = defineCommand({
  meta: {
    name: "sessions",
    description:
      "List the Claude sessions running in a workspace right now — name, the ticket each carries, and whether it is busy. Reads the session registry; never asks a session anything.",
  },
  args: {
    workspace: {
      type: "string",
      required: false,
      alias: "w",
      description: "Workspace to look in (default: the current workspace).",
    },
    json: {
      type: "boolean",
      required: false,
      default: false,
      description: "Emit the report as JSON, for scripts and agents.",
    },
    root: {
      type: "string",
      required: false,
      description: "Servant root directory (default: ~/.ai_servant). For throwaway/test setups.",
    },
  },
  async run({ args }) {
    applyRootOverride(args.root);
    const workspace = await resolveWorkspaceName(args.workspace);
    const report = await readWorkspaceSessions(workspace);

    if (args.json) {
      console.log(JSON.stringify({ workspace, ...report }, null, 2));
      return;
    }
    // "Unknown" is not "none": this host may simply have no readable registry, and reporting that
    // as an empty workspace is the answer that gets two sessions into one worktree.
    if (!report.known) {
      console.log(
        `servant: cannot read this machine's session registry, so there is no telling what is running in "${workspace}".`,
      );
      return;
    }
    if (report.sessions.length === 0) {
      console.log(`servant: no sessions running in workspace "${workspace}".`);
      return;
    }
    const plural = report.sessions.length === 1 ? "session" : "sessions";
    console.log(`servant: ${report.sessions.length} ${plural} in workspace "${workspace}"\n`);
    for (const session of report.sessions) console.log(describe(session));
  },
});
