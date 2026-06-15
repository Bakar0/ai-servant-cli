import { join } from "node:path";
import { workspacePath } from "./paths.ts";

export const WORKTREE_DIVIDER = "__";
const SHORT_ID_LENGTH = 4;
const SHORT_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const MAX_ID_ATTEMPTS = 32;

export function reposRoot(workspace: string): string {
  return join(workspacePath(workspace), "repos");
}

export function worktreeDirName(repoSubdir: string, branch: string): string {
  return `${repoSubdir}${WORKTREE_DIVIDER}${branch}`;
}

export function worktreePath(workspace: string, repoSubdir: string, branch: string): string {
  return join(reposRoot(workspace), worktreeDirName(repoSubdir, branch));
}

export type ParsedWorktreeDir = { repoSubdir: string; branch: string };

export function parseWorktreeDirName(dirName: string): ParsedWorktreeDir | null {
  const idx = dirName.indexOf(WORKTREE_DIVIDER);
  if (idx <= 0 || idx >= dirName.length - WORKTREE_DIVIDER.length) return null;
  return {
    repoSubdir: dirName.slice(0, idx),
    branch: dirName.slice(idx + WORKTREE_DIVIDER.length),
  };
}

export function validateRepoSubdir(subdir: string): void {
  if (subdir.includes(WORKTREE_DIVIDER)) {
    throw new Error(
      `Repo subdir "${subdir}" contains "${WORKTREE_DIVIDER}" which is reserved as the worktree divider. Pass --as <alias> to override.`,
    );
  }
  if (subdir.includes("/")) {
    throw new Error(`Repo subdir "${subdir}" must not contain "/".`);
  }
}

export function validateBranchForDir(branch: string): void {
  if (branch.includes(WORKTREE_DIVIDER)) {
    throw new Error(
      `Branch "${branch}" contains "${WORKTREE_DIVIDER}" which is reserved as the worktree divider.`,
    );
  }
  if (branch.includes("/")) {
    throw new Error(
      `Branch "${branch}" must not contain "/" — worktree dirs are flat under repos/.`,
    );
  }
}

function randomShortId(): string {
  let out = "";
  for (let i = 0; i < SHORT_ID_LENGTH; i++) {
    const c = SHORT_ID_ALPHABET[Math.floor(Math.random() * SHORT_ID_ALPHABET.length)];
    out += c;
  }
  return out;
}

export function generateBranchName(workspace: string, taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
    const candidate = `${workspace}-${randomShortId()}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`Could not generate a unique worktree branch after ${MAX_ID_ATTEMPTS} attempts.`);
}
