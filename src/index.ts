#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { callLogCommand } from "./commands/call-log.ts";
import { claimCommand } from "./commands/claim.ts";
import { extractMemoriesCommand } from "./commands/extract-memories.ts";
import { fineTuneCommand } from "./commands/fine-tune.ts";
import { importHubCommand } from "./commands/import-hub.ts";
import { initCommand } from "./commands/init.ts";
import { insightsJudgeCommand } from "./commands/insights-judge.ts";
import { insightsCommand } from "./commands/insights.ts";
import { memoriesCommand } from "./commands/memories.ts";
import { recallCommand } from "./commands/recall.ts";
import { repoCommand } from "./commands/repo/index.ts";
import { resumeCommand } from "./commands/resume.ts";
import { sessionsCommand } from "./commands/sessions.ts";
import { spawnCommand } from "./commands/spawn.ts";
import { statuslineCommand } from "./commands/statusline.ts";
import { summonCommand } from "./commands/summon.ts";
import { tasksCommand } from "./commands/tasks.ts";
import { ticketCommand } from "./commands/ticket.ts";
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
    summon: summonCommand,
    "call-log": callLogCommand,
    repo: repoCommand,
    resume: resumeCommand,
    sessions: sessionsCommand,
    recall: recallCommand,
    memories: memoriesCommand,
    tasks: tasksCommand,
    ticket: ticketCommand,
    claim: claimCommand,
    "import-hub": importHubCommand,
    insights: insightsCommand,
    "insights-judge": insightsJudgeCommand,
    "extract-memories": extractMemoriesCommand,
    "fine-tune": fineTuneCommand,
    statusline: statuslineCommand,
  },
});

void runMain(main);
