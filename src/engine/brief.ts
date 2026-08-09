// A leaf module: no `vscode`, no `fs`, no `path`, no connector client — so any
// host-side caller can depend on it, including ones (like the orchestrator's
// launcher) that must themselves stay free of `vscode`.

/** The markdown brief a run gets. Extracted so a flow-launched run and an
 * ordinary Take cannot drift apart — they must read identically, and two copies
 * of four lines is how that promise quietly breaks.
 *
 * `agentName` is the **already-resolved** label of the agent that will read this
 * ("Claude Code", "GitHub Copilot"), deliberately a plain string rather than an
 * `AgentProvider`: `providerLabel` lives in `config.ts`, which imports `vscode`,
 * and taking the enum here would drag that into this module and cost it the leaf
 * status the comment above promises. Callers resolve the label; this only writes
 * it. Defaults to Claude Code, which is what every brief said before the provider
 * setting existed. */
export function briefMarkdown(
  detail: { key: string; summary: string; descriptionText: string },
  agentName = "Claude Code",
): string {
  const desc = detail.descriptionText?.trim();
  const body = desc ? `## Ticket description\n\n${desc}` : "_(No description on the ticket.)_";
  return `## ${detail.key}: ${detail.summary}\n\n${body}\n\n## Plan\n\n_The ${agentName} prompt for this task says whether to plan first or implement._`;
}
