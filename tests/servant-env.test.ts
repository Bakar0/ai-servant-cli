import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRootOverride, servantEnvPath } from "../src/core/paths.ts";
import { parseEnvFile, readServantEnv, resolveSecret } from "../src/core/servant-env.ts";

describe("parseEnvFile", () => {
  test("reads plain assignments", () => {
    expect(parseEnvFile("OPENAI_API_KEY=sk-abc\nOTHER=2\n")).toEqual({
      OPENAI_API_KEY: "sk-abc",
      OTHER: "2",
    });
  });

  test("tolerates the shapes people actually write", () => {
    const parsed = parseEnvFile(
      [
        "# a comment",
        "",
        "export EXPORTED=yes",
        `QUOTED="double quoted"`,
        "SINGLE='single quoted'",
        "  SPACED  =  padded  ",
        "URL=https://example.com/?a=1&b=2",
        "EMPTY=",
      ].join("\n"),
    );

    expect(parsed).toEqual({
      EXPORTED: "yes",
      QUOTED: "double quoted",
      SINGLE: "single quoted",
      SPACED: "padded",
      URL: "https://example.com/?a=1&b=2",
      EMPTY: "",
    });
  });

  test("keeps what it can read when a line is malformed", () => {
    expect(parseEnvFile("GOOD=1\nthis line has no equals sign\n=novalue\nALSO_GOOD=2\n")).toEqual({
      GOOD: "1",
      ALSO_GOOD: "2",
    });
  });
});

describe("resolveSecret", () => {
  test("the real environment outranks the file", () => {
    expect(resolveSecret("K", { K: "from-env" }, { K: "from-file" })).toBe("from-env");
  });

  test("the file fills a gap the environment leaves", () => {
    expect(resolveSecret("K", {}, { K: "from-file" })).toBe("from-file");
    expect(resolveSecret("K", { K: "  " }, { K: "from-file" })).toBe("from-file");
    expect(resolveSecret("K", { K: undefined }, { K: "from-file" })).toBe("from-file");
  });

  test("absent everywhere is undefined, not an empty string", () => {
    expect(resolveSecret("K", {}, {})).toBeUndefined();
  });
});

describe("readServantEnv", () => {
  let scratch: string;

  beforeAll(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), "servant-env-test-")));
    await mkdir(scratch, { recursive: true });
  });

  afterAll(async () => {
    setRootOverride(null);
    await rm(scratch, { recursive: true, force: true });
  });

  test("resolves from the servant root, so --root redirects it", async () => {
    const redirected = join(scratch, "other-root");
    await mkdir(redirected, { recursive: true });
    await writeFile(join(redirected, ".env"), "OPENAI_API_KEY=sk-redirected\n");

    setRootOverride(redirected);
    expect(servantEnvPath()).toBe(join(redirected, ".env"));
    expect(await readServantEnv()).toEqual({ OPENAI_API_KEY: "sk-redirected" });
  });

  test("a root with no .env is not an error", async () => {
    const bare = join(scratch, "bare-root");
    await mkdir(bare, { recursive: true });

    setRootOverride(bare);
    expect(await readServantEnv()).toEqual({});
  });
});
