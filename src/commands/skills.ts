import { defineCommand } from "citty";
import {
  applyRootOverride,
  enabledSkillDir,
  servantSkillsDir,
  skillsStoreRoot,
} from "../core/paths.ts";
import {
  CORE_SOURCE,
  type CatalogEntry,
  type CheckCache,
  type CheckResult,
  type InstalledSkill,
  catalogSource,
  checkForUpdates,
  disableSkill,
  enableSkill,
  installFromSource,
  ensureCoreSkills,
  listInstalledSkills,
  listSkills,
  readCheckResults,
  readSkillDoc,
  skillName,
  reconcileEnabledCopies,
} from "../core/skills.ts";
import { type PickerOpts, pickMultipleFromList } from "../ui/picker.ts";

const rootArg = {
  type: "string",
  required: false,
  description: "Servant root directory (default: ~/.ai_servant). For throwaway/test setups.",
} as const;

/**
 * The verdict the session evaluator assigns each instruction unit is not written yet
 * (servant-skill-rework#3). The column exists now so the picker's shape does not change when it
 * arrives; until then every skill reads as unscored rather than as neutral.
 */
const SCORE_UNSCORED = "—";

const pad = (s: string, w: number) => s.padEnd(w);

export type SkillRow = {
  skill: InstalledSkill;
  label: string;
};

/** The picker `browseSkills` drives. Injectable so the browse surface is testable without fzf. */
export type SkillPicker = (
  rows: SkillRow[],
  opts: PickerOpts<SkillRow>,
) => Promise<SkillRow[] | null>;

/** `state | source | name | score | update?`, column-aligned, plus the matching header. */
function buildRows(
  skills: InstalledSkill[],
  checks: CheckCache,
): { rows: SkillRow[]; header: string } {
  const cells = skills.map((s) => ({
    skill: s,
    // `core` sits in the STATE column rather than beside the source, because the question that
    // column answers is "can I flip this?" — and for a core skill the answer is no.
    state: s.source === CORE_SOURCE ? "core" : s.enabled ? "on" : "off",
    source: s.source,
    name: s.contested ? `${s.name} (contested)` : s.name,
    score: SCORE_UNSCORED,
    update: updateCell(s, checks),
  }));
  const width = (key: "state" | "source" | "name" | "score", min: number) =>
    Math.max(min, ...cells.map((c) => c[key].length));
  const wState = width("state", 5);
  const wSource = width("source", 6);
  const wName = width("name", 4);
  const wScore = width("score", 5);
  const rows = cells.map((c) => ({
    skill: c.skill,
    label: `${pad(c.state, wState)}  ${pad(c.source, wSource)}  ${pad(c.name, wName)}  ${pad(c.score, wScore)}  ${c.update}`,
  }));
  const header = `${pad("STATE", wState)}  ${pad("SOURCE", wSource)}  ${pad("NAME", wName)}  ${pad("SCORE", wScore)}  UPDATE?`;
  return { rows, header };
}

/**
 * Read the last `check` observation — never the network, so listing stays instant and offline. Local
 * drift is read from disk though, because "we changed this" must never need a network call to see.
 */
function updateCell(skill: InstalledSkill, checks: CheckCache): string {
  const seen = checks[`${skill.source}/${skill.name}`];
  const upstream = !seen
    ? "unchecked"
    : seen.status === "unreachable"
      ? "unreachable"
      : seen.status === "outdated"
        ? `moved → ${seen.upstreamHash ?? "?"}`
        : "current";
  return skill.drift === "clean" ? upstream : `${skill.drift} · ${upstream}`;
}

function preview(skill: InstalledSkill, checks: CheckCache, doc: string): string {
  return [
    `${skill.name}  (${skill.enabled ? "enabled" : "disabled"})`,
    `source:  ${skill.source}`,
    `hash:    ${skill.hash}${skill.drift === "clean" ? "" : `  (as installed; local ${skill.localHash ?? "gone"})`}`,
    skill.source === CORE_SOURCE ? "" : `ref:     ${skill.ref || "(unknown)"}`,
    `score:   ${SCORE_UNSCORED}`,
    `update:  ${updateCell(skill, checks)}`,
    skill.source === CORE_SOURCE
      ? "store:   ships inside the servant binary — always on, never removable"
      : `store:   ${skill.storeDir}`,
    skill.enabled ? `loaded:  ${enabledSkillDir(skill.name)}` : "",
    "",
    doc,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

async function loadRows(): Promise<{
  skills: InstalledSkill[];
  checks: CheckCache;
  rows: SkillRow[];
  header: string;
}> {
  const skills = await listSkills();
  const checks = await readCheckResults();
  return { skills, checks, ...buildRows(skills, checks) };
}

/**
 * Make the enabled set true before reporting or changing it (ADR-0002). Runs on every such command
 * rather than as a one-shot migration, because a servant binary predating the move can recreate the
 * old copies at any time, and a skill loading from two places — or from none — has no symptom.
 */
async function reconcile(): Promise<void> {
  await ensureCoreSkills();
  const { removedLegacy, restored } = await reconcileEnabledCopies();
  // Status, not data: stdout stays pure so `list --json` is parseable even when a repair happened.
  if (removedLegacy.length > 0) {
    console.error(`servant: servant's skills now live in ${servantSkillsDir()}`);
    for (const name of removedLegacy) {
      console.error(`  removed the old copy: ~/.claude/skills/${name}`);
    }
  }
  for (const name of restored) console.error(`  restored the enabled copy: ${name}`);
}

function reportEmptyStore(): void {
  console.log(`servant: nothing installed — the store at ${skillsStoreRoot()} is empty.`);
  console.log("  Install one with `servant skills install <source>` (e.g. owner/repo).");
}

const listCommand = defineCommand({
  meta: { name: "list", description: "List installed skills, their state, hash and last check." },
  args: {
    json: { type: "boolean", default: false, description: "Machine-readable output." },
    root: rootArg,
  },
  async run({ args }) {
    applyRootOverride(args.root);
    await reconcile();
    const { skills, checks, rows, header } = await loadRows();
    if (args.json) {
      console.log(
        JSON.stringify(
          skills.map((s) => ({
            name: s.name,
            source: s.source,
            ref: s.ref,
            path: s.path,
            hash: s.hash,
            enabled: s.enabled,
            contested: s.contested,
            drift: s.drift,
            localHash: s.localHash,
            storeDir: s.storeDir,
            lastCheck: checks[`${s.source}/${s.name}`] ?? null,
          })),
          null,
          2,
        ),
      );
      return;
    }
    console.log(header);
    for (const r of rows) console.log(r.label);
    if (skills.every((s) => s.source === CORE_SOURCE)) {
      console.log("");
      reportEmptyStore();
    }
  },
});

const installCommand = defineCommand({
  meta: {
    name: "install",
    description:
      "Install skills from a git source (owner/repo, URL or path) into the store. Picks interactively unless --skill or --all is given.",
  },
  args: {
    source: {
      type: "positional",
      required: true,
      description: "Git source holding skills: owner/repo, a URL, or a local path.",
    },
    skill: {
      type: "string",
      required: false,
      description: "Skill name(s) to install, comma-separated. Repeatable.",
    },
    all: { type: "boolean", default: false, description: "Install every skill the source has." },
    enable: { type: "boolean", default: false, description: "Enable each installed skill." },
    force: {
      type: "boolean",
      default: false,
      description: "Overwrite a store copy that has local changes, discarding them.",
    },
    root: rootArg,
  },
  async run({ args }) {
    applyRootOverride(args.root);
    const wanted = [args.skill]
      .flat()
      .filter((s): s is string => typeof s === "string")
      .flatMap((s) => s.split(","))
      .map((s) => s.trim())
      .filter(Boolean);

    const source = String(args.source);
    const select = async (candidates: string[]): Promise<string[] | null> => {
      if (args.all) return candidates;
      if (wanted.length > 0) {
        const byName = new Map(candidates.map((p) => [skillName({ source, path: p }), p]));
        // Unmapped names are passed through so the store reports them against the real candidate
        // list, rather than this layer inventing a second "not found" message.
        return wanted.map((n) => byName.get(n) ?? n);
      }
      return pickMultipleFromList(candidates, {
        format: (p) => `${skillName({ source, path: p })}${p === "." ? "" : `  (${p})`}`,
        prompt: "install",
        header: `skills in ${source} — tab to toggle, enter to install`,
      });
    };
    const result = await installFromSource(source, select, { force: args.force });

    if (!result) {
      console.log("servant: nothing selected — no skills installed.");
      return;
    }
    console.log(`servant: ${result.source.raw} @ ${result.ref.slice(0, 12)}`);
    for (const s of result.installed) {
      const moved = s.previousHash && s.previousHash !== s.hash ? ` (was ${s.previousHash})` : "";
      const refreshed = s.refreshedEnabled ? " · enabled copy refreshed" : "";
      console.log(`  installed ${s.name}  ${s.hash}${moved}${refreshed}`);
    }
    if (!args.enable) return;
    for (const s of result.installed) {
      const { swappedOut } = await enableSkill(`${result.source.raw}/${s.name}`);
      const swap = swappedOut ? ` (replacing ${swappedOut.source}'s)` : "";
      console.log(`  enabled   ${s.name}${swap}`);
    }
  },
});

function catalogTable(skills: CatalogEntry[]): string[] {
  const wName = Math.max(4, ...skills.map((s) => s.name.length));
  return skills.map((s) => {
    const needs = s.mentions.length > 0 ? `  [mentions: ${s.mentions.join(", ")}]` : "";
    return `${pad(s.name, wName)}  ${truncate(s.description, 96)}${needs}`;
  });
}

const truncate = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s;

const catalogCommand = defineCommand({
  meta: {
    name: "catalog",
    description:
      "Read what a source offers — name, stated purpose, and which sibling skills each one mentions — without installing anything.",
  },
  args: {
    source: {
      type: "positional",
      required: true,
      description: "Git source holding skills: owner/repo, a URL, or a local path.",
    },
    json: { type: "boolean", default: false, description: "Machine-readable output." },
    root: rootArg,
  },
  async run({ args }) {
    applyRootOverride(args.root);
    const catalog = await catalogSource(String(args.source));
    if (args.json) {
      console.log(JSON.stringify(catalog.skills, null, 2));
      return;
    }
    console.log(
      `${catalog.source.raw} @ ${catalog.ref.slice(0, 12)} — ${catalog.skills.length} skill(s)`,
    );
    for (const line of catalogTable(catalog.skills)) console.log(`  ${line}`);
    console.log(`\nInstall with: servant skills install ${catalog.source.raw} --skill <name>`);
  },
});

const enableCommand = defineCommand({
  meta: {
    name: "enable",
    description: "Copy an installed skill into Claude's skills directory so it is loaded.",
  },
  args: {
    skill: {
      type: "positional",
      required: true,
      description: "Skill name, or <source>/<name> when two sources ship it.",
    },
    root: rootArg,
  },
  async run({ args }) {
    applyRootOverride(args.root);
    await reconcile();
    const { skill, swappedOut } = await enableSkill(String(args.skill));
    console.log(
      `servant: enabled ${skill.name} (${skill.source}) → ${enabledSkillDir(skill.name)}`,
    );
    if (swappedOut) {
      console.log(`  disabled ${swappedOut.name} from ${swappedOut.source} — one name, one skill.`);
    }
  },
});

const disableCommand = defineCommand({
  meta: {
    name: "disable",
    description: "Delete a skill's copy from Claude's skills directory, keeping the store entry.",
  },
  args: {
    skill: {
      type: "positional",
      required: true,
      description: "Skill name, or <source>/<name> when two sources ship it.",
    },
    root: rootArg,
  },
  async run({ args }) {
    applyRootOverride(args.root);
    await reconcile();
    const skill = await disableSkill(String(args.skill));
    console.log(
      `servant: disabled ${skill.name} (${skill.source}) — still installed at ${skill.storeDir}`,
    );
  },
});

function printCheck(results: CheckResult[]): void {
  const outdated = results.filter((r) => r.status === "outdated");
  const unreachable = results.filter((r) => r.status === "unreachable");
  const drifted = results.filter((r) => r.drift !== "clean");
  console.log(
    `servant: checked ${results.length} skill(s) — ${outdated.length} outdated, ${drifted.length} locally changed, ${unreachable.length} unreachable`,
  );
  for (const r of results) {
    if (r.status === "current" && r.drift === "clean") continue;
    const upstream =
      r.status === "outdated"
        ? `upstream ${r.upstreamHash}`
        : r.status === "unreachable"
          ? "source unreachable"
          : "upstream unchanged";
    const local = r.drift === "clean" ? "" : `${r.drift} locally · `;
    console.log(`  ${r.name}  (${r.source})  ${local}${upstream}`);
  }
  if (outdated.length > 0) {
    console.log("\nReaching a new version is an explicit reinstall (ADR-0001):");
    for (const r of outdated) {
      const force = r.drift === "modified" ? " --force  # discards the local changes" : "";
      console.log(`  servant skills install ${r.source} --skill ${r.name}${force}`);
    }
  }
}

const checkCommand = defineCommand({
  meta: {
    name: "check",
    description:
      "Ask each source whether it moved, and re-hash only the skills whose source did. Detects, never applies.",
  },
  args: {
    json: { type: "boolean", default: false, description: "Machine-readable output." },
    root: rootArg,
  },
  async run({ args }) {
    applyRootOverride(args.root);
    if ((await listInstalledSkills()).length === 0) {
      reportEmptyStore();
      return;
    }
    const results = await checkForUpdates();
    if (args.json) console.log(JSON.stringify(results, null, 2));
    else printCheck(results);
  },
});

const SUBCOMMANDS = {
  list: listCommand,
  catalog: catalogCommand,
  install: installCommand,
  enable: enableCommand,
  disable: disableCommand,
  check: checkCommand,
};

const BROWSE_HINT = "tab marks · enter flips the marked rows (or the current one) · esc closes";

/**
 * Flip the enablement of each marked skill, then reopen with the new state — deciding what to enable
 * is comparing skills against each other, and being ejected after one flip makes that comparison
 * impossible. Escape is the way out, so leaving is a deliberate keystroke rather than the default.
 *
 * The reopened list is the confirmation, which is why nothing is printed per flip: a `console.log`
 * between two full-screen redraws is a line nobody reads. The trail prints once, on the way out.
 */
export async function browseSkills(pick: SkillPicker = pickMultipleFromList): Promise<void> {
  await reconcile();
  const trail: string[] = [];
  for (;;) {
    const { skills, checks, rows, header } = await loadRows();
    const docs = new Map<string, string>();
    await Promise.all(
      skills.map(async (s) => docs.set(s.storeDir, await readSkillDoc(s.storeDir))),
    );

    const picked = await pick(rows, {
      format: (r) => r.label,
      preview: (r) => preview(r.skill, checks, docs.get(r.skill.storeDir) ?? ""),
      prompt: "skill",
      header: `${BROWSE_HINT}\n${header}`,
    });
    if (!picked || picked.length === 0) break;

    for (const { skill } of picked) {
      if (skill.source === CORE_SOURCE) {
        trail.push(`  --   ${skill.name}  (core)  ships with servant — always on`);
        continue;
      }
      const selector = skill.contested ? `${skill.source}/${skill.name}` : skill.name;
      if (skill.enabled) {
        await disableSkill(selector);
        trail.push(`  off  ${skill.name}  (${skill.source})`);
      } else {
        const { swappedOut } = await enableSkill(selector);
        const swap = swappedOut ? `  (replacing ${swappedOut.source}'s)` : "";
        trail.push(`  on   ${skill.name}  (${skill.source})${swap}`);
      }
    }
  }

  if (trail.length === 0) return;
  console.log("servant: skills changed —");
  for (const line of trail) console.log(line);
}

export const skillsCommand = defineCommand({
  meta: {
    name: "skills",
    description:
      "Manage the skill store: install from a source, enable/disable globally, and check whether upstream moved. Bare `servant skills` browses them.",
  },
  // No `--root` here, unlike every subcommand: citty reads the first non-flag argument as the
  // subcommand name, so a flag *value* before the verb would be taken for one. The browser is
  // interactive and only ever runs against the real root anyway.
  subCommands: SUBCOMMANDS,
  async run({ rawArgs }) {
    // citty runs a parent's `run` *in addition to* the subcommand it dispatched, so the browser has
    // to stand down when one was named.
    const verb = rawArgs.find((a) => !a.startsWith("-"));
    if (verb && verb in SUBCOMMANDS) return;

    if (!process.stdin.isTTY) {
      console.log(
        "servant: `servant skills` browses interactively — use `servant skills list` here.",
      );
      return;
    }
    await browseSkills();
  },
});
