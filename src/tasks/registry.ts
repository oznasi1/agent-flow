import * as vscode from "vscode";
import { getConfig } from "../config";
import { makeJiraConnector } from "./jira/connector";
import { TaskConnector } from "./provider";

/** Every task source Agent Flow can read from. Adding one is this line plus a
 * directory — see docs/CONNECTORS.md. */
const CONNECTORS: Record<string, (ctx: vscode.ExtensionContext) => TaskConnector> = {
  jira: makeJiraConnector,
};

/** The registered ids. Exported so the telemetry snapshot's allowlist and the
 * manifest-parity test both derive from the registry instead of a hand-written
 * literal that would report a contributor's connector as "invalid" forever. */
export const CONNECTOR_IDS: string[] = Object.keys(CONNECTORS);

export function resolveConnector(
  ctx: vscode.ExtensionContext,
  log: (m: string) => void,
): TaskConnector {
  const id = getConfig().taskSource;
  // `Object.hasOwn`, not `CONNECTORS[id]`: `taskSource` comes from settings.json
  // and can be any string, including a prototype key like "constructor" — which a
  // bare index resolves to a truthy non-factory that would then be called.
  if (!Object.hasOwn(CONNECTORS, id)) {
    log(`taskSource "${id}" is not a known connector — falling back to jira`);
    return CONNECTORS.jira(ctx);
  }
  return CONNECTORS[id](ctx);
}
