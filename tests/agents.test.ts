import { describe, expect, test } from "bun:test";
import { claudeCodeAgent } from "../src/agents/claude-code.ts";
import { shellSingleQuote } from "../src/core/shell.ts";

describe("shellSingleQuote", () => {
  test("wraps plain string in single quotes", () => {
    expect(shellSingleQuote("hello")).toBe("'hello'");
  });

  test("escapes embedded single quotes", () => {
    expect(shellSingleQuote("it's fine")).toBe(`'it'\\''s fine'`);
  });

  test("does not interpret double quotes, $, or backticks", () => {
    expect(shellSingleQuote('a "b" $c `d`')).toBe(`'a "b" $c \`d\`'`);
  });
});

describe("claudeCodeAgent.launchCommand", () => {
  test("returns bare `claude` when no prompt is given", () => {
    expect(claudeCodeAgent.launchCommand("/some/cwd")).toBe("claude");
  });

  test("returns bare `claude` when prompt is empty or whitespace", () => {
    expect(claudeCodeAgent.launchCommand("/some/cwd", { prompt: "" })).toBe("claude");
    expect(claudeCodeAgent.launchCommand("/some/cwd", { prompt: "   " })).toBe("claude");
  });

  test("appends prompt as a single-quoted argument", () => {
    expect(claudeCodeAgent.launchCommand("/x", { prompt: "do a thing" })).toBe(
      "claude 'do a thing'",
    );
  });

  test("safely escapes prompts with shell metacharacters", () => {
    const cmd = claudeCodeAgent.launchCommand("/x", {
      prompt: `read briefs/foo.md; echo "hi" $(rm -rf /)`,
    });
    expect(cmd).toBe(`claude 'read briefs/foo.md; echo "hi" $(rm -rf /)'`);
  });

  test("safely escapes prompts containing single quotes", () => {
    expect(claudeCodeAgent.launchCommand("/x", { prompt: "it's a brief" })).toBe(
      `claude 'it'\\''s a brief'`,
    );
  });
});
