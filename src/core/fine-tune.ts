import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fineTuneAspectPath } from "./paths.ts";

// "Fine-tuning" lets a user customize servant's instruction assets without losing those
// customizations when the CLI updates the bundled assets. Each tunable *aspect* has a
// user-owned overlay file at `~/.ai_servant/fine-tune/<id>.md`. The overlay is appended
// (additively) after the CLI-shipped base of every asset the aspect feeds, so:
//   - CLI updates to the base always flow through (the base is never forked), and
//   - the overlay survives untouched and takes precedence by natural language.
// Composition happens in `ensureServantAssets()` for markdown assets and at runtime in
// `buildExtractionPrompt()` for the headless extraction prompt.

export interface FineTuneAspect {
  readonly id: string;
  readonly title: string;
  readonly blurb: string;
  /** Delivered markdown assets (paths relative to the servant root) this overlay appends to. */
  readonly assets: readonly string[];
  /** Whether this overlay also feeds the headless extraction prompt (buildExtractionPrompt). */
  readonly feedsExtractionPrompt?: boolean;
}

export const FINE_TUNE_ASPECTS: readonly FineTuneAspect[] = [
  {
    id: "general",
    title: "General instructions",
    blurb: "Workspace conventions every agent here loads (root CLAUDE.md).",
    assets: ["CLAUDE.md"],
  },
  {
    id: "memory-extraction",
    title: "Memory extraction",
    blurb: "How sessions distill durable knowledge into the knowledge base.",
    assets: [".claude/commands/servant/extract-memories.md"],
    feedsExtractionPrompt: true,
  },
  {
    id: "delegate",
    title: "Delegation",
    blurb: "How work is handed off to a fresh servant as an Agent Brief.",
    assets: [".claude/commands/servant/delegate.md"],
  },
  {
    id: "goal",
    title: "Goal interview",
    blurb: "How a workspace's GOAL.md is defined and amended.",
    assets: [".claude/commands/servant/goal.md"],
  },
  {
    id: "recall",
    title: "Recall",
    blurb: "How prior servants' knowledge is searched and surfaced.",
    assets: [".claude/commands/servant/recall.md"],
  },
];

export function getAspect(id: string): FineTuneAspect | undefined {
  return FINE_TUNE_ASPECTS.find((a) => a.id === id);
}

const startMarker = (id: string): string => `<!-- servant:fine-tune:start id=${id} -->`;
const END_MARKER = "<!-- servant:fine-tune:end -->";

/** Initial overlay scaffold: a guidance comment; the user writes their customization below it. */
export function scaffoldFor(aspect: FineTuneAspect): string {
  return `<!--
servant fine-tune — \`${aspect.id}\` (${aspect.title})

Write your customizations BELOW this comment. They are appended after servant's built-in
${aspect.id} instructions and take precedence where they conflict — to override a default,
just say so (e.g. "Override the brief template below: use our RFC format.").

This comment is stripped before the text is composed into the live instructions.
Delete this file (or run \`servant fine-tune ${aspect.id} --reset\`) to revert.
-->

`;
}

/** Strip HTML comment blocks; what remains is the user's actual directive text. */
function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "").trim();
}

export async function readOverlayRaw(id: string): Promise<string | null> {
  try {
    return await readFile(fineTuneAspectPath(id), "utf8");
  } catch {
    return null;
  }
}

/** The user's directive text for an aspect (comments stripped), or null if none / empty. */
export async function readOverlayBody(id: string): Promise<string | null> {
  const raw = await readOverlayRaw(id);
  if (raw === null) return null;
  const body = stripComments(raw);
  return body.length > 0 ? body : null;
}

export async function isCustomized(id: string): Promise<boolean> {
  return (await readOverlayBody(id)) !== null;
}

/**
 * Append the overlay section to a delivered markdown asset's base, or return the base
 * unchanged when there is no overlay. Pure/deterministic so re-composition from the clean
 * base is always idempotent.
 */
export function composeAsset(aspectId: string, base: string, overlayBody: string | null): string {
  if (!overlayBody) return base;
  const trimmedBase = base.replace(/\s+$/, "");
  const section = [
    startMarker(aspectId),
    "## Local fine-tuning",
    "",
    "The following are user customizations. They take precedence over the instructions above where they conflict.",
    "",
    overlayBody,
    END_MARKER,
  ].join("\n");
  return `${trimmedBase}\n\n${section}\n`;
}

/** Compose a delivered asset identified by its servant-root-relative path. */
export async function composeAssetForRel(rel: string, base: string): Promise<string> {
  const aspect = FINE_TUNE_ASPECTS.find((a) => a.assets.includes(rel));
  if (!aspect) return base;
  const body = await readOverlayBody(aspect.id);
  return composeAsset(aspect.id, base, body);
}

/** Whether a servant-root-relative path is a fine-tune asset (so it needs composition). */
export function isFineTuneAsset(rel: string): boolean {
  return FINE_TUNE_ASPECTS.some((a) => a.assets.includes(rel));
}

/** Create the overlay file with its guidance scaffold if it doesn't exist yet. Returns its path. */
export async function ensureScaffold(aspect: FineTuneAspect): Promise<string> {
  const path = fineTuneAspectPath(aspect.id);
  if ((await readOverlayRaw(aspect.id)) === null) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, scaffoldFor(aspect));
  }
  return path;
}

/** Write the user's customization for an aspect (re-stamping the guidance scaffold on top). */
export async function writeOverlay(aspect: FineTuneAspect, body: string): Promise<string> {
  const path = fineTuneAspectPath(aspect.id);
  await mkdir(dirname(path), { recursive: true });
  const trimmed = body.trim();
  const content = trimmed.length > 0 ? `${scaffoldFor(aspect)}${trimmed}\n` : scaffoldFor(aspect);
  await writeFile(path, content);
  return path;
}

/** Delete an aspect's overlay (revert to pure base). Returns true if a file was removed. */
export async function resetOverlay(id: string): Promise<boolean> {
  try {
    await rm(fineTuneAspectPath(id));
    return true;
  } catch {
    return false;
  }
}
