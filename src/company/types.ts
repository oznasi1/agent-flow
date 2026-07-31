// Shapes shared by the queue store, the HTTP routes and the board page.
// `kind` and `artifact.type` are plain strings on purpose: the spec requires an
// unknown kind to render as text rather than fail validation, so new kinds can
// appear without a code change.

export const KNOWN_KINDS = ["code", "spec", "copy", "mockup", "reply", "release"] as const;
export type KnownKind = (typeof KNOWN_KINDS)[number];

export const ARTIFACT_TYPES = ["diff", "markdown", "html", "text"] as const;
export type KnownArtifactType = (typeof ARTIFACT_TYPES)[number];

export const RISKS = ["safe", "gated"] as const;
export type Risk = (typeof RISKS)[number];

export const VERDICTS = ["approve", "reject", "revise"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface Artifact {
  /** One of ARTIFACT_TYPES when known; anything else renders as text. */
  type: string;
  /** Repo-relative or absolute path to the artifact's content. */
  path?: string;
  /** Content carried in the item itself, when there is no file. */
  inline?: string;
}

export interface Checks {
  typecheck?: string;
  test?: string;
  coverage?: string;
}

export interface QueueItem {
  id: string;
  cycle: string;
  role: string;
  kind: string;
  title: string;
  why: string;
  artifact: Artifact;
  risk: Risk;
  on_approve: string;
  branch?: string;
  checks?: Checks;
}

export interface LandedRecord {
  id: string;
  cycle: string;
  role: string;
  title: string;
  sha: string;
  landed_at: string;
}

export interface Decision {
  id: string;
  verdict: Verdict;
  note: string;
  at: string;
}

/** A queue file that could not be understood. Surfaced, never silently dropped. */
export interface Quarantined {
  file: string;
  error: string;
}
