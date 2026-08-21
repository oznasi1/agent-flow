import * as React from "react";
import { ReviewDetail, ReviewRequest, ReviewSort, ReviewVerb } from "../types";
import { linesChanged, sizeBucket } from "../engine/review/sort";
import { LoadingMark } from "./LoadingMark";

function age(ms: number): string {
  const d = Math.max(0, Math.round((Date.now() - ms) / 86_400_000));
  if (d >= 1) return `${d}d`;
  const h = Math.max(1, Math.round((Date.now() - ms) / 3_600_000));
  return `${h}h`;
}

/** Why the agent action might not do what you expect. Both of the row's launch
 * controls — the play button on the line and the labelled one inside the open
 * row — carry it, so it lives here rather than being written out twice and left
 * to drift. Neither control is disabled by it: the host explains on click. */
function notCheckedOut(repoName: string): string {
  return `${repoName} isn't checked out under your repos root — clicking will explain what to do`;
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
  /** A first search is in flight with nothing cached behind it. Renders the
   * header plus skeleton rows instead of the queue — see the strip's own doc
   * comment for why it renders at all with zero requests. */
  loading: boolean;
  collapsed: boolean;
  expanded: string | null;
  // Absent: never fetched (or not yet expanded). `null`: the host tried and the
  // per-PR detail call failed. A real ReviewDetail: it succeeded. The row needs
  // all three — collapsing failure into "still loading" is what left a failed
  // fetch showing "loading…" forever.
  details: Record<string, ReviewDetail | null>;
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
  /** Selection mode — the batch. Every one of these is optional, and absent means
   *  the strip the Deck shipped before batches existed: no `select` control, no
   *  checkboxes, no bar, and a row click that expands exactly as it always did.
   *  `onSelectMode` is the one that gates the control, so a host that supplies
   *  nothing renders byte-identically. */
  selecting?: boolean;
  selected?: string[];
  onSelectMode?: (next: boolean) => void;
  /** `shift` is passed through rather than resolved here: extending a range needs
   *  the queue order and the last-toggled anchor, both of which live in the host. */
  onToggle?: (id: string, shift: boolean) => void;
  onSelectAll?: () => void;
  onLaunchBatch?: () => void;
}

function Row({ r, expanded, detail, reviewWrites, body, submitting, submitFailed, selecting, picked, onToggle, onExpand, onOpen, onLaunch, onLoadDraft, onBody, onSubmit }: {
  r: ReviewRequest;
  expanded: boolean;
  selecting: boolean;
  picked: boolean;
  onToggle: (id: string, shift: boolean) => void;
  detail: ReviewDetail | null | undefined;
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
    <div className={`rv-row ${expanded ? "open" : ""}${picked ? " picked" : ""}`}>
      {/* The head is its own line because the row also holds .rv-detail when it is
          open: the two controls below have to sit side by side, and .rv-detail has
          to sit under both of them, which one flex container cannot do. */}
      <div className="rv-head">
        {/* One button, two jobs: while selecting, the whole line is the checkbox.
            .rv-line is itself a <button>, and a button cannot nest inside one, so the
            box is a <span> and the click is branched here rather than added beside. */}
        <button
          type="button"
          className="rv-line"
          onClick={(e) => (selecting ? onToggle(r.id, e.shiftKey) : onExpand(r.id))}
          aria-pressed={selecting ? picked : undefined}
        >
          {selecting
            ? <span className={`rv-chk${picked ? " on" : ""}`}>{picked ? "✓" : ""}</span>
            : <span className="rv-caret">{expanded ? "▾" : "▸"}</span>}
          {/* Fixed-width and ellipsised (see deckStyles) so every row's title starts
              at the same x — repo names run from 7 to 20+ characters, and the ragged
              left edge landed on the one field anybody actually reads. The title
              attribute is what makes a truncated name recoverable. */}
          <span className="rv-repo" title={r.repoName}>{r.repoName}</span>
          <span className="rv-num">#{r.number}</span>
          <span className="rv-title" title={r.title}>{r.title}</span>
          {r.runKey && <span className="rv-running">reviewing</span>}
          {r.isDraft && <span className="rv-draft">draft</span>}
          {/* The agent's findings, waiting to be read — NOT r.isDraft above, which is
              the PR's own draft state on the forge. Open the row to load it. */}
          {r.draftPath && <span className="rv-ready">review ready</span>}
          <span className={`rv-size s-${sizeBucket(linesChanged(r))}`}>{sizeBucket(linesChanged(r))}</span>
          {/* Three separate text nodes, not one interpolated string: each is then a
              single queryable element, and the +/− keep the card chips' colours. The
              wrapper makes the pair one fixed-width column — sized individually they
              were two ragged ones, since "+3923 −1998" and "+106 −0" share no width. */}
          <span className="rv-diff">
            <span className="add">+{r.additions}</span>
            <span className="del">−{r.deletions}</span>
          </span>
          <span className="rv-files">{r.changedFiles} files</span>
          <span className={`rv-ci ${ci.cls}`}>{ci.text}</span>
          <span className="rv-author" title={r.author}>@{r.author}</span>
          <span className="rv-age">{age(r.createdAt)}</span>
        </button>
        {/* The agent action, without opening the row. A SIBLING of .rv-line rather
            than a child, because .rv-line is itself a button: nested, its click
            would bubble straight into the row's own onExpand, so starting a review
            would always also expand the row.

            Mid-review the cell stops being a button rather than being a disabled
            one: the row already says "reviewing" beside it, and a dimmed play glyph
            reads as an action you could retry, which is not what a second worktree
            for the same PR would be. */}
        {/* Nothing launchable on the line while selecting: .rv-go starts ONE review and
            the bar starts the batch, and two competing launches in one gesture is how a
            half-built selection turns into a single review nobody asked for. */}
        {selecting ? null : r.runKey ? (
          <span className="rv-go busy">
            <LoadingMark size={12} />
          </span>
        ) : (
          <button
            type="button"
            className={`rv-go${r.localPath ? "" : " cold"}`}
            // The accessible name stays the bare action either way — the caveat is
            // a caveat, not a different action. The title is where it goes, which
            // is also where the expanded button already puts it.
            aria-label="Review with agent"
            title={r.localPath
              ? "Review with agent"
              : notCheckedOut(r.repoName)}
            onClick={() => onLaunch(r.id)}
          >
            ▶
          </button>
        )}
      </div>
      {/* A row cannot be both open and being picked — the click that would have
          expanded it is the click that selects it. */}
      {expanded && !selecting && (
        <div className="rv-detail">
          {/* The review decision and mergeability come from the row's own
              search-level facts (`r`), not from `detail` — they render whether
              the per-PR detail call is still pending, has failed, or has
              succeeded. Only the checks line itself depends on `detail`: three
              states, not two, so a failed fetch reads as "couldn't load
              checks" rather than "loading…" forever. */}
          <div className={`rv-facts${detail === undefined ? " dim" : ""}`}>
            {detail === undefined ? (
              <span>loading…</span>
            ) : detail === null ? (
              <span>couldn't load checks</span>
            ) : detail.failing.length > 0 ? (
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
            {detail && detail.unresolved !== null && detail.unresolved > 0 && (
              <><span className="rv-sep">·</span><span>{detail.unresolved} open</span></>
            )}
            <span className="rv-sep">·</span>
            <span className={r.mergeable === "conflicting" ? "pr-warn" : ""}>
              {r.mergeable === "conflicting" ? "conflicts" : r.mergeable}
            </span>
          </div>
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
              title={r.localPath ? `Review in a worktree of ${r.repoName}` : notCheckedOut(r.repoName)}
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
              // button alone doesn't say *why* — hence the title alongside each one.
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

/** Three skeleton rows, shaped like the real ones, while the first search runs.
 * Rows rather than a bare header: the strip then claims its height up front, so
 * the board settles once instead of being shoved down when the queue lands.
 * Three is a guess at the count and will sometimes be wrong — being wrong by a
 * row or two costs less than the full-height jump it avoids. */
function Skeleton(): JSX.Element {
  return (
    <div className="rv-rows">
      {[0, 1, 2].map((i) => (
        <div className="rv-row" key={i} aria-hidden="true">
          {/* Same head wrapper as a real row, minus the play button: nothing has
              been found yet, so there is nothing to launch a review of. */}
          <div className="rv-head">
            <div className="rv-line rv-skel">
              <span className="rv-caret">▸</span>
              <span className="sk sk-repo" />
              <span className="sk sk-title" />
              <span className="sk sk-meta" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** The queue of PRs waiting on you, above the board. Renders nothing at zero — an
 * empty rail over the columns is noise, and nothing else on the header shows a
 * review count for it to defer to. Two exceptions, both of which have something
 * to say that a bare zero cannot: `loading` (a first search is running, nothing
 * cached behind it) and `stale` (a search failed with nothing cached, so "0"
 * would be a lie). */
export function ReviewStrip(p: ReviewStripProps): JSX.Element | null {
  if (p.requests.length === 0 && !p.loading && !p.stale) return null;
  const shown = p.requests.length;
  const selecting = !!p.selecting;
  const picked = new Set(p.selected ?? []);
  const n = p.requests.filter((r) => picked.has(r.id)).length;
  // Only worth a header line in the plural: one row says "review ready" on itself,
  // and the header is where you look when the queue is longer than the screen.
  const ready = p.requests.filter((r) => r.draftPath).length;
  return (
    <div className="rv-strip">
      <div className="rv-hd">
        <button type="button" className="rv-toggle" onClick={() => p.onCollapse(!p.collapsed)}>
          {p.collapsed ? "▸" : "▾"}{" "}
          {p.loading
            ? "checking for PRs waiting on your review…"
            // Stale with nothing to show is a failed *first* search — there is no
            // count to state and no previous result to fall back on, so the count
            // and the "showing the last result" note below would both be lies.
            : p.stale && shown === 0
              ? "couldn't check for PRs waiting on your review"
              : `${p.issueCount} ${p.issueCount === 1 ? "PR" : "PRs"} waiting on your review`}
        </button>
        {p.loading && <LoadingMark size={12} />}
        {p.issueCount > shown && <span className="rv-note">showing {shown} of {p.issueCount}</span>}
        {p.stale && shown > 0 && <span className="rv-note warn">couldn't refresh — showing the last result</span>}
        {ready > 1 && <span className="rv-note">{ready} agent reviews ready</span>}
        <span className="sp" />
        {/* No sort control while loading: there is nothing to sort, and a live
            control over skeleton rows invites a click that changes nothing. */}
        {/* Opt-in, and only when the host can act on it: the rows stay as dense as they
            have always been until somebody asks to pick some. Styled as the sort
            buttons are, because it is the same kind of control. */}
        {!p.loading && p.onSelectMode && (
          <span className="rv-select">
            <button type="button" className={selecting ? "on" : ""} onClick={() => p.onSelectMode?.(!selecting)}>select</button>
            <span className="rv-sep">·</span>
          </span>
        )}
        {!p.loading && (
          <span className="rv-sort">
            sort:{" "}
            <button type="button" className={p.sort === "oldest" ? "on" : ""} onClick={() => p.onSort("oldest")}>oldest</button>
            <span className="rv-sep">·</span>
            <button type="button" className={p.sort === "smallest" ? "on" : ""} onClick={() => p.onSort("smallest")}>smallest</button>
          </span>
        )}
      </div>
      {p.loading && !p.collapsed && <Skeleton />}
      {!p.loading && !p.collapsed && (
        <div className="rv-rows">
          {p.requests.map((r) => (
            <Row key={r.id} r={r} expanded={p.expanded === r.id} detail={p.details[r.id]}
                 reviewWrites={p.reviewWrites} body={p.bodies[r.id] ?? ""}
                 submitting={!!p.submitting[r.id]} submitFailed={!!p.submitFailed[r.id]}
                 selecting={selecting} picked={picked.has(r.id)}
                 onToggle={(id, shift) => p.onToggle?.(id, shift)}
                 onExpand={p.onExpand} onOpen={p.onOpen} onLaunch={p.onLaunch} onLoadDraft={p.onLoadDraft}
                 onBody={p.onBody} onSubmit={p.onSubmit} />
          ))}
        </div>
      )}
      {/* The batch's one action, under the rows it acts on. Mirrors the sidebar's own
          batch bar so the two read as one feature. */}
      {selecting && !p.collapsed && (
        <div className="batch-bar">
          <span className="batch-count">{n} selected · shift-click for a range</span>
          <button type="button" className="batch-link" onClick={() => p.onSelectAll?.()}>Select all {shown}</button>
          <button type="button" className="batch-link" onClick={() => p.onSelectMode?.(false)}>Done</button>
          <button
            type="button"
            className="batch-launch"
            disabled={n === 0}
            // Unambiguous against .rv-go's own "Review with agent": both are on screen
            // in the same strip, and one accessible name for two different actions is
            // how a click lands on the wrong one.
            aria-label={`Review the ${n} selected PR${n === 1 ? "" : "s"} with agents`}
            onClick={() => p.onLaunchBatch?.()}
          >
            ▶ Review {n} with agent{n === 1 ? "" : "s"}
          </button>
        </div>
      )}
    </div>
  );
}
