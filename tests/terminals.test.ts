import { describe, expect, test } from "bun:test";
import { __testing as cmuxTesting } from "../src/terminals/cmux.ts";
import { detectTerminalName, getDriver } from "../src/terminals/index.ts";

describe("getDriver", () => {
  test("returns cmux and iterm drivers by name", () => {
    expect(getDriver("cmux").name).toBe("cmux");
    expect(getDriver("iterm").name).toBe("iterm");
  });

  test("throws on unknown name", () => {
    expect(() => getDriver("warp")).toThrow(/Unknown terminal/);
  });
});

describe("detectTerminalName", () => {
  test("prefers cmux when TERM_PROGRAM=cmux", () => {
    expect(
      detectTerminalName({ TERM_PROGRAM: "cmux", platform: "darwin", cmuxOnPath: false }),
    ).toBe("cmux");
  });

  test("prefers cmux when CMUX_SOCKET_PATH is set", () => {
    expect(detectTerminalName({ CMUX_SOCKET_PATH: "/tmp/cmux.sock", platform: "darwin" })).toBe(
      "cmux",
    );
  });

  test("returns iterm when TERM_PROGRAM=iTerm.app", () => {
    expect(detectTerminalName({ TERM_PROGRAM: "iTerm.app", platform: "darwin" })).toBe("iterm");
  });

  test("falls back to cmux on darwin when cmux is on PATH", () => {
    expect(detectTerminalName({ platform: "darwin", cmuxOnPath: true })).toBe("cmux");
  });

  test("falls back to iterm on darwin when cmux is not on PATH", () => {
    expect(detectTerminalName({ platform: "darwin", cmuxOnPath: false })).toBe("iterm");
  });

  test("returns null on non-darwin with no signals", () => {
    expect(detectTerminalName({ platform: "linux" })).toBeNull();
  });
});

describe("cmux.extractSurfaceRef", () => {
  test("extracts surface:N from typical output", () => {
    expect(cmuxTesting.extractSurfaceRef("surface:7\n")).toBe("surface:7");
    expect(cmuxTesting.extractSurfaceRef("created surface:42 in workspace:3")).toBe("surface:42");
  });

  test("throws when no surface ref is present", () => {
    expect(() => cmuxTesting.extractSurfaceRef("ok\n")).toThrow(/surface ref/);
  });
});

describe("cmux.buildSurfaceSendPayload", () => {
  test("prefixes the command with `cd <cwd> &&` so new surfaces start in the right dir", () => {
    expect(cmuxTesting.buildSurfaceSendPayload("/Users/me/work", "claude --resume abc")).toBe(
      `cd '/Users/me/work' && claude --resume abc`,
    );
  });

  test("single-quotes paths containing quotes", () => {
    expect(cmuxTesting.buildSurfaceSendPayload("/Users/o'brien/x", "claude")).toBe(
      `cd '/Users/o'\\''brien/x' && claude`,
    );
  });
});
