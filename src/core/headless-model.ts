// The model for the servant's two *headless* `claude -p` passes — memory extraction and insight
// judgment. These fire unattended on every qualifying SessionEnd, so they are the servant's
// highest-frequency self-spend and a textbook fit for a cheaper model (bounded input, structured
// output, distill/label work — not open-ended reasoning). See ADR-005.
//
// Interactive spawns (`servant spawn`, `servant fine-tune`) go through a separate code path
// (`claudeCodeAgent.launchCommand`) that never calls this, so they stay on the user's default model.

/** Default headless model. An alias (not a pinned id) so it tracks the latest Sonnet without churn. */
const DEFAULT_HEADLESS_MODEL = "sonnet";

/**
 * `--model` args for the two headless `claude -p` runners, read from `SERVANT_HEADLESS_MODEL`
 * (default `"sonnet"`). An empty value or `"default"` returns `[]` — the escape hatch that omits
 * `--model` so the headless passes inherit the user's default model (today's pre-ADR-005 behavior).
 */
export function headlessModelArgs(): string[] {
  const raw = (process.env.SERVANT_HEADLESS_MODEL ?? DEFAULT_HEADLESS_MODEL).trim();
  if (raw === "" || raw === "default") return [];
  return ["--model", raw];
}
