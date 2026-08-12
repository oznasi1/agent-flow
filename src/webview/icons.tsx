import * as React from "react";
import type { TicketKind } from "./helpers";

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
