#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { initCommand } from "./commands/init.ts";
import { repoCommand } from "./commands/repo/index.ts";
import { resumeCommand } from "./commands/resume.ts";
import { spawnCommand } from "./commands/spawn.ts";
import { statuslineCommand } from "./commands/statusline.ts";

const main = defineCommand({
  meta: {
    name: "servant",
    version: "0.0.1",
    description: "AI servant CLI — enhances developer and coding-agent workflows.",
  },
  subCommands: {
    init: initCommand,
    spawn: spawnCommand,
    repo: repoCommand,
    resume: resumeCommand,
    statusline: statuslineCommand,
  },
});

runMain(main);
