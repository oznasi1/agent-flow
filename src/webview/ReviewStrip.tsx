import * as React from "react";
import { ReviewDetail, ReviewRequest, ReviewSort, ReviewVerb } from "../types";
import { linesChanged, sizeBucket } from "../engine/review/sort";

function age(ms: number): string {
  const d = Math.max(0, Math.round((Date.now() - ms) / 86_400_000));
  if (d >= 1) return `${d}d`;
  const h = Math.max(1, Math.round((Date.now() - ms) / 3_600_000));
  return `${h}h`;
}

const CI_GLYPH: Record<ReviewRequest["ci"], { text: string; cls: string }> = {
  passing: { text: "✓", cls: "pr-ok" },
  failing: { text: "✗", cls: "pr-bad" },
  pending: { text: "·", cls: "pr-wait" },
  none: { text: "", cls: "" },
};

export interface ReviewStripProps {
  requests: ReviewRequest[];
  issueCount: number;
  sort: ReviewSort;
  stale: boolean;
  collapsed: boolean;
  expanded: string | null;
  details: Record<string, ReviewDetail>;
  reviewWrites: boolean;
  bodies: Record<string, string>;
  /** Mid-flight for this id: a submit has been posted and no
   * `deck:reviewSubmitDone` has come back for it yet — the only message that
   * releases this, since neither a toast nor a routine `deck:reviews` poll
   * carries this id or means "this row's submit is over". UX only — the
   * host's own per-id guard is what actually stops a duplicate write; this
   * just keeps a double-click from ever reaching two confirmation dialogs. */
  submitting: Record<string, boolean>;
  /** The last submit for this id came back as a failure. Shown as an inline
   * line rather than folded into the failure toast, because a submit killed by
   * the host's 10s timeout may already have landed on GitHub — the point is to
   * make a repeat an informed click, not to block it. */
  submitFailed: Record<string, boolean>;
  onCollapse: (next: boolean) => void;
  onExpand: (id: string) => void;
  onSort: (sort: ReviewSort) => void;
  onOpen: (url: string) => void;
  onLaunch: (id: string) => void;
  onLoadDraft: (id: string) => void;
  onBody: (id: string, body: string) => void;
  onSubmit: (id: string, verb: ReviewVerb) => void;
}

function Row({ r, expanded, detail, reviewWrites, body, submitting, submitFailed, onExpand, onOpen, onLaunch, onLoadDraft, onBody, onSubmit }: {
  r: ReviewRequest;
  expanded: boolean;
  detail: ReviewDetail | undefined;
  reviewWrites: boolean;
  body: string;
  submitting: boolean;
  submitFailed: boolean;
  onExpand: (id: string) => void;
  onOpen: (url: string) => void;
  onLaunch: (id: string) => void;
  onLoadDraft: (id: string) => void;
  onBody: (id: string, body: string) => void;
  onSubmit: (id: string, verb: ReviewVerb) => void;
}): JSX.Element {
  const ci = CI_GLYPH[r.ci];
  return (
    <div className={`rv-row ${expanded ? "open" : ""}`}>
      <button type="button" className="rv-line" onClick={() => onExpand(r.id)}>
        <span className="rv-caret">{expanded ? "▾" : "▸"}</span>
        <span className="rv-repo">{r.repoName}</span>
        <span className="rv-num">#{r.number}</span>
        <span className="rv-title" title={r.title}>{r.title}</span>
        {r.runKey && <span className="rv-running">reviewing</span>}
        {r.isDraft && <span className="rv-draft">draft</span>}
        <span className={`rv-size s-${sizeBucket(linesChanged(r))}`}>{sizeBucket(linesChanged(r))}</span>
        {/* Three separate text nodes, not one interpolated string: each is then a
            single queryable element, and the +/− keep the card chips' colours. */}
        <span className="add">+{r.additions}</span>
        <span className="del">−{r.deletions}</span>
        <span className="rv-files">{r.changedFiles} files</span>
        <span className={`rv-ci ${ci.cls}`}>{ci.text}</span>
        <span className="rv-author">@{r.author}</span>
        <span className="rv-age">{age(r.createdAt)}</span>
      </button>
      {expanded && (
        <div className="rv-detail">
          {detail ? (
            <div className="rv-facts">
              {detail.failing.length > 0 ? (
                <span className="pr-bad">✗ {detail.failing.map((c, i) => (
                  <React.Fragment key={c.name}>
                    {i > 0 && ", "}
                    {c.url
                      ? <button type="button" className="pr-link" title={c.url} onClick={() => onOpen(c.url)}>{c.name}</button>
                      : <span>{c.name}</span>}
                  </React.Fragment>
                ))}</span>
              ) : (
                <span className="pr-ok">✓ checks passing</span>
              )}
              <span className="rv-sep">·</span>
              <span>{r.review === "changes_requested" ? "changes requested" : r.review === "approved" ? "approved" : "review required"}</span>
              {detail.unresolved !== null && detail.unresolved > 0 && (
                <><span className="rv-sep">·</span><span>{detail.unresolved} open</span></>
              )}
              <span className="rv-sep">·</span>
              <span className={r.mergeable === "conflicting" ? "pr-warn" : ""}>
                {r.mergeable === "conflicting" ? "conflicts" : r.mergeable}
              </span>
            </div>
          ) : (
            <div className="rv-facts dim">loading…</div>
          )}
          {reviewWrites && (
            <div className="rv-box">
              <textarea
                value={body}
                placeholder="Leave a message… (required for Comment and Request changes)"
                onChange={(e) => onBody(r.id, e.target.value)}
              />
            </div>
          )}
          <div className="rv-actions">
            <button
              type="button"
              className="act primary"
              disabled={!r.localPath}
              title={r.localPath ? `Review in a worktree of ${r.repoName}` : `${r.repoName} is not checked out locally`}
              onClick={() => onLaunch(r.id)}
            >
              ▶ Review with agent
            </button>
            {r.draftPath && (
              <button type="button" className="act" onClick={() => onLoadDraft(r.id)}>Load agent's review</button>
            )}
            <button type="button" className="act" onClick={() => onOpen(r.url)}>Open PR</button>
            {reviewWrites && (() => {
              // Disabled now looks disabled (see deckStyles.ts), but a dimmed
              // button alone doesn't say *why* — the same reasoning "Review with
              // agent" above already gives a title for its own disabled state.
              const busyTitle = submitting ? "A submit for this PR is already in progress." : null;
              const emptyTitle = !body.trim() ? "Add a message first." : null;
              return (
                <>
                  <button type="button" className="act" disabled={submitting} title={busyTitle ?? undefined} onClick={() => onSubmit(r.id, "approve")}>Approve</button>
                  <button type="button" className="act" disabled={submitting || !body.trim()} title={busyTitle ?? emptyTitle ?? undefined} onClick={() => onSubmit(r.id, "comment")}>Comment</button>
                  <button type="button" className="act" disabled={submitting || !body.trim()} title={busyTitle ?? emptyTitle ?? undefined} onClick={() => onSubmit(r.id, "request-changes")}>Request changes</button>
                </>
              );
            })()}
          </div>
          {/* GitHub does not dedupe reviews, and a submit killed by the host's 10s
              timeout may already have gone through — so a failure gets a line of its
              own rather than just an enabled retry button. Complements the failure
              toast's own "Open PR" action rather than repeating its wording. */}
          {reviewWrites && submitFailed && (
            <div className="rv-fail">This may already have gone through — check the PR before trying again.</div>
          )}
        </div>
      )}
    </div>
  );
}

/** The queue of PRs waiting on you, above the board. Renders nothing at zero — an
 * empty rail over the columns is noise; the header's "To review" stat carries the
 * zero instead. */
export function ReviewStrip(p: ReviewStripProps): JSX.Element | null {
  if (p.requests.length === 0) return null;
  const shown = p.requests.length;
  return (
    <div className="rv-strip">
      <div className="rv-hd">
        <button type="button" className="rv-toggle" onClick={() => p.onCollapse(!p.collapsed)}>
          {p.collapsed ? "▸" : "▾"} {p.issueCount} {p.issueCount === 1 ? "PR" : "PRs"} waiting on your review
        </button>
        {p.issueCount > shown && <span className="rv-note">showing {shown} of {p.issueCount}</span>}
        {p.stale && <span className="rv-note warn">couldn't refresh — showing the last result</span>}
        <span className="sp" />
        <span className="rv-sort">
          sort:{" "}
          <button type="button" className={p.sort === "oldest" ? "on" : ""} onClick={() => p.onSort("oldest")}>oldest</button>
          <span className="rv-sep">·</span>
          <button type="button" className={p.sort === "smallest" ? "on" : ""} onClick={() => p.onSort("smallest")}>smallest</button>
        </span>
      </div>
      {!p.collapsed && (
        <div className="rv-rows">
          {p.requests.map((r) => (
            <Row key={r.id} r={r} expanded={p.expanded === r.id} detail={p.details[r.id]}
                 reviewWrites={p.reviewWrites} body={p.bodies[r.id] ?? ""}
                 submitting={!!p.submitting[r.id]} submitFailed={!!p.submitFailed[r.id]}
                 onExpand={p.onExpand} onOpen={p.onOpen} onLaunch={p.onLaunch} onLoadDraft={p.onLoadDraft}
                 onBody={p.onBody} onSubmit={p.onSubmit} />
          ))}
        </div>
      )}
    </div>
  );
}
