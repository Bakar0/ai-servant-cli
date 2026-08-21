// Steering a running session: the text that goes out, and how the answer that comes back is read.
//
// Pure, and separate from the controller for the reason the confirm-gate is: what counts as "the
// instruction landed" is the single most misreadable fact in this feature, so it is one function
// with its own tests rather than a condition buried in a tool handler (workspace ADR 0010).

/**
 * What the Hands session reported about one delivery.
 *
 * `unconfirmed` is the honest middle the whole feature turns on. A `SendMessage` proves an
 * instruction was *queued*, never that it was applied — and a Hands session answering in prose has
 * not even proven that much, because it is a model and could have said "sent it" without sending.
 * So anything the marker does not explicitly confirm is unconfirmed, and the agent says so out
 * loud rather than assuming (ticket acceptance criterion 3).
 */
export type SteerAck =
  | { outcome: "delivered" }
  | { outcome: "failed"; reason: string }
  | { outcome: "unconfirmed" };

/** The one line the Hands session is asked to end on, quoted into the request it is sent. */
export const STEER_ACK_MARKER = "SERVANT-STEER:";

/**
 * The instruction as the receiving session reads it. Two things travel with every one: the user's
 * words verbatim — a paraphrase is a different instruction — and the rule that it is taken up at
 * the next safe point, which is what keeps a session from abandoning a half-written file to obey
 * (ticket acceptance criterion 8).
 */
export function composeSteerMessage(spec: {
  instruction: string;
  stop?: boolean;
  /** A question rather than an instruction: the user wants an answer, not a change of course. */
  question?: boolean;
}): string {
  const parts = [
    spec.question
      ? "A question from the user, spoken out loud during a Summons of this workspace and relayed to you. They are away from the keyboard and cannot read your screen, so answering is the whole job here."
      : "Steer from the user, spoken out loud during a Summons of this workspace and relayed to you. They are away from the keyboard, so there is nobody to ask about it.",
    spec.instruction.trim(),
  ];
  if (spec.question) {
    // Read from the transcript, not returned through the relay — so the answer has to be *said*,
    // and said in the reply rather than only acted on. A session that silently complies answers
    // nothing, and there is nowhere else to look.
    parts.push(
      "Answer it in your next message, in a few sentences: what you have done, where you are, and anything you are stuck on. Say the answer out loud in your reply rather than only acting on it — it is read back from your transcript, so an answer you do not write down does not exist. Do not change what you are doing because of this; it is a question, not an instruction.",
    );
    return parts.join("\n\n");
  }
  if (spec.stop) {
    parts.push(
      "This stops or abandons your work, and the user confirmed it out loud before it was sent. Wind up at your next safe point: leave the tree in a state someone can pick up, say what you had done and what you stopped short of, and do not start anything new.",
    );
  } else {
    parts.push(
      "Take this up at your next safe point — finish the edit or the command you are part-way through first, then act on it. Never leave a file half-written to act on this.",
    );
  }
  return parts.join("\n\n");
}

/**
 * What the Hands session is asked to do with it. The Summons agent is not a Claude session and has
 * no way to message one, so the delivery is a job handed to its hands (ADR 0010 decision 6) — and
 * the reply is read by machine, not by the agent, which is why it has to end on a marker.
 */
export function composeSteerRequest(spec: { target: string; message: string }): string {
  return [
    "Relay an instruction to another Claude session. You are the relay: do not do the work yourself, and do not act on the instruction — it is not addressed to you.",
    `Send the message below, exactly as written, to the session named \`${spec.target}\` using your cross-session messaging tool.`,
    `--- message ---\n${spec.message}\n--- end of message ---`,
    // Waiting would spend the Summons' whole deadline on a session that is *meant* to apply this
    // later, and would come back reporting "applied" where only "delivered" is known.
    "Do not wait for that session to reply, and do not check whether it acted on this. It takes instructions up at its next safe point, which is deliberately later.",
    `End your reply with exactly one of these lines, on a line of its own:\n\n${STEER_ACK_MARKER} delivered\n${STEER_ACK_MARKER} failed — <one short reason>`,
    "`delivered` means your send tool returned successfully — nothing more. If it errored, if there is no session at that name, or if you could not send for any other reason, report failed and say why in a few words. Never report delivered for a send you did not make.",
  ].join("\n\n");
}

/**
 * Does this instruction stop or abandon the session, whatever tool it arrived through?
 *
 * The Guarded case is a separate tool, but a model can always phrase "stop what you're doing" as a
 * redirect and route around the gate — so the words are checked too. It leans towards saying yes:
 * a false positive costs one spoken confirmation, and a false negative destroys work nothing
 * downstream will catch (ADR 0010 decision 8).
 */
/**
 * What a stop verb has to be aimed at for it to mean the *session*. "cancel it" stops the work;
 * "cancel the pending timeout in the retry loop" is a change to the code and must go through
 * un-Guarded. Longest alternatives first, so "that session" is tried before the bare "that".
 */
const SESSION_OBJECT =
  "(?:everything|(?:the|that|this)\\s+(?:whole thing|work|session|task|job|run)|it|that|this)";

/**
 * ...and the object has to be the end of the thought. Without this, "drop that approach and use a
 * map instead" matches on "drop that" and a routine redirect is held at the gate for no reason.
 */
const THOUGHT_END = "(?=$|[^\\w\\s]|\\s+(?:and|then|now|please|immediately)\\b)";

const STOP_SHAPES: readonly RegExp[] = [
  /\babandon\b/i,
  /\bgive up\b/i,
  /\bstand down\b/i,
  /\bbail out\b/i,
  /\bforget (?:it|this|the whole)\b/i,
  /\bnever mind\b/i,
  /\b(?:scrap|bin) (?:it|that|this|the whole)\b/i,
  /\bthrow (?:it|that) away\b/i,
  /\bshut (?:it|that|this|everything) down\b/i,
  /\b(?:wrap|wind) (?:it|that|this) (?:up|down)\b/i,
  /\bcall (?:it|that|this) off\b/i,
  // "stop" alone stops; "stop <gerund>" names something to stop doing and carries on working.
  // "doing", "working" and "everything" are the exceptions — they are what a session is stopped
  // *from*, and "everything" only looks like a gerund. Missing that one let "stop everything"
  // through as a routine redirect, which is the expensive direction to be wrong in.
  /\bstop\b(?!\s+(?!doing\b|working\b|everything\b)\w+ing\b)/i,
  // The verb aimed at the session — "abort the run", "kill that session", "drop it".
  new RegExp(
    `\\b(?:abort|cancel|halt|terminate|kill|drop)\\s+${SESSION_OBJECT}${THOUGHT_END}`,
    "i",
  ),
  // The verb with nothing after it at all, which can only mean the session.
  /^\s*(?:abort|cancel|halt|terminate|stop)\s*[.!]?\s*$/i,
];

export function looksLikeStopInstruction(text: string): boolean {
  return STOP_SHAPES.some((shape) => shape.test(text));
}

/**
 * Tolerant about the dash and the spacing, strict about the verdict word: the reply is written by
 * a model, and rejecting a delivery over an em-dash would report a failure that did not happen.
 *
 * Built from `STEER_ACK_MARKER` rather than repeating it, because the two drifting apart would make
 * every reply parse as unconfirmed — a silent failure with nothing to catch it.
 */
const ACK_LINE = new RegExp(
  `^[ \\t>*-]*${STEER_ACK_MARKER}[ \\t]*(delivered|failed)\\b[ \\t]*[—:-]?[ \\t]*(.*)$`,
  "gim",
);

/**
 * Read the verdict off the Hands session's reply. The *last* marker wins: the request quotes both
 * markers verbatim, so a reply that restates its instructions before answering carries more than
 * one, and the one it finished on is the answer.
 */
export function parseSteerAck(reply: string): SteerAck {
  // `matchAll` clones the regex internally, so the module-level `lastIndex` is never load-bearing
  // — which matters for a pattern whose result decides whether an instruction is reported as sent.
  const last = [...reply.matchAll(ACK_LINE)].at(-1);
  if (!last) return { outcome: "unconfirmed" };
  if (last[1]?.toLowerCase() === "delivered") return { outcome: "delivered" };
  return { outcome: "failed", reason: (last[2] ?? "").trim() };
}
