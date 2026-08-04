// The model for the servant's two *headless* `claude -p` passes — memory extraction and insight
// judgment. These fire unattended on every qualifying SessionEnd, so they are the servant's
// highest-frequency self-spend and a textbook fit for a cheaper model (bounded input, structured
// output, distill/label work — not open-ended reasoning). See ADR-005.
//
// Interactive spawns (`servant spawn`, `servant fine-tune`) go through a separate code path
// (`claudeCodeAgent.launchCommand`) that never calls this, so they stay on the user's default model.

/**
 * Per-backend default headless model. Aliases (not pinned ids) so they track the latest without
 * churn. Codex has no cheap-tier alias worth pinning here — omitting `--model` lets it inherit the
 * user's `~/.codex/config.toml` model, so its default is empty.
 */
const DEFAULT_HEADLESS_MODEL: Record<string, string> = {
  "claude-code": "sonnet",
  codex: "",
};

/**
 * `--model` args for the headless runners, read from `SERVANT_HEADLESS_MODEL`, else the backend's
 * default (Claude → `"sonnet"`; Codex → inherit its config). An empty value or `"default"` returns
 * `[]` — the escape hatch that omits `--model` so the pass inherits the CLI's own default model.
 */
export function headlessModelArgs(backend = "claude-code"): string[] {
  const fallback = DEFAULT_HEADLESS_MODEL[backend] ?? "";
  const raw = (process.env.SERVANT_HEADLESS_MODEL ?? fallback).trim();
  if (raw === "" || raw === "default") return [];
  return ["--model", raw];
}
