import { defineCommand } from "citty";
import { repoAddCommand } from "./add.ts";
import { repoListCommand } from "./list.ts";
import { repoRmCommand } from "./rm.ts";

export const repoCommand = defineCommand({
  meta: {
    name: "repo",
    description:
      "Manage git worktrees of local clones under workspaces/<ws>/repos/<repo>/<branch>/.",
  },
  subCommands: {
    add: repoAddCommand,
    list: repoListCommand,
    rm: repoRmCommand,
  },
});
