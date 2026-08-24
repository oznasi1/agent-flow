import * as vscode from "vscode";
import { AttentionCandidate, attentionKeys, nextAnnouncements } from "./engine/attention";
import { readAnnounced, writeAnnounced } from "./engine/attentionStore";

export interface AttentionPassDeps {
  /** Either the open Deck's own candidates or a fresh gather — the caller
   * decides, so this function never does I/O it cannot be told about. */
  candidates: () => AttentionCandidate[];
  setAttention: (keys: readonly string[]) => void;
  notify: boolean;
  focused: boolean;
  latchFile: string;
  nowMs: number;
  log: (m: string) => void;
}

/**
 * One pass of the attention job: badge what is waiting on you, and announce what
 * just started waiting.
 *
 * Runs whether or not the Deck panel is open — that is the whole point. The Deck's
 * own poll stops when its panel hides, so a run entering Action required used to be
 * completely silent.
 *
 * Split out of extension.ts and injected rather than inlined in the interval
 * callback because extension.test.ts drives real timers, not fake ones: a pass
 * buried in a 12-second callback would be the least-tested code in the feature.
 */
export function runAttentionPass(deps: AttentionPassDeps): void {
  try {
    const keys = attentionKeys(deps.candidates());
    // The badge is ambient and unconditional — it updates in an unfocused window,
    // and whether or not notifications are on.
    deps.setAttention(keys);

    // Everything below is the interrupt tier. With the setting off nothing is read
    // or written, so a user who did not opt in gets no file in ~/.agentflow either.
    if (!deps.notify) return;
    // Only a focused window announces, and it claims the edge for every window.
    // showInformationMessage is in-app, so a toast raised in a background window is
    // an announcement spent on nobody — and leaving the edge unclaimed means a
    // focused window still gets to raise it on its own next pass. Deliberately no
    // backlog announcement when a window later gains focus: a toast about a run
    // that parked an hour ago is noise, and the badge already covers it.
    if (!deps.focused) return;

    const { toAnnounce, announced } = nextAnnouncements(
      keys, readAnnounced(deps.latchFile), deps.nowMs,
    );
    writeAnnounced(deps.latchFile, announced);
    if (toAnnounce.length === 0) return;
    // Coalesced: three runs parking in one pass is one notification, not three.
    // "sessions", never "agents" — see vocabulary.test.ts.
    const message =
      toAnnounce.length === 1
        ? `${toAnnounce[0]} is waiting on you`
        : `${toAnnounce.length} sessions are waiting on you`;
    void (vscode.window.showInformationMessage(message, "Open Deck") as Promise<string | undefined>).then(
      (choice) => {
        // The EXISTING command — compat.test.ts asserts the manifest's command ids
        // as an exact set, so this feature adds none.
        if (choice === "Open Deck") return vscode.commands.executeCommand("agentFlow.openDeck");
      },
    ).catch((e: unknown) => deps.log(`attention: toast failed: ${e}`));
  } catch (e) {
    // Same posture as every other best-effort nicety on this poll: a failure here
    // must never take the badge, the notepad poll, or the extension down with it.
    deps.log(`attention: pass failed: ${e}`);
  }
}
