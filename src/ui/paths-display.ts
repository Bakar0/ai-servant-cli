/** Rendering a filesystem path for a person to read in a terminal. Display only — never a path a
 * caller then opens: `collapseHome`'s output is not resolvable. */

/** `/Users/x/.claude` → `~/.claude`, so a home-relative path reads at a glance. */
export function collapseHome(path: string): string {
  const home = process.env.HOME;
  if (home && path === home) return "~";
  return home && path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}
