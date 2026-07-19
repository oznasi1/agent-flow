import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { PromptMode } from "./types";

export const DEFAULT_PROMPT_MODES: PromptMode[] = [
  {
    id: "plan",
    label: "Plan first",
    prompt:
      'Jira {key}: "{summary}". Read the task brief at {brief} for context and the repos involved. ' +
      "Propose a step-by-step PLAN for this task and wait for my approval — do not edit any code yet. Ticket: {url}{files}",
  },
  {
    id: "implementation",
    label: "Implementation",
    prompt:
      'Jira {key}: "{summary}". Read the task brief at {brief} for context and the repos involved. ' +
      "Begin implementing. Confirm your approach with me only if something is ambiguous. Ticket: {url}{files}",
  },
];

/** Seed for an Explore session (no ticket). Placeholders: {summary} (your focus), {brief}, {files}. */
export const DEFAULT_EXPLORE_PROMPT =
  'Exploration session — no Jira ticket yet. Focus: "{summary}". A brief listing the repos in scope is at {brief}. ' +
  "Help me understand how this works: map the relevant code paths, explain the flow, and flag anything surprising " +
  "or worth a follow-up ticket. Don't change code unless I ask.{files}";

export interface FlowDeckConfig {
  baseUrl: string;
  project: string;
  reposRoot: string;
  workspaceDir: string;
  githubOrg: string;
  repoBlocklist: string[];
  defaultFilter: string;
  seedAgent: boolean;
  workspaceMode: "auto" | "multiroot" | "per-window" | "ask";
  openIn: "ask" | "new-window" | "this-window" | "pick-existing";
  taskMode: string; // "ask", or a PromptMode id
  promptModes: PromptMode[];
  explorePrompt: string;
  worktree: "ask" | "always" | "never";
  worktreeRoot: string;
  stampLabelOnWrite: boolean;
  provenanceLabel: string;
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function getConfig(): FlowDeckConfig {
  const c = vscode.workspace.getConfiguration("flowdeck");
  return {
    baseUrl: (c.get<string>("jira.baseUrl") || "").replace(/\/+$/, ""),
    project: c.get<string>("jira.project") || "",
    reposRoot: expandHome(c.get<string>("reposRoot") || "~/projects"),
    workspaceDir: expandHome(c.get<string>("workspaceDir") || "~/projects"),
    githubOrg: c.get<string>("githubOrg") || "",
    repoBlocklist: (() => {
      const b = c.get<string[]>("repoBlocklist");
      return Array.isArray(b) ? b.filter((x) => typeof x === "string" && x.length) : [];
    })(),
    defaultFilter: c.get<string>("defaultFilter") || "mysprint",
    seedAgent: c.get<boolean>("seedAgent") ?? true,
    workspaceMode: (c.get<FlowDeckConfig["workspaceMode"]>("workspaceMode")) || "auto",
    openIn: (c.get<FlowDeckConfig["openIn"]>("openIn")) || "ask",
    taskMode: c.get<string>("taskMode") || "ask",
    promptModes: (() => {
      const m = c.get<PromptMode[]>("promptModes");
      return Array.isArray(m) && m.length ? m.filter((x) => x && x.id && x.label && x.prompt) : DEFAULT_PROMPT_MODES;
    })(),
    explorePrompt: c.get<string>("explorePrompt") || DEFAULT_EXPLORE_PROMPT,
    worktree: (c.get<FlowDeckConfig["worktree"]>("worktree")) || "ask",
    worktreeRoot: expandHome(c.get<string>("worktreeRoot") || "~/projects/.worktrees"),
    stampLabelOnWrite: c.get<boolean>("stampLabelOnWrite") ?? true,
    provenanceLabel: c.get<string>("provenanceLabel") || "claude-code",
  };
}
