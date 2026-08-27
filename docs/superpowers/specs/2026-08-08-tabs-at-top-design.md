# Tabs at the top of the sidebar panel

**Date:** 2026-08-08
**Surface:** the Tasks sidebar webview (`agentFlow.tasks`)

## Problem

Two things are wrong with the panel's head.

**The word "Tasks" is said twice.** VS Code's view title bar reads `TASKS`, and
directly beneath it the webview's own tab bar offers `Tasks | Notepad`. The title
bar is the more prominent of the two and names only one of the two tabs, so the
panel appears to be the Tasks panel with a notepad bolted on, rather than a panel
with two equal views.

**The Notepad's fields focus differently from every other field in the product.**
`.np-title-input` and `.np-body-input` carry a transparent resting border, so a
focused field falls through to the global `:focus-visible` rule in `tokens.ts` —
a 1px outline sitting 2px clear of the field, at a 4px radius against the field's
own 6px. Every other text input (`.text-search input`, `.repo-search input`)
suppresses that outline and moves focus onto its container's border instead. The
notepad is the only place in the panel where a focused field grows a detached
halo.

## Design

### 1. The view title carries the identity

`WebviewView.title` and `.description` are ours to set; they default to the
`package.json` contribution. Point them at the project and the signed-in user:

```
title       = <project key>   e.g. "PROJ"     (falls back to "Tasks")
description = <display name>  e.g. "Oz Nasi" (absent when signed out)
```

The identity row then leaves the webview entirely, and `Tasks | Notepad` becomes
the first thing in the panel's own content. The top bar stops naming one tab, and
the panel is one row shorter on both tabs.

`postState()` is the only place this belongs. It already computes both values —
`this.connector.info().scopeValue` and the `me` it is passed — and it re-runs on
every auth, config, and refresh change, so the title tracks them with no second
code path to keep in sync. The webview requests state on mount, so the assignment
always lands after `resolveWebviewView` and never races it.

The `"Tasks"` fallback is not cosmetic: on an unconfigured first run there is no
project key, and a blank title bar holding three floating action icons reads as a
rendering failure. `description` has no such problem — absent is a normal state
for it — so it is simply omitted when `me` is null.

### 2. The tab bar becomes the pane's first row

The `.header` block (gauge, project name, Explore, user) is removed. Its two
surviving controls move into a trailing group on the tab row:

```
Tasks  Notepad ....................... ◌  ◎ Explore
```

Both stay visible on both tabs. Explore starts a Claude Code session against
repos with no ticket involved, so it is not a Tasks-only action; the gauge counts
open Agent Flow windows, which is equally true whichever tab is showing.

Tab labels step from `--t-body` to `--t-title`. These tabs are now the pane's
title element, not a control sitting under one, and should be weighted as such —
subject to a width check at a 280px sidebar, below.

**Width constraint.** At 280px the row must hold both labels, the gauge, and the
Explore button without wrapping or clipping. If `--t-title` does not fit, the
labels stay at `--t-body`; the tab bar must not be allowed to wrap, because a
wrapped tab bar stops reading as one control. This is settled by measurement in
the preview harness before the CSS is final, not by judgement.

### 3. The Notepad fields join the house focus style

```css
.np-title-input, .np-body-input {
  border: 1px solid var(--vscode-input-border, var(--hair));
}
.np-title-input:focus, .np-body-input:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
}
```

The resting hairline is load-bearing. Without it the border materializes out of
nothing on focus, which reads as the field jumping rather than lighting up. Both
classes are shared with a note row's edit state, so the fix reaches every field
in the Notepad, not just the add form.

## Out of scope

- The Deck and Marketplace surfaces. Neither has this tab bar.
- Migrating `styles.ts`'s remaining off-scale font-size literals. The type-scale
  guard grandfathers them, and touching them here would bury this change.
- Any change to what the tabs do, what the Notepad stores, or how Explore behaves.

## Testing

- `postState` sets title and description from the connector's scope value and the
  `me` it is passed; the title falls back to `"Tasks"` with no scope value, and
  the description is cleared when `me` is null.
- The tab row renders the gauge and Explore on both tabs, and the project name
  and user name no longer appear in the webview DOM.
- Existing `App.test.tsx` assertions for the project/user header (lines 61-71)
  move to the tab row and the view title.
- The focus rule is asserted in `tokens.test.ts` alongside the other sheet
  guards: both notepad field classes suppress the outline and set
  `border-color` to `--vscode-focusBorder` on `:focus`.

## Gates

`npm run typecheck`, `npm test`, `npm run build`, and `npm run test:cov`
thresholds all clean. A CHANGELOG entry under `## [Unreleased]`.

`npm run build` is not optional here: `src/webview/` must not import `fs`, `os`,
`path`, or `child_process` even transitively, and the build is the only gate that
catches it — `tsc` and the full suite pass regardless.
