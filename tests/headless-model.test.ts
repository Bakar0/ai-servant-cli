import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { claudeCodeAgent } from "../src/agents/claude-code.ts";
import { extractionArgv } from "../src/commands/extract-memories.ts";
import { headlessModelArgs } from "../src/core/headless-model.ts";
import { judgeArgv } from "../src/core/insights/judgments.ts";

const ENV = "SERVANT_HEADLESS_MODEL";

// The env var is read live by headlessModelArgs(), so each test sets it explicitly and the
// hooks restore the original. The *default* case needs the var truly unset (not ""), since ""
// is itself the escape hatch — so we delete it via Reflect (the `delete` operator is biome-flagged).
let original: string | undefined;
beforeEach(() => {
  original = process.env[ENV];
});
afterEach(() => {
  if (original === undefined) Reflect.deleteProperty(process.env, ENV);
  else process.env[ENV] = original;
});

describe("headlessModelArgs", () => {
  test("defaults to `--model sonnet` when the env var is unset", () => {
    Reflect.deleteProperty(process.env, ENV);
    expect(headlessModelArgs()).toEqual(["--model", "sonnet"]);
  });

  test("honors an explicit model override", () => {
    process.env[ENV] = "opus";
    expect(headlessModelArgs()).toEqual(["--model", "opus"]);
  });

  test("trims surrounding whitespace in the override", () => {
    process.env[ENV] = "  haiku  ";
    expect(headlessModelArgs()).toEqual(["--model", "haiku"]);
  });

  test("escape hatch: empty value omits --model (inherit user default)", () => {
    process.env[ENV] = "";
    expect(headlessModelArgs()).toEqual([]);
  });

  test('escape hatch: "default" omits --model (inherit user default)', () => {
    process.env[ENV] = "default";
    expect(headlessModelArgs()).toEqual([]);
  });
});

describe("headless `claude -p` arg arrays", () => {
  test("extraction argv carries `--model sonnet` by default", () => {
    Reflect.deleteProperty(process.env, ENV);
    const argv = extractionArgv("the prompt");
    expect(argv.slice(0, 2)).toEqual(["claude", "-p"]);
    expect(argv).toContain("--model");
    expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");
  });

  test("judge argv carries `--model sonnet` by default", () => {
    Reflect.deleteProperty(process.env, ENV);
    const argv = judgeArgv("the prompt", "session-123");
    expect(argv.slice(0, 2)).toEqual(["claude", "-p"]);
    expect(argv).toContain("--model");
    expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");
  });

  test("env override flows into both headless arg arrays", () => {
    process.env[ENV] = "opus";
    for (const argv of [extractionArgv("p"), judgeArgv("p", "s")]) {
      expect(argv[argv.indexOf("--model") + 1]).toBe("opus");
    }
  });

  test("escape hatch removes --model from both headless arg arrays", () => {
    process.env[ENV] = "default";
    for (const argv of [extractionArgv("p"), judgeArgv("p", "s")]) {
      expect(argv).not.toContain("--model");
    }
  });
});

describe("per-backend headless model", () => {
  test("Codex omits --model by default (inherits its ~/.codex/config.toml model)", () => {
    Reflect.deleteProperty(process.env, ENV);
    expect(headlessModelArgs("codex")).toEqual([]);
    // Claude keeps its sonnet default.
    expect(headlessModelArgs("claude-code")).toEqual(["--model", "sonnet"]);
  });

  test("Codex extraction argv is `codex exec … --ephemeral …` with the prompt last, no --model", () => {
    Reflect.deleteProperty(process.env, ENV);
    const argv = extractionArgv("the prompt", "codex");
    expect(argv.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(argv).toContain("--ephemeral");
    expect(argv).not.toContain("--model");
    expect(argv[argv.length - 1]).toBe("the prompt");
  });

  test("env override still applies to Codex when set explicitly", () => {
    process.env[ENV] = "gpt-5.1-codex";
    expect(headlessModelArgs("codex")).toEqual(["--model", "gpt-5.1-codex"]);
  });
});

describe("interactive launch is unaffected by the headless model knob", () => {
  test("launchCommand never emits --model, even with the env var set", () => {
    process.env[ENV] = "sonnet";
    expect(claudeCodeAgent.launchCommand("/x", { prompt: "do a thing" })).not.toContain("--model");
    expect(claudeCodeAgent.launchCommand("/x", { prompt: "do a thing" })).toBe(
      "claude 'do a thing'",
    );
  });
});
