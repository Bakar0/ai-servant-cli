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

  test("separates a variadic --add-dir from the prompt with `--`", () => {
    // `--add-dir` is variadic; without the `--` terminator it would swallow the prompt as a dir.
    expect(
      claudeCodeAgent.launchCommand("/x", {
        prompt: "analyze insights",
        addDirs: ["/home/u/.claude/projects"],
      }),
    ).toBe("claude --add-dir '/home/u/.claude/projects' -- 'analyze insights'");
  });

  test("passes multiple dirs to one --add-dir flag and omits `--` when there is no prompt", () => {
    expect(claudeCodeAgent.launchCommand("/x", { addDirs: ["/a", "/b"] })).toBe(
      "claude --add-dir '/a' '/b'",
    );
  });

  test("ignores blank add-dir entries", () => {
    expect(claudeCodeAgent.launchCommand("/x", { prompt: "go", addDirs: ["", "  "] })).toBe(
      "claude 'go'",
    );
  });

  test("safely escapes add-dir paths with shell metacharacters", () => {
    expect(claudeCodeAgent.launchCommand("/x", { addDirs: [`/tmp/a'b $(x)`] })).toBe(
      `claude --add-dir '/tmp/a'\\''b $(x)'`,
    );
  });
});
