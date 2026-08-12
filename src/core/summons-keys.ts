// Keyboard controls for a live Summons — the only place servant reads the terminal during one.
//
// Nothing about *talking* is gated on a key, and that stays true (workspace ADR 0009): the mic is
// open, the model's own voice detection ends each turn, and no key is held to speak. These are
// controls over the session rather than over the conversation, and they only reach a terminal that
// has focus, so the keyboard stays free for whatever else the user is doing.

export type SummonsKey = "toggle-mute" | "hang-up" | null;

/**
 * What a keystroke means. Raw mode is what makes single keypresses readable at all, and it stops the
 * terminal turning Ctrl-C into SIGINT and Ctrl-D into EOF on our behalf — so both are interpreted
 * here, or the documented way to hang up would simply stop working.
 */
export function keyAction(key: string): SummonsKey {
  if (key === "\u0003" || key === "\u0004") return "hang-up";
  if (key.toLowerCase() === "m") return "toggle-mute";
  return null;
}

/** Just enough of `process.stdin` to read single keys, so this is testable without a terminal. */
export interface KeyInput {
  isTTY?: boolean | undefined;
  setRawMode?: ((mode: boolean) => void) | undefined;
  setEncoding(encoding: "utf8"): void;
  resume(): void;
  pause(): void;
  on(event: "data", listener: (chunk: string) => void): void;
  off(event: "data", listener: (chunk: string) => void): void;
}

export interface KeyControlsDeps {
  input: KeyInput;
  /** Returns the state the mic is now in, which is what gets reported back to the user. */
  toggleMute(): boolean;
  hangUp(): void;
  report(message: string): void;
}

/**
 * Wire the keys up, and return the function that puts the terminal back. Raw mode is a change to
 * the user's shell, so it must be undone however the session ends — a Summons that leaves the
 * terminal in raw mode leaves it unusable.
 *
 * A stdin that is not a terminal gets nothing at all: with output piped or redirected there is no
 * one at a keyboard, and putting a pipe into raw mode is an error rather than a no-op.
 */
export function attachKeyControls(deps: KeyControlsDeps): () => void {
  if (!deps.input.isTTY || !deps.input.setRawMode) return () => {};

  const onData = (chunk: string) => {
    switch (keyAction(chunk)) {
      case "toggle-mute":
        deps.report(
          deps.toggleMute()
            ? "muted — press m to unmute. The idle window keeps running."
            : "unmuted — listening again.",
        );
        return;
      case "hang-up":
        deps.hangUp();
        return;
      default:
        return;
    }
  };

  deps.input.setRawMode(true);
  deps.input.setEncoding("utf8");
  deps.input.resume();
  deps.input.on("data", onData);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    deps.input.off("data", onData);
    deps.input.setRawMode?.(false);
    deps.input.pause();
  };
}
