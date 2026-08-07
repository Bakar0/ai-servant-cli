#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { dashboardCommand } from "./commands/dashboard.ts";
import { extractMemoriesCommand } from "./commands/extract-memories.ts";
import { fineTuneCommand } from "./commands/fine-tune.ts";
import { initCommand } from "./commands/init.ts";
import { insightsJudgeCommand } from "./commands/insights-judge.ts";
import { insightsCommand } from "./commands/insights.ts";
import { memoriesCommand } from "./commands/memories.ts";
import { recallCommand } from "./commands/recall.ts";
import { repoCommand } from "./commands/repo/index.ts";
import { resumeCommand } from "./commands/resume.ts";
import { spawnCommand } from "./commands/spawn.ts";
import { statuslineCommand } from "./commands/statusline.ts";
import { tasksCommand } from "./commands/tasks.ts";
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
    dashboard: dashboardCommand,
    recall: recallCommand,
    memories: memoriesCommand,
    tasks: tasksCommand,
    insights: insightsCommand,
    "insights-judge": insightsJudgeCommand,
    "extract-memories": extractMemoriesCommand,
    "fine-tune": fineTuneCommand,
    statusline: statuslineCommand,
  },
});

void runMain(main);
