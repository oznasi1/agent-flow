// One orchestrator pass with no editor: the subset of `deckView.ts`'s
// `advanceUnderLock` that a scheduled process can honestly perform.
//
// What it does: takes the flows lock, runs the clocks (deadlines), reads command
// output for `command-printed`, evaluates every armed flow, and performs the two
// verbs that need neither a window nor a person — `notify` (printed to stdout and
// stamped, so the Deck shows the receipt) and `run`, but a `run` ONLY when the
// flow's consent already covers it. Everything else it refuses out loud:
//
//  - `launch`, `seed` and `ask` need an editor and a person. Their rules are left
//    PENDING — not stamped, not errored — and named in the report, so the next
//    Deck pass finds them exactly as met as they were.
//  - a `run` the flow has not consented to is left pending the same way; the
//    tick never asks, and never invents an approval.
//  - the resume gate does not exist here. The Deck holds first-look fires until
//    you press Go because reopening a window must not spend; a scheduled tick is
//    the user asking for unattended passes, and it spends only what is consented.
//
// Pure over injected IO, like every engine module, so the whole pass is testable
// from fixtures; `main.ts` wires the real filesystem, shell and forge.
import { CommandNode, Flow, FlowAction, FlowEdge, atTokenCeiling, findNode, flowRunKeys, hasCeiling, hasTokenCeiling, isPlace, isSettled, isSpendAction, overCeiling, spendTotal } from "../engine/orchestrator/model";
import { FlowIo, readFlows, writeFlow } from "../engine/orchestrator/store";
import { evaluateDeadlines, evaluateFlow } from "../engine/orchestrator/evaluate";
import { ActOutcome, applyClocks, applyFired, notifyLines } from "../engine/orchestrator/runner";
import { appendEvent, JournalEventInput, JournalIo, printedVerdicts, readJournal, spendTally, truncateOutput } from "../engine/orchestrator/journal";
import { acquire, LOCK_TTL_MS, LockIo, release, renew } from "../engine/orchestrator/lock";
import { chainSourcePlace, CommandRunner, resolveCommand, runCommand } from "../engine/orchestrator/command";
import { blockedBy } from "../engine/orchestrator/neverAutoRun";
import { consentCovers, consumeConsent } from "../engine/orchestrator/consent";
import { FlowCommand, RunStatus } from "../types";

export interface PassSettings {
  commands: FlowCommand[];
  neverAutoRun: string[];
  commandConsent: "flow" | "command";
}

export interface PassDeps {
  flowIo: FlowIo;
  lockIo: LockIo;
  journalIo: JournalIo;
  flowsDir: string;
  statuses: RunStatus[];
  settings: PassSettings;
  run: CommandRunner;
  /** A checkout by repo name, for a command node whose `cwdRepo` names a repo the
   * source run does not carry — the Deck's `discoverRepos` fallback. */
  discoverRepo: (name: string) => { name: string; path: string } | undefined;
  nowMs: number;
  /** The real clock, for renewing the lock after a command that took real time. */
  now: () => number;
  log: (m: string) => void;
  /** Evaluate and report, write nothing, run nothing. */
  dryRun: boolean;
  token: string;
  /** Effort-weighted token equivalents spent across these runs, for a flow with
   * a `tokenCeiling` — `undefined` when nothing could be read, which the pass
   * treats as "not measured" rather than as zero (see `atTokenCeiling`).
   * Optional: a caller with no reader (every existing test) has no token
   * ceilings to enforce. */
  tokenSpend?: (runKeys: string[]) => number | undefined;
}

export interface FlowReport {
  id: string;
  name: string;
  /** Receipts of rules this pass stamped as fired, in the flow's own words. */
  fired: string[];
  /** Notify lines, exactly as the Deck would have toasted them. */
  notified: string[];
  /** Rules that errored this pass, with the error. */
  errored: string[];
  /** Rules that expired this pass. */
  expired: string[];
  /** Met rules this pass could not perform because they need an editor. */
  needsEditor: string[];
  /** Met `run` rules this pass could not perform because the flow has not
   * consented to them. */
  needsConsent: string[];
  /** Set when the pass disarmed the flow at its spend ceiling — the count, or
   * the token figure, whichever it hit. */
  disarmedAtCeiling?: string;
}

export interface PassReport {
  lock: "held" | "busy";
  flows: FlowReport[];
}

/** Which rule sentence a report names: source → target, with the verb. */
function ruleName(flow: Flow, e: FlowEdge, action: FlowAction | undefined): string {
  return `${e.id} (${e.from} → ${e.to}${action ? `, ${action}` : ""})`;
}

export async function runHeadlessPass(d: PassDeps): Promise<PassReport> {
  const journal = (flowId: string, ev: JournalEventInput, at: number) => {
    if (d.dryRun) return;
    try {
      appendEvent(d.journalIo, d.flowsDir, flowId, ev, at);
    } catch (e) {
      d.log(`journal unavailable — ${(e as Error).message}`);
    }
  };
  if (!d.dryRun && !acquire(d.lockIo, d.flowsDir, d.nowMs, LOCK_TTL_MS, d.token)) return { lock: "busy", flows: [] };
  const reports: FlowReport[] = [];
  let lostLock = false;
  try {
    const flows = readFlows(d.flowIo, d.flowsDir);
    for (const flow of flows) {
      if (!flow.armed || lostLock) continue;
      const report: FlowReport = { id: flow.id, name: flow.name, fired: [], notified: [], errored: [], expired: [], needsEditor: [], needsConsent: [] };
      reports.push(report);
      try {
        const printed = flow.edges.some((e) => e.cond?.kind === "command-printed" && !isSettled(e))
          ? printedVerdicts(flow, readJournal(d.journalIo, d.flowsDir, flow.id))
          : undefined;

        // Clocks first, as in the Deck: bookkeeping about waiting, not a spend.
        const clocks = evaluateDeadlines({ flow, statuses: d.statuses, nowMs: d.nowMs, printed, flows });
        if (clocks.wentLive.length > 0 || clocks.expired.length > 0) {
          const current = readFlows(d.flowIo, d.flowsDir).find((f) => f.id === flow.id);
          if (current) {
            const stamped = applyClocks(current, clocks, d.nowMs);
            if (stamped !== current) {
              if (!d.dryRun) writeFlow(d.flowIo, d.flowsDir, stamped);
              for (const e of stamped.edges) {
                if (e.expiredAt !== d.nowMs || !clocks.expired.includes(e.id)) continue;
                report.expired.push(ruleName(flow, e, undefined));
                journal(flow.id, { kind: "expired", edge: e.id, from: e.from, to: e.to, since: e.liveSince ?? d.nowMs }, d.nowMs);
              }
            }
          }
        }

        const result = evaluateFlow({ flow, statuses: d.statuses, nowMs: d.nowMs, printed, flows });
        if (result.fired.length === 0) continue;

        const fresh = readFlows(d.flowIo, d.flowsDir).find((f) => f.id === flow.id);
        if (!fresh) continue;
        const freshById = new Map(fresh.edges.map((e) => [e.id, e]));
        const unclaimed = result.fired
          .filter((f) => { const now = freshById.get(f.edge.id); return now !== undefined && !isSettled(now); })
          .map((f) => ({ ...f, edge: freshById.get(f.edge.id)! }));
        if (unclaimed.length === 0) continue;

        // One action per target per pass — the Deck's own dedupe.
        const actedTargets = new Set<string>();
        const firing = unclaimed.map((f) => {
          if (!f.perform || !isSpendAction(f.action)) return f;
          if (actedTargets.has(f.edge.to)) return { ...f, perform: false };
          actedTargets.add(f.edge.to);
          return f;
        });

        // The ceiling, before anything is performed — same rule as the Deck.
        const wanted = firing.filter((f) => f.perform && isSpendAction(f.action)).length;
        if (wanted > 0 && hasCeiling(fresh)) {
          const tally = spendTally(readJournal(d.journalIo, d.flowsDir, fresh.id));
          if (overCeiling(fresh, tally, wanted)) {
            report.disarmedAtCeiling = `${spendTotal(tally)} of ${fresh.spendCeiling} spent, and this pass wanted ${wanted}`;
            if (!d.dryRun) {
              const atStop = readFlows(d.flowIo, d.flowsDir).find((f) => f.id === flow.id);
              if (atStop) writeFlow(d.flowIo, d.flowsDir, { ...atStop, armed: false });
              journal(flow.id, { kind: "armed", armed: false, source: "ceiling" }, d.nowMs);
            }
            continue;
          }
        }
        // The token ceiling, read off the transcripts the Deck's card reads —
        // same rule as the Deck: at or past it, a pass that wants to spend stops.
        if (wanted > 0 && hasTokenCeiling(fresh) && d.tokenSpend) {
          const eq = d.tokenSpend(flowRunKeys(fresh));
          if (atTokenCeiling(fresh, { sessions: 0, commands: 0, eq })) {
            report.disarmedAtCeiling = `${eq} eq of ${fresh.tokenCeiling} eq spent, and this pass wanted ${wanted}`;
            if (!d.dryRun) {
              const atStop = readFlows(d.flowIo, d.flowsDir).find((f) => f.id === flow.id);
              if (atStop) writeFlow(d.flowIo, d.flowsDir, { ...atStop, armed: false });
              journal(flow.id, { kind: "armed", armed: false, source: "token-ceiling" }, d.nowMs);
            }
            continue;
          }
        }

        const outcomes = new Map<string, ActOutcome>();
        const outputs = new Map<string, string>();
        const consumed: string[] = [];
        // Targets whose acting edge this pass could not or would not perform. Their
        // siblings are left pending too — stamping them around an unperformed
        // performer is the strand the Deck's `deferredTargets` exists to prevent.
        const heldTargets = new Set<string>();
        for (const f of firing) {
          if (!f.perform) continue;
          // A gate's `ask` spends nothing, so `isSpendAction` would let it through
          // to be stamped as posed — but a question posed with nobody there to
          // answer it is the degradation the backlog forbids. Held, like a launch.
          // A `spawn` spends nothing either, but starting a child needs the
          // templates store and the card's ticket, which live with the editor;
          // held the same way, and stated.
          if (f.action === "ask" || f.action === "spawn") {
            heldTargets.add(f.edge.to);
            report.needsEditor.push(ruleName(fresh, f.edge, f.action));
            continue;
          }
          if (!isSpendAction(f.action)) continue;
          if (f.action !== "run") {
            heldTargets.add(f.edge.to);
            report.needsEditor.push(ruleName(fresh, f.edge, f.action));
            continue;
          }
          const node = findNode(fresh, f.edge.to);
          if (!node || node.kind !== "command") {
            outcomes.set(f.edge.id, { ok: false, error: `a run rule must point at a command, and ${f.edge.to} is not.` });
            continue;
          }
          const resolved = resolveCommand(node, d.settings.commands, f.edge.note);
          if (!resolved.ok) {
            outcomes.set(f.edge.id, { ok: false, error: resolved.message });
            continue;
          }
          // The denylist outranks every approval, here as in the Deck — refused
          // before consent is even consulted, and again inside `runCommand`.
          const blocked = blockedBy(resolved.text, d.settings.neverAutoRun);
          if (blocked !== undefined) {
            outcomes.set(f.edge.id, { ok: false, error: `"${resolved.text}" matches agentFlow.neverAutoRun pattern "${blocked}" — never run unattended.` });
            continue;
          }
          const covered = d.settings.commandConsent === "command"
            ? consentCovers(fresh, resolved.text) !== undefined
            : fresh.commandConfirmedAt !== undefined;
          if (!covered) {
            heldTargets.add(f.edge.to);
            report.needsConsent.push(`${ruleName(fresh, f.edge, f.action)}: "${resolved.text}"`);
            continue;
          }
          const where = commandCwd(fresh, f.edge, node, d.statuses, d.discoverRepo);
          if ("defer" in where) {
            heldTargets.add(f.edge.to);
            d.log(`${flow.name}: ${where.defer}`);
            continue;
          }
          if ("error" in where) {
            outcomes.set(f.edge.id, { ok: false, error: where.error });
            continue;
          }
          if (d.dryRun) {
            heldTargets.add(f.edge.to);
            report.fired.push(`would run "${resolved.text}" in ${where.repo}`);
            continue;
          }
          const outcome = await runCommand(
            { node, commands: d.settings.commands, note: f.edge.note, cwd: where.cwd, neverAutoRun: d.settings.neverAutoRun },
            { run: d.run, log: d.log },
          );
          if (!renew(d.lockIo, d.flowsDir, d.token, d.now())) {
            d.log(`the flows lock was lost after ${f.edge.id} — nothing further is performed this pass`);
            lostLock = true;
          }
          if (d.settings.commandConsent === "command") consumed.push(resolved.text);
          if (outcome.output && outcome.output.length > 0) outputs.set(f.edge.id, truncateOutput(outcome.output));
          outcomes.set(f.edge.id, outcome.ok
            ? { ok: true, note: `ran ${outcome.label} in ${where.repo}` }
            : { ok: false, error: outcome.message });
          if (lostLock) break;
        }

        const stamping = firing.filter((f) => !heldTargets.has(f.edge.to));
        if (stamping.length === 0) continue;
        if (d.dryRun) {
          for (const line of notifyLines(fresh, stamping)) report.notified.push(`would notify: ${line}`);
          continue;
        }
        const atWrite = readFlows(d.flowIo, d.flowsDir).find((f) => f.id === flow.id);
        if (!atWrite) continue;
        let next = applyFired(atWrite, stamping, d.nowMs, outcomes);
        for (const text of consumed) next = consumeConsent(next, text);
        writeFlow(d.flowIo, d.flowsDir, next);
        for (const f of stamping) {
          const e = next.edges.find((x) => x.id === f.edge.id);
          if (!e) continue;
          const output = outputs.get(f.edge.id);
          const action = f.action ?? "unknown";
          if (e.error !== undefined) {
            report.errored.push(`${ruleName(next, e, f.action)}: ${e.error}`);
            journal(flow.id, { kind: "errored", edge: e.id, from: e.from, to: e.to, action, error: e.error, ...(output === undefined ? {} : { output }) }, d.nowMs);
            if (e.retryAt !== undefined) {
              journal(flow.id, { kind: "retrying", edge: e.id, attempt: e.attempts ?? 1, max: e.retry?.max ?? 0, retryAt: e.retryAt }, d.nowMs);
            }
          } else if (e.firedAt !== undefined) {
            report.fired.push(`${ruleName(next, e, f.action)}: ${e.firedNote ?? "fired"}`);
            journal(flow.id, { kind: "fired", edge: e.id, from: e.from, to: e.to, action, note: e.firedNote ?? "", ...(output === undefined ? {} : { output }) }, d.nowMs);
          }
        }
        for (const line of notifyLines(next, stamping)) report.notified.push(line);
      } catch (e) {
        d.log(`${flow.name}: pass failed — ${(e as Error).message}`);
      }
    }
  } finally {
    if (!d.dryRun) release(d.lockIo, d.flowsDir, d.token);
  }
  return { lock: "held", flows: reports };
}

/** The Deck's `commandCwd`, restated over plain inputs: the named `cwdRepo` if the
 * source run carries it (else a checkout on disk by that name), otherwise the
 * repo of the nearest place upstream. A direct place whose repo is missing from
 * its run this pass is a defer; every other failure is a refusal. */
export function commandCwd(
  flow: Flow,
  edge: FlowEdge,
  node: CommandNode,
  statuses: RunStatus[],
  discoverRepo: (name: string) => { name: string; path: string } | undefined,
): { cwd: string; repo: string } | { error: string } | { defer: string } {
  const source = findNode(flow, edge.from);
  const directPlace = source && isPlace(source) ? source : undefined;
  const fromPlace = directPlace ?? chainSourcePlace(flow, edge.from);
  const runRepos = fromPlace ? statuses.find((s) => s.run.key === fromPlace.runKey)?.run.repos ?? [] : [];
  const named = typeof node.cwdRepo === "string" && node.cwdRepo.trim() !== "" ? node.cwdRepo : undefined;
  if (named !== undefined) {
    const inRun = runRepos.find((r) => r.name === named);
    if (inRun) return { cwd: inRun.path, repo: inRun.name };
    const onDisk = discoverRepo(named);
    if (onDisk) return { cwd: onDisk.path, repo: onDisk.name };
    return { error: `this command runs in "${named}", which isn't checked out on this machine — not running it somewhere else.` };
  }
  if (!fromPlace) {
    return { error: `nothing upstream of ${edge.from} is a place, so the command at ${edge.to} has no checkout to run in — give the command node a working directory ("cwdRepo" in the flow file).` };
  }
  const repo = runRepos.find((r) => r.name === fromPlace.repo);
  if (!repo) {
    if (directPlace) return { defer: `${fromPlace.repo} is not among run ${fromPlace.runKey}'s repos on this pass, so the command at ${edge.to} has no directory to run in` };
    return { error: `the command at ${edge.to} runs where ${fromPlace.runKey} put "${fromPlace.repo}", and that run is not on the board — give the command node a working directory ("cwdRepo" in the flow file).` };
  }
  return { cwd: repo.path, repo: repo.name };
}
