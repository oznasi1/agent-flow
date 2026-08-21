// Which agent a multi-session launch seeds. Extracted from tasksView.ts when the
// Deck's review batch needed the same answer: a shared window seeds from plan files
// and can never ask later, so the question has to be settled before anything opens.
import * as vscode from "vscode";
import { hostProviders, providerLabel, resolvedProvider, AgentFlowConfig, AgentProvider } from "./config";

/** The agent for a whole batch, resolved before the loop that cannot ask. Under the
 *  three fixed settings this is a plain read and NO picker appears — the setting is
 *  the answer, and it is the same answer `openWorkspace` would have reached on its
 *  own. Under `ask` it puts up the same picker `openWorkspace` would have, once, and
 *  the caller pins the answer onto every task so no task asks again.
 *
 *  With seeding off there is no agent to start, so there is nothing to ask about and
 *  `ask` degrades exactly as `resolvedProvider` says it does — the same condition
 *  `openWorkspace` guards its own picker with.
 *
 *  `undefined` means dismissed, at which point the batch must launch nothing. */
export async function resolveBatchProvider(cfg: AgentFlowConfig, isBatch: boolean): Promise<AgentProvider | undefined> {
  if (cfg.agentProvider !== "ask" || !cfg.seedAgent) return resolvedProvider(cfg.agentProvider);
  // One possible agent is not a question — same short-circuit, and same reasoning, as
  // the picker in `openWorkspace`.
  const choices = hostProviders();
  if (choices.length === 1) return choices[0];
  const choice = await vscode.window.showQuickPick(
    choices.map((p) => ({ label: providerLabel(p), provider: p })),
    {
      // The SAME title as the picker in `openWorkspace` — one launch-time question,
      // asked in one voice, whichever path raises it. Only the placeholder says what
      // is different about this one: it answers for every task, not just one.
      //
      // …which is only true of a REAL batch. A one-key batch reaches here solely
      // because a shared window seeds from plan files and cannot ask later; it is a
      // single launch, so it gets the single-launch placeholder, word for word the
      // one `openWorkspace` would have shown it.
      title: "Which agent?",
      placeHolder: isBatch ? "Pick the agent for every task in this batch" : "Pick the agent to start this session with",
      ignoreFocusOut: true,
    },
  );
  return choice?.provider;
}

/** A caller's agent pin, for spreading into an open request. Sent ONLY under `ask`,
 *  where it replaces a prompt that has already been answered. Under a fixed setting
 *  a pin is ignored (see `OpenRequest.provider`) and the user's preference wins, so
 *  sending one there could only invite the request and the setting to look like they
 *  disagree — and it would change a request that must stay exactly what it was. */
export function providerPin(cfg: AgentFlowConfig, provider: AgentProvider): { provider?: AgentProvider } {
  return cfg.agentProvider === "ask" ? { provider } : {};
}
