import { describe, expect, test } from "bun:test";
import { getAgent } from "../src/agents/index.ts";
import { claudeCodeAgent } from "../src/agents/claude-code.ts";
import { codexAgent } from "../src/agents/codex.ts";
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

describe("codexAgent.launchCommand", () => {
  test("returns bare `codex` when no prompt is given", () => {
    expect(codexAgent.launchCommand("/some/cwd")).toBe("codex");
  });

  test("returns bare `codex` when prompt is empty or whitespace", () => {
    expect(codexAgent.launchCommand("/some/cwd", { prompt: "" })).toBe("codex");
    expect(codexAgent.launchCommand("/some/cwd", { prompt: "   " })).toBe("codex");
  });

  test("appends prompt as a single-quoted positional argument", () => {
    expect(codexAgent.launchCommand("/x", { prompt: "do a thing" })).toBe("codex 'do a thing'");
  });

  test("safely escapes prompts with shell metacharacters", () => {
    expect(
      codexAgent.launchCommand("/x", { prompt: `read briefs/foo.md; echo "hi" $(rm -rf /)` }),
    ).toBe(`codex 'read briefs/foo.md; echo "hi" $(rm -rf /)'`);
  });

  test("gives each dir its own repeatable --add-dir flag, no `--` terminator", () => {
    // Codex's `--add-dir <DIR>` is single-valued + repeatable (not variadic like Claude's), so
    // the positional prompt can follow directly without a `--` separator.
    expect(
      codexAgent.launchCommand("/x", {
        prompt: "analyze insights",
        addDirs: ["/home/u/.codex/sessions", "/other"],
      }),
    ).toBe("codex --add-dir '/home/u/.codex/sessions' --add-dir '/other' 'analyze insights'");
  });

  test("ignores blank add-dir entries", () => {
    expect(codexAgent.launchCommand("/x", { prompt: "go", addDirs: ["", "  "] })).toBe(
      "codex 'go'",
    );
  });

  test("safely escapes add-dir paths with shell metacharacters", () => {
    expect(codexAgent.launchCommand("/x", { addDirs: [`/tmp/a'b $(x)`] })).toBe(
      `codex --add-dir '/tmp/a'\\''b $(x)'`,
    );
  });
});

describe("getAgent registry", () => {
  test("resolves both backends by name", () => {
    expect(getAgent("claude-code")).toBe(claudeCodeAgent);
    expect(getAgent("codex")).toBe(codexAgent);
  });

  test("throws on unknown agent, listing supported names", () => {
    expect(() => getAgent("bogus")).toThrow(/Unknown agent "bogus"/);
  });
});

describe("claudeCodeAgent backend surface", () => {
  test("resumeCommand / resumeArgv", () => {
    expect(claudeCodeAgent.resumeCommand("abc-123")).toBe("claude --resume 'abc-123'");
    expect(claudeCodeAgent.resumeCommand("abc-123", "go on")).toBe(
      "claude --resume 'abc-123' 'go on'",
    );
    expect(claudeCodeAgent.resumeArgv("abc-123")).toEqual(["claude", "--resume", "abc-123"]);
    expect(claudeCodeAgent.resumeArgv("abc-123", "go on")).toEqual([
      "claude",
      "--resume",
      "abc-123",
      "go on",
    ]);
    // a whitespace-only prompt is treated as no prompt
    expect(claudeCodeAgent.resumeArgv("abc-123", "  ")).toEqual(["claude", "--resume", "abc-123"]);
  });

  test("conventions + prompts describe Claude's CLAUDE.md + namespaced commands", () => {
    expect(claudeCodeAgent.conventions).toEqual({ filename: "CLAUDE.md", supportsImports: true });
    expect(claudeCodeAgent.prompts.filename("goal")).toBe("goal.md");
  });

  test("headless argv is byte-identical to the historical claude -p shape", () => {
    const model = ["--model", "sonnet"];
    expect(claudeCodeAgent.headless.selfExclusion).toBe("session-id");
    expect(
      claudeCodeAgent.headless.extractionArgv("P", { modelArgs: model, addDir: "/k" }),
    ).toEqual([
      "claude",
      "-p",
      "P",
      "--model",
      "sonnet",
      "--output-format",
      "text",
      "--dangerously-skip-permissions",
      "--add-dir",
      "/k",
    ]);
    expect(
      claudeCodeAgent.headless.judgeArgv("P", { modelArgs: model, addDir: "/c", sessionId: "sid" }),
    ).toEqual([
      "claude",
      "-p",
      "P",
      "--model",
      "sonnet",
      "--output-format",
      "text",
      "--dangerously-skip-permissions",
      "--session-id",
      "sid",
      "--add-dir",
      "/c",
    ]);
  });
});

describe("codexAgent backend surface", () => {
  test("resumeCommand / resumeArgv use `codex resume <id> [prompt]`", () => {
    expect(codexAgent.resumeCommand("abc-123")).toBe("codex resume 'abc-123'");
    expect(codexAgent.resumeCommand("abc-123", "go on")).toBe("codex resume 'abc-123' 'go on'");
    expect(codexAgent.resumeArgv("abc-123", "go on")).toEqual([
      "codex",
      "resume",
      "abc-123",
      "go on",
    ]);
  });

  test("conventions is AGENTS.md without imports; prompts are flat servant-prefixed", () => {
    expect(codexAgent.conventions).toEqual({ filename: "AGENTS.md", supportsImports: false });
    expect(codexAgent.prompts.filename("goal")).toBe("servant-goal.md");
  });

  test("headless runs via `codex exec` with ephemeral self-exclusion, prompt last", () => {
    expect(codexAgent.headless.selfExclusion).toBe("ephemeral");
    const argv = codexAgent.headless.extractionArgv("PROMPT", {
      modelArgs: ["--model", "gpt-5.1-codex"],
      addDir: "/k",
    });
    expect(argv).toEqual([
      "codex",
      "exec",
      "--model",
      "gpt-5.1-codex",
      "--ephemeral",
      "--dangerously-bypass-approvals-and-sandbox",
      "--add-dir",
      "/k",
      "PROMPT",
    ]);
    // prompt must be the final (positional) arg so it is not parsed as a flag value
    expect(argv[argv.length - 1]).toBe("PROMPT");
  });
});
