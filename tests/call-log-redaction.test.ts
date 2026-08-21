import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLiveCallLogView } from "../src/core/call-log/live.ts";
import { redactFields, redactSecrets } from "../src/core/call-log/record.ts";
import { openCallLog } from "../src/core/call-log/store.ts";
import { setRootOverride } from "../src/core/paths.ts";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "servant-call-log-redact-"));
  setRootOverride(root);
});

afterAll(async () => {
  setRootOverride(null);
  await rm(root, { recursive: true, force: true });
});

// A Summons reads files out loud and the agent cannot tell a secret from a sentence, so the record
// cannot rely on it not saying one. These are the shapes that must never survive the write.
const SECRETS: [string, string][] = [
  ["OpenAI", "sk-proj-abc123DEF456ghi789JKL012mno345"],
  ["Anthropic", "sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  ["GitHub classic", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
  ["GitHub fine-grained", "github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz012345"],
  // Assembled rather than written out: GitHub's push protection reads the literal as a live Slack
  // token and blocks the push. The value the test sees is identical.
  ["Slack", ["xoxb", "1234567890", "abcdefghijklmno"].join("-")],
  ["AWS", "AKIAIOSFODNN7EXAMPLE"],
  ["Google", "AIzaSyA1234567890abcdefghijklmnopqrstuv"],
  [
    "JWT",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  ],
];

describe("redacting secrets", () => {
  for (const [vendor, secret] of SECRETS) {
    test(`scrubs a ${vendor} key`, () => {
      const out = redactSecrets(`the key is ${secret} — use it`);
      expect(out).not.toContain(secret);
      expect(out).toContain("[redacted]");
    });
  }

  test("scrubs a value only its name identifies, keeping the name so the line still reads", () => {
    expect(redactSecrets("OPENAI_API_KEY=hunter2-and-then-some")).toBe("OPENAI_API_KEY=[redacted]");
    expect(redactSecrets('"token": "abcdefgh12345678"')).toBe('"token": "[redacted]"');
    expect(redactSecrets("password: correcthorsebattery")).toBe("password: [redacted]");
  });

  test("scrubs an Authorization header and a whole PEM block", () => {
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuv")).toBe(
      "Authorization: [redacted]",
    );
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAK\n-----END RSA PRIVATE KEY-----";
    expect(redactSecrets(pem)).toBe("[redacted]");
  });

  test("leaves ordinary conversation alone", () => {
    const said = "read the goal file and tell me what phase we're in — docs/adr/0009-talk.md";
    expect(redactSecrets(said)).toBe(said);
  });

  test("scrubs every string an entry carries, whichever field it is in", () => {
    const entry = redactFields({
      type: "delegation",
      mode: "delegate",
      label: "the key rotation",
      task: "rotate sk-proj-abc123DEF456ghi789JKL012mno345 everywhere",
      session: "demo-t9",
      status: "launched",
    });
    expect(JSON.stringify(entry)).not.toContain("sk-proj-");
  });
});

describe("redaction is enforced by the adapters, not the caller", () => {
  test("nothing key-shaped reaches the written record", async () => {
    const log = await openCallLog({
      workspace: "leaky",
      scope: "workspace leaky",
      model: "gpt-realtime",
      voice: "marin",
    });
    log.port.record({
      type: "said",
      who: "servant",
      text: "the .env says OPENAI_API_KEY=sk-proj-abc123DEF456ghi789JKL012mno345",
    });
    log.port.record({
      type: "tool",
      name: "read_file",
      target: ".env",
      outcome: "error",
      detail: "ghp_abcdefghijklmnopqrstuvwxyz0123456789 is invalid",
      durationMs: 3,
      number: 1,
      args: '{"path":".env"}',
      result: '{"error":"AKIAIOSFODNN7EXAMPLE is invalid"}',
    });
    await log.close();

    const written = await readFile(log.path, "utf8");
    expect(written).not.toContain("sk-proj-");
    expect(written).not.toContain("ghp_");
    expect(written).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(written).toContain("[redacted]");
    // The surrounding sentence survives — redaction blanks the secret, not the record.
    expect(written).toContain("the .env says OPENAI_API_KEY=");
  });

  test("not even the header, which the record writes before any entry exists", async () => {
    const log = await openCallLog({
      workspace: "headers",
      scope: "repo deploy-AKIAIOSFODNN7EXAMPLE",
      model: "gpt-realtime",
      voice: "marin",
    });
    await log.close();

    const written = await readFile(log.path, "utf8");
    expect(written).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(written).toContain("[redacted]");
  });

  test("nothing key-shaped reaches the terminal either", () => {
    const lines: string[] = [];
    createLiveCallLogView({ write: (line) => lines.push(line) }).record({
      type: "said",
      who: "user",
      text: "my token is ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    });
    expect(lines.join("\n")).not.toContain("ghp_");
    expect(lines.join("\n")).toContain("[redacted]");
  });
});
