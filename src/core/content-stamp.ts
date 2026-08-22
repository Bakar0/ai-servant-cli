import { createHash } from "node:crypto";

/**
 * 12 hex chars of sha256 — the same shape as the insights setup fingerprint.
 *
 * Shared by the generated agent docs (where it stamps one document's body) and the skill store
 * (where it hashes a whole directory's contents), so both speak the same digest length and a
 * stamp read in one place is comparable to a hash read in the other.
 */
export function contentStamp(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 12);
}
