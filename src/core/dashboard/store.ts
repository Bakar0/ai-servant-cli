import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workspaceDashboardPath, workspaceDashboardsDir } from "../paths.ts";

// The dashboards dir is a self-contained git-ignored artifact area: a `.gitignore` of `*` keeps the
// whole directory (including itself) out of the insights store's git tree, so regenerated HTML never
// shows up as a change. Owned here so the insights store's own lifecycle stays untouched.

/** Write the rendered dashboard for a workspace (git-ignored artifact); returns its path. */
export async function writeWorkspaceDashboard(workspace: string, html: string): Promise<string> {
  const dir = workspaceDashboardsDir();
  await mkdir(dir, { recursive: true });
  const ignorePath = join(dir, ".gitignore");
  if (!existsSync(ignorePath)) await writeFile(ignorePath, "*\n");
  const path = workspaceDashboardPath(workspace);
  await writeFile(path, html);
  return path;
}
