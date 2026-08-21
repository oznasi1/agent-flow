import * as React from "react";
import type { TicketKind } from "./helpers";
import { runKind } from "../types";

// Shared glyphs used across the sidebar's controls. One file so PlayIcon (used by
// both the Tasks tab's Take button and the Notepad's Start button) has a single
// home — Notepad.tsx importing it from App.tsx would be a circular import, since
// App.tsx is the one that renders <Notepad>.

export const PlayIcon = (): JSX.Element => (
  <svg className="take-icon" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M7 5.5v13a1 1 0 0 0 1.54.84l10-6.5a1 1 0 0 0 0-1.68l-10-6.5A1 1 0 0 0 7 5.5z" />
  </svg>
);

export const PenIcon = (): JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
    <path fill="currentColor" d="M11.6 2.6 14.4 5.4 5.8 14H3v-2.8z" />
  </svg>
);

export const TrashIcon = (): JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
    <path fill="currentColor" d="M6 1h4v1.2h3.6v1.3H2.4V2.2H6zM3.4 4.8h9.2l-.7 9.4a.9.9 0 0 1-.9.8H5a.9.9 0 0 1-.9-.8z" />
  </svg>
);

// A framed picture: a rectangle with a sun and a hill, the conventional shorthand
// for "image" at this size — a camera reads as "take a photo", which is not what
// the Attach button does.
export const ImageIcon = (): JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
    <path
      fill="currentColor"
      d="M1.6 2.4h12.8v11.2H1.6zm1.3 1.3v6.1l3-3 2.4 2.4 2.2-2.2 2.6 2.6V3.7zM5 4.6a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2z"
    />
  </svg>
);

// Ticket type glyphs. 12×12, currentColor, hue supplied by the .ty-<kind> rule in
// styles.ts. Shapes follow Jira's own vocabulary closely enough to be recognised
// without borrowing its icon URLs, which would be a network fetch per card and a
// widened webview CSP.
const TYPE_GLYPHS: Record<TicketKind, JSX.Element> = {
  story: <path fill="currentColor" d="M3 1.5h6a.5.5 0 0 1 .5.5v8.2a.3.3 0 0 1-.47.25L6 8.3l-3.03 2.15A.3.3 0 0 1 2.5 10.2V2a.5.5 0 0 1 .5-.5z" />,
  epic: <path fill="currentColor" d="M7.2 1 3 6.6h2.5L4.6 11 9 5.2H6.4L7.2 1z" />,
  task: (
    <>
      <rect fill="currentColor" x="1.5" y="1.5" width="9" height="9" rx="2" />
      {/* The check is cut with the editor ground rather than a second hue. The card
          sits 4% above that ground, a difference this 1.3px stroke does not show. */}
      <path
        d="M4 6.1l1.5 1.5L8.2 4.7"
        fill="none"
        stroke="var(--vscode-editor-background)"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  subtask: (
    <>
      <path d="M2.6 1.8v5.1a1.5 1.5 0 0 0 1.5 1.5h3" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect fill="currentColor" x="7.2" y="6.3" width="3.4" height="3.4" rx=".8" />
    </>
  ),
  // One path, two subpaths, evenodd: the centre is a real hole, so the glyph needs
  // no background colour to knock it out.
  bug: (
    <path
      fill="currentColor"
      fillRule="evenodd"
      d="M6 1.7a4.3 4.3 0 1 1 0 8.6 4.3 4.3 0 0 1 0-8.6zm0 2.6a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4z"
    />
  ),
  other: <rect x="1.9" y="1.9" width="8.2" height="8.2" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.2" />,
};

/** The ticket's kind, as a hued glyph. `label` is the source's raw type name — it
 * is what the accessible name and the tooltip say, so a custom type reads as
 * itself rather than as "other". */
export const TypeIcon = ({ kind, label }: { kind: TicketKind; label: string }): JSX.Element => (
  <span className={`ty ty-${kind}`} role="img" aria-label={`Type: ${label}`} title={`Type: ${label}`}>
    <svg width="12" height="12" viewBox="0 0 12 12">{TYPE_GLYPHS[kind]}</svg>
  </span>
);

/** What a Deck card is, as `runKind` reports it. Derived from the function rather
 * than restated, so a sixth kind cannot be added to `types.ts` without the
 * compiler demanding a glyph for it here. */
export type CardKind = ReturnType<typeof runKind>;

/** The kind in words. It is the accessible name and the tooltip: the glyph is the
 * only thing on the card that says which kind it is, so this is not decoration. */
export const CARD_KIND_LABEL: Record<CardKind, string> = {
  task: "Ticket",
  notepad: "Notepad note",
  explore: "Explore place",
  review: "PR review",
  local: "Untracked local place",
};

// Card-kind glyphs. 14×14 in a 16-unit box, currentColor, hue supplied by the
// .av.k-<kind> rule in deckStyles.ts. Same reasoning as TYPE_GLYPHS above: inline
// SVG rather than image assets, so there is no asWebviewUri plumbing and no
// widened CSP for what amounts to five shapes.
const CARD_KIND_GLYPHS: Record<CardKind, JSX.Element> = {
  // A tag: the tracked thing on the other end of the card.
  task: (
    <path
      fill="currentColor"
      d="M7.6 2H13a1 1 0 0 1 1 1v5.4a1 1 0 0 1-.29.71l-5 5a1 1 0 0 1-1.42 0L2.29 9.11a1 1 0 0 1 0-1.42l5-5A1 1 0 0 1 7.6 2zm3.15 1.9a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3z"
    />
  ),
  // A written-on page. One path, evenodd: the ruled lines are real holes, so the
  // glyph needs no second colour to knock them out.
  notepad: (
    <path fill="currentColor" fillRule="evenodd" d="M3.4 1.8h9.2v12.4H3.4zm1.6 2.4v1.3h6V4.2zm0 3v1.3h6V7.2zm0 3v1.3h3.6v-1.3z" />
  ),
  // A magnifier: an Explore run is a question, not a change.
  explore: (
    <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="6.9" cy="6.9" r="4.1" />
      <path d="M10.1 10.1l3.3 3.3" />
    </g>
  ),
  // Two nodes joining a third — the same fork git hosts use for a pull request.
  review: (
    <g fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="4.3" cy="4" r="1.9" />
      <circle cx="4.3" cy="12" r="1.9" />
      <circle cx="11.7" cy="8" r="1.9" />
      <path d="M4.3 5.9v4.2M6.2 4h2.1a1.5 1.5 0 0 1 1.5 1.5v1" strokeLinecap="round" />
    </g>
  ),
  // A pin: a place on this machine, discovered rather than launched.
  local: (
    <path
      fill="currentColor"
      fillRule="evenodd"
      d="M8 1.6a4.5 4.5 0 0 1 4.5 4.5c0 3.1-4.5 8.3-4.5 8.3S3.5 9.2 3.5 6.1A4.5 4.5 0 0 1 8 1.6zm0 2.7a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z"
    />
  ),
};

/** What this card is, as a hued glyph in a neutral tile. Leads the Deck card and
 * the detail drawer's header, so a selected card and its detail open with the
 * same mark. */
export const CardKindIcon = ({ kind }: { kind: CardKind }): JSX.Element => (
  <span className={`av k-${kind}`} role="img" aria-label={CARD_KIND_LABEL[kind]} title={CARD_KIND_LABEL[kind]}>
    <svg width="14" height="14" viewBox="0 0 16 16">{CARD_KIND_GLYPHS[kind]}</svg>
  </span>
);
