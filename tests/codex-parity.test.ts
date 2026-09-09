import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runCommand } from "citty";
import { codexAgent } from "../src/agents/codex.ts";
import { runFromHook, runDrain } from "../src/commands/extract-memories.ts";
import { fineTuneCommand } from "../src/commands/fine-tune.ts";
import { runInit } from "../src/commands/init.ts";
import { runJudgeFromHook, runJudgeDrain } from "../src/commands/insights-judge.ts";
import { resumeCommand } from "../src/commands/resume.ts";
import { closeBoard, createTicket, updateClaim } from "../src/core/board/store.ts";
import { ensureCodexAssets, ensureCodexHooks, toCodexPrompt } from "../src/core/codex-setup.ts";
import { codexSessionSource } from "../src/core/codex-session.ts";
import { defaultConfig, loadConfig, saveConfig } from "../src/core/config.ts";
import { getMarker, readJobs } from "../src/core/extract-queue.ts";
import { getAspect, writeOverlay } from "../src/core/fine-tune.ts";
import { headlessModelArgs } from "../src/core/headless-model.ts";
import { composeSetupParts } from "../src/core/insights/fingerprint.ts";
import { readJudgeJobs } from "../src/core/insights/judge-queue.ts";
import { getOrComputeMetrics } from "../src/core/insights/store.ts";
import { setRootOverride, workspacePath } from "../src/core/paths.ts";
import { sessionBackend } from "../src/core/session-backend.ts";
import { launchWorkspaceSession } from "../src/core/spawn.ts";
import { computeFrontier } from "../src/core/tasks.ts";
import {
  ensureWorkspaceDir,
  readWorkspaceAgent,
  untrackedSessionWorkspaces,
  writeWorkspaceAgent,
} from "../src/core/workspace.ts";
import { readWorkspaceSessions } from "../src/core/workspace-sessions.ts";
import { __registerDriverForTesting } from "../src/terminals/index.ts";
import type { OpenTabOptions } from "../src/terminals/types.ts";

let root: string;
let tabs: OpenTabOptions[];
let unregister: () => void;
let savedEnv: Record<string, string | undefined>;
const envKeys = [
  "CODEX_HOME",
  "SERVANT_HEADLESS_MODEL",
  "SERVANT_CODEX_HEADLESS_MODEL",
  "SERVANT_CLAUDE_HEADLESS_MODEL",
];
const sessionId = "019b5602-892f-7843-9524-27fc90a629dc";

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "servant-parity-")));
  savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) Reflect.deleteProperty(process.env, key);
  process.env.CODEX_HOME = join(root, "codex-home");
  setRootOverride(root);
  await saveConfig(defaultConfig());
  tabs = [];
  unregister = __registerDriverForTesting("parity-test", {
    name: "parity-test",
    openTab: async (tab) => {
      tabs.push(tab);
    },
  });
});

afterEach(async () => {
  unregister();
  closeBoard();
  setRootOverride(null);
  for (const key of envKeys) {
    const value = savedEnv[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

function message(role: string, text: string) {
  return {
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  };
}

async function writeRollout() {
  const cwd = await ensureWorkspaceDir("demo");
  const path = join(
    root,
    "codex-home",
    "sessions",
    "2026",
    "09",
    "09",
    `rollout-test-${sessionId}.jsonl`,
  );
  const usage = (input: number, cached: number, output: number) => ({
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
  });
  const tokens = (total: unknown, last: unknown) => ({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: total, last_token_usage: last, model_context_window: 258400 },
    },
  });
  const records = [
    { type: "session_meta", payload: { id: sessionId, cwd, cli_version: "0.153.4" } },
    { type: "turn_context", payload: { cwd, model: "test-model" } },
    message(
      "user",
      "# AGENTS.md instructions for demo\n<INSTRUCTIONS>\nRules\n</INSTRUCTIONS>\n<environment_context>test</environment_context>",
    ),
    message("user", "Inspect the files"),
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "cmd-1",
        arguments: JSON.stringify({ cmd: "cat big.txt", workdir: cwd }),
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "cmd-1",
        output: JSON.stringify({ output: "x".repeat(10000), exit_code: 1 }),
      },
    },
    message("assistant", "The command failed."),
    tokens(usage(1200, 400, 80), usage(1200, 400, 80)),
    // The next turn starts by repeating the previous totals. This must not double the spend.
    tokens(usage(1200, 400, 80), usage(1200, 400, 80)),
    message("user", "Continue"),
    message("assistant", "Final answer"),
    tokens(usage(3200, 900, 120), usage(2000, 500, 40)),
  ];
  await Bun.write(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return { cwd, path, records };
}

test("Codex setup preserves shared prompts and overlays, including literal shell variables", async () => {
  const aspect = getAspect("goal");
  if (!aspect) throw new Error("goal aspect missing");
  await writeOverlay(aspect, "Check $HOME and run /servant:recall first.");
  await ensureCodexAssets();
  const path = join(root, "codex-home", "prompts", "servant-goal.md");
  const body = await readFile(path, "utf8");
  expect(body).toContain("$ARGUMENTS");
  expect(body).toContain("Check $$HOME and run /prompts:servant-recall first.");
  expect(body).not.toContain("/servant:goal");
  const before = (await stat(path)).mtimeMs;
  await ensureCodexAssets();
  expect((await stat(path)).mtimeMs).toBe(before);
  expect(toCodexPrompt("Use /implement and $ARGUMENTS")).toBe("Use $$implement and $ARGUMENTS");
});

test("workspace Codex hooks preserve user hooks, use the selected root, and are idempotent", async () => {
  const path = join(workspacePath("hooks"), ".codex", "hooks.json");
  const custom = { type: "command", command: "echo custom" };
  await Bun.write(
    path,
    JSON.stringify({
      description: "mine",
      hooks: { Stop: [{ hooks: [custom] }], SessionEnd: [{ hooks: [custom] }] },
    }),
  );
  await ensureWorkspaceDir("hooks");
  const result = await Bun.file(path).json();
  expect(result.description).toBe("mine");
  expect(result.hooks.Stop[0].hooks).toEqual([custom]);
  expect(result.hooks.SessionEnd).toHaveLength(3);
  for (const group of result.hooks.SessionEnd.slice(1)) {
    expect(group.hooks[0].timeout).toBe(3);
    expect(group.hooks[0].command).toContain(`--agent codex --root '${root}'`);
  }
  const before = await Bun.file(path).text();
  await ensureCodexHooks(workspacePath("hooks"));
  expect(await Bun.file(path).text()).toBe(before);
  await Bun.write(path, "{broken");
  await expect(ensureCodexHooks(workspacePath("hooks"))).rejects.toThrow();
  expect(await Bun.file(path).text()).toBe("{broken");
});

test("init chooses Codex once, subsequent spawn and fine-tune use that choice", async () => {
  await runInit({ root, agent: "codex", yes: true, output: new PassThrough() });
  await runInit({ root, yes: true, output: new PassThrough() });
  expect((await loadConfig()).defaultAgent).toBe("codex");
  await launchWorkspaceSession({ workspace: "demo", terminal: "parity-test" });
  expect(tabs[0]?.command).toStartWith("codex ");
  expect(tabs[0]?.command).toContain("/prompts:servant-goal");
  const agents = await Bun.file(join(workspacePath("demo"), "AGENTS.md")).text();
  expect(agents).not.toContain("/servant:");
  expect(agents).toContain("/prompts:servant-goal");
  expect(agents).not.toContain("The mattpocock engineering skills are installed");
  await runCommand(fineTuneCommand, { rawArgs: ["--root", root, "--terminal", "parity-test"] });
  expect(tabs[1]?.command).toStartWith("codex ");
  expect(tabs[1]?.command).toContain("/prompts:servant-fine-tune");
  expect(tabs[1]?.command).not.toContain("--add-dir");
  await runCommand(fineTuneCommand, {
    rawArgs: ["--root", root, "--terminal", "parity-test", "--agent", "claude-code"],
  });
  expect(tabs[2]?.command).toStartWith("claude ");
});

test("fine-tune apply refreshes Codex prompts and existing inlined workspace instructions", async () => {
  await launchWorkspaceSession({ workspace: "demo", agent: "codex", terminal: "parity-test" });
  const general = getAspect("general");
  const goal = getAspect("goal");
  if (!general || !goal) throw new Error("missing aspects");
  await writeOverlay(general, "Use the shared vocabulary.");
  await writeOverlay(goal, "Keep the goal short.");
  await runCommand(fineTuneCommand, { rawArgs: ["--root", root, "--apply"] });
  expect(await Bun.file(join(workspacePath("demo"), "AGENTS.md")).text()).toContain(
    "Use the shared vocabulary.",
  );
  expect(await Bun.file(join(root, "codex-home", "prompts", "servant-goal.md")).text()).toContain(
    "Keep the goal short.",
  );
});

test("Codex workspace instructions preserve user-authored goal content", async () => {
  const cwd = await ensureWorkspaceDir("demo");
  const goal = "# Goal\n\nAudit CLAUDE.md and /servant:goal examples in the /research directory.";
  await Bun.write(join(cwd, "GOAL.md"), goal);
  await ensureWorkspaceDir("demo");
  expect(await Bun.file(join(cwd, "AGENTS.md")).text()).toContain(goal);
  expect(await Bun.file(join(cwd, "GOAL.md")).text()).toBe(goal);
});

test("resuming a Codex id refreshes conventions before inlining and persists its backend", async () => {
  const { cwd } = await writeRollout();
  await writeWorkspaceAgent("demo", "claude-code");
  await Bun.write(join(root, "CLAUDE.md"), "OUTDATED CONTENT");
  await runCommand(resumeCommand, {
    rawArgs: [sessionId, "--root", root, "--new-tab", "--terminal", "parity-test"],
  });
  expect(await readWorkspaceAgent("demo")).toBe("codex");
  expect(tabs[0]?.command).toStartWith("codex resume ");
  expect(await Bun.file(join(cwd, "AGENTS.md")).text()).not.toContain("OUTDATED CONTENT");
});

test("read-only Codex delegation enforces a sandbox and unsupported modes fail", () => {
  const command = codexAgent.launchCommand("/tmp", { permissionMode: "plan", prompt: "--help" });
  expect(command).toContain("--sandbox read-only --ask-for-approval never");
  expect(command).toEndWith("-- '--help'");
  expect(() => codexAgent.launchCommand("/tmp", { permissionMode: "acceptEdits" })).toThrow(
    "Unsupported Codex permission mode",
  );
  const argv = codexAgent.headless.extractionArgv("--help", { modelArgs: [], addDir: root });
  expect(argv).toContain("--skip-git-repo-check");
  expect(argv).toContain("workspace-write");
  expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(argv.slice(-2)).toEqual(["--", "--help"]);
});

test("backend-specific model settings prevent a Claude alias being sent to Codex", () => {
  process.env.SERVANT_HEADLESS_MODEL = "sonnet";
  process.env.SERVANT_CODEX_HEADLESS_MODEL = "default";
  expect(headlessModelArgs("codex")).toEqual([]);
  expect(headlessModelArgs("claude-code")).toEqual(["--model", "sonnet"]);
  process.env.SERVANT_CODEX_HEADLESS_MODEL = "custom-codex-model";
  expect(headlessModelArgs("codex")).toEqual(["--model", "custom-codex-model"]);
});

test("modern Codex usage, tool errors, context window, and injected instructions are parsed", async () => {
  const { path } = await writeRollout();
  const meta = await codexSessionSource.readSessionMeta(path);
  expect(meta.firstUserMessage).toBe("Inspect the files");
  expect(meta.userTurns).toBe(2);
  const metrics = await getOrComputeMetrics(path, (await stat(path)).mtimeMs, {
    source: codexSessionSource,
    sessionId,
  });
  expect(metrics.sessionId).toBe(sessionId);
  expect(metrics.tokens.totalOutput).toBe(120);
  expect(metrics.tokens.peakContext).toBe(2000);
  expect(metrics.tokens.contextWindowSize).toBe(258400);
  expect(metrics.instructions.errorToolResults).toBe(1);
  expect(metrics.tokens.contextCurve).toHaveLength(2);
});

test("capture and judgment retain the producing backend when the workspace switches", async () => {
  const { cwd, path, records } = await writeRollout();
  await writeWorkspaceAgent("demo", "claude-code");
  const hook = JSON.stringify({ session_id: sessionId, transcript_path: path, cwd });
  await runFromHook(hook, { kick: false });
  await runJudgeFromHook(hook, { kick: false, agent: "codex" });
  expect((await readJobs())[0]?.backend).toBe("codex");
  expect((await readJudgeJobs())[0]?.backend).toBe("codex");
  expect(await sessionBackend(path)).toBe("codex");
  const extraction = await runDrain({
    runner: async (job, prompt) => {
      expect(job.backend).toBe("codex");
      expect(prompt).toContain(join(root, "knowledge"));
      return "no durable facts";
    },
  });
  expect(extraction.processed).toBe(1);
  expect(await getMarker(sessionId)).toBe(records.length);
  let judged = false;
  await runJudgeDrain({
    runner: async ({ job, candidates }) => {
      judged = true;
      expect(job.backend).toBe("codex");
      expect(candidates.some((candidate) => candidate.kind === "large-tool-result")).toBe(true);
      return { sessionId: null, judgments: [] };
    },
  });
  expect(judged).toBe(true);
});

test("a Claude registry never makes Codex claims stale, including after a backend switch", async () => {
  await ensureWorkspaceDir("demo");
  await writeWorkspaceAgent("demo", "codex");
  await writeWorkspaceAgent("demo", "claude-code");
  const ticket = createTicket({ workspace: "demo", title: "Work" });
  const claim = { session: "demo-t1", at: new Date().toISOString() };
  updateClaim(ticket, claim);
  const frontier = computeFrontier([{ ...ticket, claim }], {
    known: true,
    liveSessions: ["other-claude-session"],
    unknownWorkspaces: await untrackedSessionWorkspaces(),
  });
  expect(frontier.stale).toHaveLength(0);
  expect(frontier.inFlight[0]?.liveness).toBe("unknown");
  expect(await readWorkspaceSessions("demo")).toEqual({ known: false });
});

test("fingerprints include the full bundled command set for both backends", async () => {
  const claude = await composeSetupParts("claude-code");
  const codex = await composeSetupParts("codex");
  expect(claude.commands).toContain("/servant:handoff");
  expect(codex.commands).toContain("/prompts:servant-handoff");
  expect(codex.commands).toContain("/prompts:servant-lead");
  expect(codex.claudeMd).not.toContain("CLAUDE.md");
});

test("an isolated root keeps usable prompt files without writing to the real Codex home", async () => {
  Reflect.deleteProperty(process.env, "CODEX_HOME");
  await launchWorkspaceSession({ workspace: "isolated", agent: "codex", terminal: "parity-test" });
  const file = join(root, "codex", "prompts", "servant-goal.md");
  expect(await Bun.file(file).exists()).toBe(true);
  expect(tabs[0]?.command).toContain(file);
});

test("Codex hook entry counts only the minimum prefix; extraction still counts all source entries", async () => {
  const { path, records } = await writeRollout();
  expect(await codexSessionSource.countRecords(path, 6)).toBe(6);
  expect(await codexSessionSource.countRecords(path)).toBe(records.length);
  await Bun.write(path, `${await Bun.file(path).text()}null\n{partial\n`);
  expect(await codexSessionSource.countRecords(path)).toBe(records.length);
  expect((await codexSessionSource.readSessionMeta(path)).lastAssistantMessage).toBe(
    "Final answer",
  );
  expect(await codexSessionSource.countRecords(join(root, "missing.jsonl"))).toBe(0);
});
