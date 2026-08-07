import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexSessionSource } from "../src/core/codex-session.ts";

// Hermetic: point CODEX_HOME at a temp dir so nothing touches the real ~/.codex.
let codexHome: string;
let sessionsDir: string;
let rolloutPath: string;
const SESSION_ID = "019b5602-892f-7843-9524-27fc90a629dc";

const line = (obj: unknown) => `${JSON.stringify(obj)}\n`;

beforeAll(async () => {
  codexHome = await mkdtemp(join(tmpdir(), "codex-home-"));
  process.env.CODEX_HOME = codexHome;
  sessionsDir = join(codexHome, "sessions", "2025", "12", "25");
  await Bun.write(join(sessionsDir, ".keep"), "");
  rolloutPath = join(sessionsDir, `rollout-2025-12-25T16-56-05-${SESSION_ID}.jsonl`);

  const cwd = "/Users/example/Projects/demo";
  const content =
    line({
      timestamp: "2025-12-25T14:56:05.446Z",
      type: "session_meta",
      payload: { id: SESSION_ID, cwd, cli_version: "0.77.0", originator: "codex_cli" },
    }) +
    line({
      timestamp: "2025-12-25T14:56:06.000Z",
      type: "turn_context",
      payload: { cwd, model: "gpt-5-codex", effort: "medium", summary: "auto" },
    }) +
    // Auto-injected environment context — must NOT count as a user turn.
    line({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<environment_context>\n<cwd>x</cwd>\n</environment_context>",
          },
        ],
      },
    }) +
    line({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "list the files here" }],
      },
    }) +
    line({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1200,
            cached_input_tokens: 400,
            output_tokens: 80,
            total_tokens: 1280,
          },
          last_token_usage: {
            input_tokens: 1200,
            cached_input_tokens: 400,
            output_tokens: 80,
            total_tokens: 1280,
          },
          model_context_window: 258400,
        },
      },
    }) +
    line({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Sure, listing the files now." }],
      },
    }) +
    line({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell",
        arguments: JSON.stringify({ command: ["bash", "-lc", "ls -la"], workdir: cwd }),
        call_id: "call_ABC123",
      },
    }) +
    line({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_ABC123",
        output: JSON.stringify({
          output: "file_a.txt\nfile_b.txt\n",
          metadata: { exit_code: 0, duration_seconds: 0.1 },
        }),
      },
    }) +
    line({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Done — two files." }],
      },
    });
  await writeFile(rolloutPath, content);
});

afterAll(async () => {
  delete process.env.CODEX_HOME;
  await rm(codexHome, { recursive: true, force: true });
});

test("findSessionFile resolves the rollout by its trailing uuid", async () => {
  expect(codexSessionSource.validateSessionId.bind(null, SESSION_ID)).not.toThrow();
  const found = await codexSessionSource.findSessionFile(SESSION_ID);
  expect(found).toBe(rolloutPath);
  expect(
    await codexSessionSource.findSessionFile("019b5602-0000-7000-8000-000000000000"),
  ).toBeNull();
});

test("validateSessionId rejects non-uuids", () => {
  expect(() => codexSessionSource.validateSessionId("not-a-uuid")).toThrow();
});

test("readLaunchCwd returns the session_meta cwd", async () => {
  expect(await codexSessionSource.readLaunchCwd(rolloutPath)).toBe("/Users/example/Projects/demo");
});

test("readSessionMeta extracts ids, cwd, turns, model, messages", async () => {
  const meta = await codexSessionSource.readSessionMeta(rolloutPath);
  expect(meta.sessionId).toBe(SESSION_ID);
  expect(meta.jsonlPath).toBe(rolloutPath);
  expect(meta.launchCwd).toBe("/Users/example/Projects/demo");
  expect(meta.latestCwd).toBe("/Users/example/Projects/demo");
  expect(meta.model).toBe("gpt-5-codex");
  // env-context message is filtered → exactly one real user turn.
  expect(meta.userTurns).toBe(1);
  expect(meta.assistantTurns).toBe(2);
  expect(meta.firstUserMessage).toBe("list the files here");
  expect(meta.lastUserMessage).toBe("list the files here");
  expect(meta.lastAssistantMessage).toBe("Done — two files.");
  expect(meta.mtimeMs).toBeGreaterThan(0);
});

test("readRecords yields claude-shaped records (Bash tool_use, tool_result, assistant usage)", async () => {
  const records: any[] = [];
  for await (const { record, line } of codexSessionSource.readRecords(rolloutPath)) {
    expect(typeof line).toBe("number");
    records.push(record);
  }

  // env-context user message is dropped; the real user message survives.
  const userTexts = records.filter(
    (r) => r.type === "user" && r.message.content[0]?.type === "text",
  );
  expect(userTexts).toHaveLength(1);
  expect(userTexts[0].message.content[0].text).toBe("list the files here");

  // shell → Bash tool_use with the unwrapped command string.
  const toolUse = records
    .flatMap((r) => (Array.isArray(r.message?.content) ? r.message.content : []))
    .find((b: any) => b.type === "tool_use");
  expect(toolUse.name).toBe("Bash");
  expect(toolUse.id).toBe("call_ABC123");
  expect(toolUse.input.command).toBe("ls -la");

  // function_call_output → tool_result (exit_code 0 ⇒ not an error).
  const toolResult = records
    .flatMap((r) => (Array.isArray(r.message?.content) ? r.message.content : []))
    .find((b: any) => b.type === "tool_result");
  expect(toolResult.tool_use_id).toBe("call_ABC123");
  expect(toolResult.is_error).toBe(false);
  expect(toolResult.content).toContain("file_a.txt");

  // assistant text record carries mapped usage (input=total-cached, cache_read=cached).
  const withUsage = records.find((r) => r.type === "assistant" && r.message?.usage);
  expect(withUsage.message.usage.input_tokens).toBe(800);
  expect(withUsage.message.usage.cache_read_input_tokens).toBe(400);
  expect(withUsage.message.usage.cache_creation_input_tokens).toBe(0);
  expect(withUsage.message.usage.output_tokens).toBe(80);
  expect(withUsage.version).toBe("0.77.0");
});

test("countRecords counts yielded records", async () => {
  const n = await codexSessionSource.countRecords(rolloutPath);
  let manual = 0;
  for await (const _ of codexSessionSource.readRecords(rolloutPath)) manual += 1;
  expect(n).toBe(manual);
  expect(n).toBeGreaterThan(0);
});
