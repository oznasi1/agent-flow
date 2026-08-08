// A leaf module: no `vscode`, no `fs`, no `path`, no connector client — so any
// host-side caller can depend on it, including ones (like the orchestrator's
// launcher) that must themselves stay free of `vscode`.

/** The markdown brief a run gets. Extracted so a flow-launched run and an
 * ordinary Take cannot drift apart — they must read identically, and two copies
 * of four lines is how that promise quietly breaks. Needs nothing but the ticket,
 * so it stays free of `vscode` and of any connector's client. */
export function briefMarkdown(
  detail: { key: string; summary: string; descriptionText: string },
): string {
  const desc = detail.descriptionText?.trim();
  const body = desc ? `## Ticket description\n\n${desc}` : "_(No description on the ticket.)_";
  return `## ${detail.key}: ${detail.summary}\n\n${body}\n\n## Plan\n\n_The Claude Code prompt for this task says whether to plan first or implement._`;
}
