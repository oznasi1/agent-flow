import * as React from "react";
import type { TicketKind } from "./helpers";
import { runKind, type AgentProvider } from "../types";

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

// The overflow kebab — VS Code's own "More Actions…" glyph, so the Notepad's
// menu trigger reads as the same control the view title bar already carries.
export const DotsIcon = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path fill="currentColor" d="M4 8a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm5 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm5 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0z" />
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

export const PROVIDER_LABEL: Record<AgentProvider, string> = {
  "claude-code": "Claude Code",
  copilot: "GitHub Copilot",
  cursor: "Cursor",
};

// The three agents' own marks, one monochrome path each in a 24-unit box, drawn in
// currentColor — the same treatment CARD_KIND_GLYPHS uses above, and for the same
// reasons: no image assets, no asWebviewUri plumbing, no widened CSP.
//
// The path data is Simple Icons' rendition of each mark (CC0). The marks themselves are
// trademarks of Anthropic, GitHub and Anysphere and appear here nominatively, to say
// which tool is driving a run — nothing more.
const PROVIDER_GLYPHS: Record<AgentProvider, JSX.Element> = {
  "claude-code": (
    <path fill="currentColor" d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
  ),
  copilot: (
    <path fill="currentColor" d="M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z" />
  ),
  cursor: (
    <path fill="currentColor" d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
  ),
};

/** What this card IS, as a hued glyph in a neutral tile, with the tool driving it on the
 * tile's corner. Leads the Deck card and the detail drawer's header, so a selected card
 * and its detail open with the same mark. The kind keeps the tile: it is the card's
 * identity, and the provider is a fact about it. */
export const CardKindIcon = ({ kind, provider }: {
  kind: CardKind;
  provider?: AgentProvider | null;
}): JSX.Element => {
  const label = provider ? `${CARD_KIND_LABEL[kind]} · ${PROVIDER_LABEL[provider]}` : CARD_KIND_LABEL[kind];
  return (
    <span className={`av k-${kind}`} role="img" aria-label={label} title={label}>
      <svg width="14" height="14" viewBox="0 0 16 16">{CARD_KIND_GLYPHS[kind]}</svg>
      {provider && (
        <span className={`pv p-${provider}`} title={PROVIDER_LABEL[provider]}>
          <svg width="11" height="11" viewBox="0 0 24 24">{PROVIDER_GLYPHS[provider]}</svg>
        </span>
      )}
    </span>
  );
};
