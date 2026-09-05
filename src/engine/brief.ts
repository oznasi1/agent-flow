// A leaf module: no `vscode`, no `fs`, no `path`, no connector client — so any
// host-side caller can depend on it, including ones (like the orchestrator's
// launcher) that must themselves stay free of `vscode`.

/** One child worktree, as the parent's brief names it. `path` is what the agent
 *  should `cd` into — the caller decides whether that is absolute or repo-relative,
 *  because only the caller knows how many repos the run spans. */
export interface BriefChild {
  key: string;
  summary: string;
  path: string;
  branch: string;
}

export interface BriefOrchestration {
  children: readonly BriefChild[];
  /** The branch every child merges into. Named in the brief because "not main" is
   *  the one instruction a subagent cannot infer from its own worktree. */
  parentBranch: string;
}

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
  orchestration?: BriefOrchestration,
): string {
  const desc = detail.descriptionText?.trim();
  const body = desc ? `## Ticket description\n\n${desc}` : "_(No description on the ticket.)_";
  const base = `## ${detail.key}: ${detail.summary}\n\n${body}\n\n## Plan\n\n_The ${agentName} prompt for this task says whether to plan first or implement._`;
  // Absent or empty children must leave the brief byte-identical: every existing
  // caller passes nothing, and the two paths have to read the same for a run that
  // has no tree under it.
  if (!orchestration?.children.length) return base;
  const rows = orchestration.children
    .map((c) => `| ${c.key} | ${cell(c.summary)} | \`${c.path}\` | \`${c.branch}\` |`)
    .join("\n");
  return `${base}

## Children — one subagent each

| Ticket | Summary | Worktree | Branch |
|---|---|---|---|
${rows}

Dispatch one subagent per row. Each works ONLY inside its worktree path.
Merge finished children into \`${orchestration.parentBranch}\`; never into main.`;
}

/** A summary safe to drop in a markdown table cell: an unescaped pipe would end the
 *  cell early and shift every column after it, and a newline would end the whole row.
 *
 *  Backslashes go first, and that ordering is the whole point. Escaping only the pipe
 *  turns a summary that already contains a backslash-pipe pair into `a\\|b`, which a
 *  renderer reads as one literal backslash followed by a LIVE pipe — the escape the
 *  replace just added has been consumed by the backslash in front of it. Doubling
 *  backslashes first means every `\\` in the output is one this function put there. */
function cell(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ");
}
