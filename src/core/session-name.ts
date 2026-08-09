// The names servant's sessions run under. A name is an *address* — every session in one workspace
// shares a working directory, so an agent's own derived naming produces near-identical names that
// nothing can resolve back to a ticket or a conversation (workspace ADR 0010).

/**
 * Reduce a name fragment to the alphabet an address is made of. The workspace goes through here on
 * the way in (`ai_servant` → `ai-servant`), so a workspace containing anything but `[a-z0-9]` still
 * produces a name that resolves.
 */
export function sessionNameSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The Hands session's name. There is exactly one per workspace, so it is derived from the workspace
 * alone — anything that needs to reach it computes the name rather than searching for it.
 */
export function handsSessionName(workspace: string): string {
  return `${sessionNameSlug(workspace)}-hands`;
}
