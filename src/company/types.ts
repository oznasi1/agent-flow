// Shapes shared by the queue store, the HTTP routes and the board page.
// `kind` and `artifact.type` are plain strings on purpose: the spec requires an
// unknown kind to render as text rather than fail validation, so new kinds can
// appear without a code change. There is deliberately no union of the known
// values here — nothing would validate against it, and an unused one only
// invites someone to start enforcing it.

export const RISKS = ["safe", "gated"] as const;
export type Risk = (typeof RISKS)[number];

export const VERDICTS = ["approve", "reject", "revise"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface Artifact {
  /** "diff", "markdown", "html" or "text" when known; anything else renders as text. */
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

/**
 * One line of the append-only decision log.
 *
 * The four original fields are joined by nothing but `id`, which is why the
 * record was widened after review: `archive/{id}.json` is the only place the
 * decided content lived, ids are not unique across cycles, and an archive entry
 * can be lost. A line has to be able to reconstruct what was judged on its own.
 *
 * The widened fields are optional because the log is append-only and lines
 * written before the change do not carry them — `readDecisions` must keep
 * parsing those, not reject them.
 */
export interface Decision {
  id: string;
  verdict: Verdict;
  note: string;
  at: string;
  /** The cycle the decided item belonged to. */
  cycle?: string;
  /** The role that proposed it. */
  role?: string;
  /** Its title, so a line reads as a decision rather than an identifier. */
  title?: string;
  /**
   * sha256 hex digest of the resolved artifact content the reviewer was shown —
   * the truncated text as rendered, not the file on disk. Absent when the
   * artifact could not be resolved at all, which is itself decidable: the
   * reviewer saw the error and may well have rejected it for that.
   */
  artifactSha256?: string;
}

/** A queue file that could not be understood. Surfaced, never silently dropped. */
export interface Quarantined {
  file: string;
  error: string;
}
