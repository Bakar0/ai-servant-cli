import { defineCommand } from "citty";
import { importHub, importedBoardSummary } from "../core/board/import-hub.ts";
import { loadConfig } from "../core/config.ts";
import { applyRootOverride } from "../core/paths.ts";

export const importHubCommand = defineCommand({
  meta: {
    name: "import-hub",
    description:
      "One-shot: read the GitHub hub's issues once and populate the local board, preserving issue numbers, live Claims and blocking edges. The last thing in servant that shells out to `gh`, and safe to re-run.",
  },
  args: {
    hub: {
      type: "string",
      required: false,
      description: "Hub repo slug (owner/name). Defaults to the configured hub.",
    },
    root: {
      type: "string",
      required: false,
      description: "Servant root directory (default: ~/.ai_servant). For throwaway/test setups.",
    },
  },
  async run({ args }) {
    applyRootOverride(args.root);
    const hubRepo = args.hub ? String(args.hub) : (await loadConfig()).hubRepo;
    console.log(`servant: importing ${hubRepo} into the board…`);
    const report = await importHub(hubRepo);
    console.log(
      `servant: ${report.created} created, ${report.updated} updated, ${report.edges} blocking edge(s), ` +
        `${report.claims} live Claim(s), ${report.parents} map link(s)`,
    );
    for (const { workspace, tickets } of importedBoardSummary()) {
      console.log(`  ${workspace}  (${tickets})`);
    }
    // Printed, never swallowed: silent loss is the one failure mode an import cannot be trusted
    // through, so what could not be carried over is part of the output.
    if (report.skipped.length > 0) {
      console.log(`\nservant: ${report.skipped.length} thing(s) could not be carried over:`);
      for (const line of report.skipped) console.log(`  - ${line}`);
    }
  },
});
