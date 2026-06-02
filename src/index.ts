#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { spawnCommand } from "./commands/spawn.ts";

const main = defineCommand({
  meta: {
    name: "servant",
    version: "0.0.1",
    description: "AI servant CLI — enhances developer and coding-agent workflows.",
  },
  subCommands: {
    spawn: spawnCommand,
  },
});

runMain(main);
