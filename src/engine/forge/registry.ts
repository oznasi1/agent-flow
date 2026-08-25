import type { Runner } from "../pr/provider";
import { makeBitbucketForge } from "./bitbucket";
import { makeGithubForge } from "./github";
import { makeGitlabForge } from "./gitlab";
import type { Forge } from "./types";

/** Every forge Agent Flow can read from. Adding one is this line plus a file —
 * see docs/FORGES.md. */
const FORGES: Record<string, (run?: Runner) => Forge> = {
  github: makeGithubForge,
  gitlab: makeGitlabForge,
  bitbucket: makeBitbucketForge,
};

/** The registered ids. Exported so the telemetry snapshot's allowlist and the
 * manifest-parity test both derive from the registry instead of a hand-written
 * literal that would report a contributor's forge as "invalid" forever. */
export const FORGE_IDS: string[] = Object.keys(FORGES);

export function resolveForge(id: string, log: (m: string) => void, run?: Runner): Forge {
  // `Object.hasOwn`, not `FORGES[id]`: `agentFlow.forge` comes from settings.json
  // and can be any string, including a prototype key like "constructor" — which a
  // bare index resolves to a truthy non-factory that would then be called.
  if (!Object.hasOwn(FORGES, id)) {
    log(`forge "${id}" is not a known forge — falling back to github`);
    return FORGES.github(run);
  }
  return FORGES[id](run);
}
