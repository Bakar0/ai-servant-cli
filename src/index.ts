#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { extractMemoriesCommand } from "./commands/extract-memories.ts";
import { fineTuneCommand } from "./commands/fine-tune.ts";
import { initCommand } from "./commands/init.ts";
import { insightsCommand } from "./commands/insights.ts";
import { memoriesCommand } from "./commands/memories.ts";
import { recallCommand } from "./commands/recall.ts";
import { recordCommand } from "./commands/record.ts";
import { repoCommand } from "./commands/repo/index.ts";
import { resumeCommand } from "./commands/resume.ts";
import { spawnCommand } from "./commands/spawn.ts";
import { statuslineCommand } from "./commands/statusline.ts";
import { getVersion } from "./version.ts";

const main = defineCommand({
  meta: {
    name: "servant",
    version: getVersion(),
    description: "AI servant CLI — enhances developer and coding-agent workflows.",
  },
  subCommands: {
    init: initCommand,
    spawn: spawnCommand,
    repo: repoCommand,
    resume: resumeCommand,
    recall: recallCommand,
    record: recordCommand,
    memories: memoriesCommand,
    insights: insightsCommand,
    "extract-memories": extractMemoriesCommand,
    "fine-tune": fineTuneCommand,
    statusline: statuslineCommand,
  },
});

void runMain(main);
