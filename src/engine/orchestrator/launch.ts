import { PlannedNode } from "./model";
import { ServiceRef, WorkspaceMode } from "../../types";
import type { OpenRequest, OpenResult } from "../workspace";
import { briefMarkdown } from "../brief";

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
  /** The resolved label of the agent that will read this run's brief ("Claude Code",
   * "GitHub Copilot"). Supplied by the caller for the same reason `workspaceMode` is:
   * `providerLabel` lives in `config.ts`, which imports `vscode`, and this module must
   * not. Without it a flow-launched brief would name Claude Code to a Copilot user. */
  agentName: string;
}

export interface LaunchDeps {
  createWorktrees: (services: ServiceRef[], key: string, summary: string, log: (m: string) => void) => ServiceRef[];
  openWorkspace: (req: OpenRequest) => Promise<OpenResult>;
  log: (m: string) => void;
}

export type LaunchOutcome =
  | { ok: true; runKey: string; repo: string }
  | { ok: false; message: string };

/** Launch a planned node: resolve its named repos against what's actually checked
 * out, optionally worktree them, and open the workspace. `kind` is left unset on the
 * resulting run, so a flow-launched run reads exactly like an ordinary Take. Never
 * throws — the caller is a poll loop inside the Deck's own refresh, and an exception
 * here would take the whole refresh down, not just this one flow. The whole body runs
 * inside one try: that guarantee must hold regardless of what an injected dep does,
 * not only for the one call (`openWorkspace`) known to be async. */
export async function launchPlanned(req: LaunchRequest, deps: LaunchDeps): Promise<LaunchOutcome> {
  const { node, detail, repos, promptTemplate, workspaceDir, seedAgent, workspaceMode, agentName } = req;

  try {
    // Two sources of truth for "which ticket" meet here: the node the user wired and
    // the detail the caller fetched. They must be the same ticket. If a caller ever
    // pairs them wrongly, refusing costs one rule; proceeding spends a session on the
    // wrong ticket and binds the node to the wrong run forever.
    if (node.ticketKey !== detail.key) {
      return {
        ok: false,
        message: `flow node names ${node.ticketKey} but the ticket fetched was ${detail.key} — not launching.`,
      };
    }

    // A node naming no repos at all is nothing to launch into — fail explicitly rather
    // than fall through to a refusal message built from an empty list.
    if (!node.repos.length) {
      return { ok: false, message: `the flow node names no repos — nothing to launch ${detail.key} into.` };
    }

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

    // A repo named but not checked out here is silently dropped below — unattended,
    // with the agent possibly missing something it needs. Say so, naming what's gone.
    const dropped = node.repos.filter((name) => !resolved.some((r) => r.name === name));
    if (dropped.length) {
      deps.log(
        `launch ${detail.key}: ${dropped.join(", ")} named but not checked out on this machine — launching without ${dropped.length === 1 ? "it" : "them"}`,
      );
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

    await deps.openWorkspace({
      ticket: { key: detail.key, summary: detail.summary, url: detail.url },
      planMd: briefMarkdown(detail, agentName),
      descriptionText: detail.descriptionText,
      services,
      mode: workspaceMode,
      promptTemplate,
      workspaceDir,
      seedAgent,
      openIn: node.dest === "current-window" ? "current" : "new",
      // Unattended: a rule fires with nobody watching, so it must never reach the
      // `ask` picker — which is `ignoreFocusOut: true`, so reaching it would not time
      // out, it would hold the Deck's refresh open until someone came back and
      // answered. Claude Code is the one agent every host can run.
      //
      // A pin is read ONLY under `ask` (see OpenRequest.provider), so this suppresses a
      // prompt and never overrides a preference: a user whose setting says `cursor`
      // still gets Cursor here, and `agentName` — which the caller resolved from that
      // same setting — still names it in the brief.
      provider: "claude-code",
    });

    // The run's key IS `ticket.key` above — openWorkspace writes `run.key = ticket.key`
    // verbatim. Returning anything else would bind the promoted place to a key no stored
    // Run carries, and every downstream condition on it would then observe nothing, ever.
    return { ok: true, runKey: detail.key, repo: resolved[0].name };
  } catch (e) {
    return { ok: false, message: `Couldn't launch ${detail.key}: ${e}` };
  }
}
