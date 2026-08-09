// The Call log's vocabulary: what a Summons records, and the port it records through.
//
// The port is the seam (workspace ADR 0009). The controller in `summons.ts` emits entries and
// knows nothing about files, terminals or clocks; the adapters — the JSONL store and the live
// terminal view — sit outside it. Nothing reaches around this: if a Summons does something worth
// seeing, it becomes an entry here first.

/** A moment in a Summons, as the controller reports it. The `at` stamp is added by the adapter. */
export type CallLogEntry =
  /** An utterance, from either side. */
  | { type: "said"; who: "user" | "servant"; text: string }
  /**
   * A tool the Summons agent called. `target` is the one thing worth reading at a glance — the
   * path, the pattern, the label — so the live view has something to show without unpacking args.
   * `held` is `delegate` reaching the confirm-gate: proposed, and deliberately not run.
   */
  | {
      type: "tool";
      name: string;
      target: string;
      outcome: "ok" | "error" | "held";
      detail?: string;
      durationMs: number;
    }
  /** The confirm-gate's verdict on a held delegation, and the words it was read from. */
  | { type: "gate"; label: string; verdict: "confirmed" | "declined" | "unclear"; heard: string }
  /** Work handed to a Claude session — including which session, since that is its address. */
  | {
      type: "delegation";
      mode: "research" | "delegate";
      label: string;
      task: string;
      /** null while queued behind another task on the same repo, or when the launch failed. */
      session: string | null;
      status: "launched" | "queued" | "failed";
      detail?: string;
      ticket?: number;
      repo?: string;
    }
  /**
   * A round-trip to the Hands session. It runs headless and has no tab, so this is the only place
   * its work is visible — which is why the Call log had to exist before it could (ADR 0010).
   * Nothing emits this yet; majordomo#24 is what fills it in.
   */
  | {
      type: "hands";
      request: string;
      response: string | null;
      outcome: "ok" | "error";
      durationMs: number;
    }
  /** Anything the session reported that was not speech — an API error, most of all. */
  | { type: "note"; level: "info" | "error"; text: string }
  | { type: "ended"; reason: CallLogEndReason };

/** Why a Summons stopped. "closed" is the socket going away; "hung up" is the user or a failure. */
export type CallLogEndReason = "hung up" | "idle" | "closed";

/** What a Summons was. Written first, so a record identifies itself before anything happened in it. */
export interface CallLogHeader {
  id: string;
  workspace: string;
  /** What the conversation was scoped to — the workspace, or one mounted repo. */
  scope: string;
  model: string;
  voice: string;
}

export type CallLogRecord =
  | ({ type: "opened"; at: string } & CallLogHeader)
  | ({ at: string } & CallLogEntry);

/**
 * Where a Summons writes its Call log.
 *
 * `record` returns void on purpose. The Call log is a bystander to the conversation: a slow disk
 * or a full one must never stall a reply or a tool result, so adapters queue the write and swallow
 * their own failures rather than throwing back into the audio path.
 */
export interface CallLogPort {
  record(entry: CallLogEntry): void;
}

/** For a Summons running without a Call log — tests, mostly. Records nothing, never throws. */
export const NULL_CALL_LOG: CallLogPort = { record: () => {} };

/** So the live view and the durable record are fed the same entries, never two versions of one. */
export function teeCallLog(ports: readonly CallLogPort[]): CallLogPort {
  return {
    record(entry) {
      for (const port of ports) port.record(entry);
    },
  };
}

// --- Redaction ---------------------------------------------------------------------------------
//
// A Summons reads files out loud, and files contain secrets. The agent has no idea which is which,
// so the record cannot rely on it not saying one: anything key-shaped is scrubbed on the way in,
// in every adapter, before it can reach a disk or a scrollback buffer.

const REDACTED = "[redacted]";

/** Shapes that identify themselves — a vendor prefix or a structure nothing else has. */
const SECRET_SHAPES: readonly RegExp[] = [
  // PEM private keys, whole block. First, so its base64 body is gone before anything else sees it.
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  // OpenAI and friends: sk-…, sk-proj-…, sk-ant-api03-…
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // GitHub: ghp_, gho_, ghu_, ghs_, ghr_, and fine-grained github_pat_
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  // AWS access key ids, and Google API keys
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[A-Za-z0-9_-]{30,}/g,
  // JWTs — three base64url segments, which nothing but a token looks like
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Authorization headers
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
];

/**
 * The long unmarked strings that only their key name identifies — `API_KEY=…`, `"token": "…"`.
 * Kept separate because it is the one rule that preserves part of what it matched: the name and
 * separator stay, so `OPENAI_API_KEY=[redacted]` still reads as what it was.
 */
const NAMED_SECRET =
  /\b([A-Za-z0-9_-]*(?:api[_-]?key|secret|token|password|passwd|credential)s?)(\s*["']?\s*[:=]\s*["']?)([^\s"'`,;]{8,})/gi;

/** Blanks the secret, not the sentence around it — a redacted record still has to be readable. */
export function redactSecrets(text: string): string {
  let out = text.replace(
    NAMED_SECRET,
    (_match, name: string, sep: string) => `${name}${sep}${REDACTED}`,
  );
  for (const shape of SECRET_SHAPES) out = out.replace(shape, REDACTED);
  return out;
}

/**
 * Scrub every string a record-bound object carries — entries and the header alike, since a repo
 * path or a scope label is as capable of holding a token as anything the agent says. Applied by
 * each adapter rather than at the call sites, so no new call site can forget.
 */
export function redactFields<T extends object>(value: T): T {
  const out = { ...value } as Record<string, unknown>;
  for (const [key, field] of Object.entries(out)) {
    if (typeof field === "string") out[key] = redactSecrets(field);
  }
  return out as T;
}
