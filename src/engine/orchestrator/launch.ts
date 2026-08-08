import { PlannedNode } from "./model";
import { ServiceRef, WorkspaceMode } from "../../types";
import type { OpenRequest, OpenResult } from "../workspace";

/** The four fields a launch needs from a ticket. A local structural type, NOT
 * `TaskDetail` from `src/tasks/jira/client.ts` — the launcher must not depend on
 * one connector's client, and `provider().detail(key)` returns a superset that
 * satisfies this as-is. */
export interface LaunchTicketDetail {
  key: string;
  summary: string;
  url: string;
  descriptionText: string;
}

export interface LaunchRequest {
  node: PlannedNode;
  detail: LaunchTicketDetail;
  /** Every repo checkout discovered on this machine, by name. */
  repos: ServiceRef[];
  promptTemplate: string;
  workspaceDir: string;
  seedAgent: boolean;
  /** The workspace LAYOUT ("multiroot" | "per-window") — not `node.mode`, which is a
   * PromptMode id selecting the prompt (already resolved into `promptTemplate` by the
   * caller). Deciding the layout is config-owning policy; the launcher must not invent
   * it, so the caller (which has config access) supplies it here. */
  workspaceMode: WorkspaceMode;
}

export interface LaunchDeps {
  createWorktrees: (services: ServiceRef[], key: string, summary: string, log: (m: string) => void) => ServiceRef[];
  openWorkspace: (req: OpenRequest) => Promise<OpenResult>;
  log: (m: string) => void;
}

export type LaunchOutcome =
  | { ok: true; runKey: string; repo: string }
  | { ok: false; message: string };

/** The plan brief written into the run. Mirrors tasksView.ts's private buildBrief —
 * not imported, since that module pulls in `vscode` — kept identical in shape so a
 * run a flow launches reads exactly like an ordinary Take. */
function plannedBriefMarkdown(detail: LaunchTicketDetail): string {
  const desc = detail.descriptionText?.trim();
  const body = desc ? `## Ticket description\n\n${desc}` : "_(No description on the ticket.)_";
  return `## ${detail.key}: ${detail.summary}\n\n${body}\n\n## Plan\n\n_The Claude Code prompt for this task says whether to plan first or implement._`;
}

/** Launch a planned node: resolve its named repos against what's actually checked
 * out, optionally worktree them, and open the workspace. `kind` is left unset on the
 * resulting run, so a flow-launched run reads exactly like an ordinary Take. Never
 * throws — the caller is a poll loop inside the Deck's own refresh, and an exception
 * here would take the whole refresh down, not just this one flow. */
export async function launchPlanned(req: LaunchRequest, deps: LaunchDeps): Promise<LaunchOutcome> {
  const { node, detail, repos, promptTemplate, workspaceDir, seedAgent, workspaceMode } = req;

  // A planned node names its repos by name, not by path — resolve against what's
  // actually checked out on this machine. Launching into a repo that isn't checked
  // out here would create a worktree in the wrong place, so an empty result refuses
  // outright rather than guessing.
  const resolved = node.repos
    .map((name) => repos.find((r) => r.name === name))
    .filter((r): r is ServiceRef => !!r);
  if (!resolved.length) {
    return {
      ok: false,
      message: `${node.repos.join(", ")} ${node.repos.length === 1 ? "isn't" : "aren't"} checked out under your repos root — not launching ${detail.key}.`,
    };
  }

  // A place node means exactly one repo. When the node names several, the place
  // binds to the first that actually resolved (not literally the first name) —
  // that's a silent choice unless it's said out loud here.
  if (resolved.length > 1) {
    deps.log(
      `launch ${detail.key}: node names ${node.repos.join(", ")} — binding the place to ${resolved[0].name}, the first that resolved`,
    );
  }

  let services = resolved;
  if (node.dest === "worktree") {
    services = deps.createWorktrees(resolved, detail.key, detail.summary, deps.log);
    // createWorktrees falls back to the main checkout when it cannot create a worktree.
    // For an ordinary Take that's merely inconvenient; here nobody is watching an
    // unattended launch, so proceeding would point an agent at the user's OWN checkout.
    // Refuse: an un-launched rule costs a click, an agent loose in the main checkout can
    // cost work in progress.
    const failed = resolved.find((base, i) => services[i]?.path === base.path);
    if (failed) {
      return {
        ok: false,
        message: `Couldn't create a git worktree in ${failed.name} — not launching ${detail.key} in your main checkout. The Agent Flow Deck output channel has the reason.`,
      };
    }
  }

  try {
    await deps.openWorkspace({
      ticket: { key: detail.key, summary: detail.summary, url: detail.url },
      planMd: plannedBriefMarkdown(detail),
      descriptionText: detail.descriptionText,
      services,
      mode: workspaceMode,
      promptTemplate,
      workspaceDir,
      seedAgent,
      openIn: node.dest === "current-window" ? "current" : "new",
    });
  } catch (e) {
    return { ok: false, message: `Couldn't open a workspace for ${detail.key}: ${e}` };
  }

  // The run's key IS `ticket.key` above — openWorkspace writes `run.key = ticket.key`
  // verbatim. Returning anything else would bind the promoted place to a key no stored
  // Run carries, and every downstream condition on it would then observe nothing, ever.
  return { ok: true, runKey: detail.key, repo: resolved[0].name };
}
