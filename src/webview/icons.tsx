import * as React from "react";

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
