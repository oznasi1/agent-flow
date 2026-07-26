# The Marketplace — category sections, plugin multi-select, file preview — design

**Date:** 2026-07-26
**Status:** Approved pending user review
**Area:** `src/webview/MarketplaceApp.tsx`, `src/webview/marketplaceStyles.ts`, `src/marketplaceView.ts`,
`src/engine/claudeAssets.ts`, `src/types.ts`; adds `src/engine/markdown.ts`; touches `README.md`,
`CHANGELOG.md`

## Problem

The Marketplace ships one grouping axis and two single-select filters. On a representative machine that
leaves **353 assets across 85 plugins** behind a flat list whose only structure is four type headers —
Skills, Commands, Agents, Hooks — which say nothing about what a thing is *for*. Scrolling the Commands
tab surfaces `/modernize-map` next to `/commit` next to `/ci-gate` with no way to narrow to a domain.

Two gaps behind that:

1. **No way to narrow to a subject area.** Type is not a subject. A user hunting for deploy tooling has
   to read 353 descriptions.
2. **No way to narrow to a set of plugins.** The type pills include a `Plugins` tab, but it *replaces*
   the asset list rather than filtering it. There is no "show me everything from superpowers and
   cicd-plugin".

Third, unrelated but in the same pane: **the detail column is mostly empty.** A selected asset fills
roughly the top sixth of it — name, three tags, a description line, two key/value rows, a copy snippet,
two buttons — and the remaining height is blank, while the file those fields describe sits unread on
disk one `Open file` click away.

## Goals

- **Group the browse list by subject**, using a taxonomy that is real rather than invented.
- **Filter by several plugins at once**, with both a browsable picker and a one-click path from a row.
- **Fill the detail pane with the asset's own content**, rendered, without leaving the panel.

## Non-goals (YAGNI)

- **No content search.** The scan stays metadata-only; file bodies load per selection, never for ranking.
- **No category editing, overrides, or local re-tagging.** The manifest is the only source.
- **No multi-select on category.** Sections are the affordance, and a section header has no natural
  gesture for "and also that one". Plugins are the multi-select dimension.
- **No persistence of filter state** across panel reloads.
- **No full CommonMark.** A documented subset, with unrecognised syntax falling through as literal text.
- Still no mutation of `~/.claude`, no network, no `fs.watch`.

## Decisions

1. **Categories come from the manifest `category` field, verbatim** — not from a curated bucket list and
   not inferred from keywords. The ecosystem already publishes this field and it is well populated;
   inventing a mapping would drift as new categories appear, and inferring the gaps would produce
   unexplainable, sometimes-wrong labels. An honestly unlabelled plugin beats a confidently mislabelled
   one.
2. **Category is the browse list's grouping axis**, replacing the type headers. Type is already a pill
   row; being both a pill and a header was redundant.
3. **Section headers are the category filter.** Clicking one focuses that category. No third pill row.
4. **Plugin multi-select is a searchable dropdown plus click-a-row-to-add**, with removable chips.
5. **The detail block compacts and the rendered file fills the rest of the pane** — no tabs, no
   disclosure. Both are visible at once with nothing to click.
6. **Markdown is parsed to a token tree and rendered as React elements**, never via
   `dangerouslySetInnerHTML`.

## Data model

`scanClaudeAssets` already reads each plugin entry out of `marketplace.json`; `p.category` sits there
unused. Two field additions, both following the existing grain — assets already duplicate `plugin`,
`marketplace`, `state` and `enabled` from their plugin row, so carrying `category` the same way avoids a
join at render time:

```ts
interface AssetView   { …; category: string }
interface PluginRowView { …; category: string; readme: string }
```

`readme` is the absolute path to `<contentDir>/README.md` when that file exists, else `""`. It joins the
host's openable allow-list alongside asset paths.

Three values get names rather than a raw manifest string:

| Source | `category` value | Section label |
|---|---|---|
| `~/.claude` or the workspace | `"yours"` | **Yours** |
| plugin with no `category` in its manifest | `"uncategorized"` | **Uncategorized** |
| anything else | the manifest string | title-cased for display only |

Title-casing is presentation-only; filtering compares the raw value.

### What the taxonomy actually looks like here

Over the 85 plugins that have content on disk (the ones contributing the 353 assets):

```
development 29 · uncategorized 27 · productivity 19
security 2 · learning 2 · design 2 · database 1 · math 1 · testing 1 · deployment 1
```

**26 of the 27 uncategorized plugins are `atbay-plugins`**, whose manifest declares only `name`,
`source`, `description`. Adding one `category` line per plugin in that repo would collapse the largest
muddy bucket this UI has. That is a change to a different repo and is out of scope here, but it is the
single highest-leverage follow-up.

## Sections

Order: **Yours** first, then categories by descending asset count, **Uncategorized** last.

No minimum-size merging into an "Other" bucket. A two-row section is fine in a scrolling list, and
merging would hide categories that genuinely exist while adding a threshold nobody can predict.

Grouping applies whenever the query is empty, on **any** type filter — the Skills tab gets category
sections too, not only All. A non-empty query still produces a flat relevance-ranked list with no
headers, unchanged: ranked results would put a header above nearly every row.

When a category is focused its section header is not rendered — the chip row already says which category
you are in.

Section header counts reflect every dimension except category.

## Filters

Six dimensions, AND-ed: query, type, scope, category, plugins, marketplaces.

**Plugins ▾** sits next to the scope pills and shows the selected count when non-zero. It opens a panel
with a filter input and a checkbox list of every plugin that has at least one asset surviving the other
five dimensions, ordered by asset count descending. Already-selected plugins stay listed even at zero, so
a selection is never stranded out of reach of its own checkbox. Clicking a plugin name in any result row
toggles the same selection.

Under the `Plugins` type tab the rows *are* plugins, so the plugin selection filters them by name and the
type dimension is a no-op against itself.

**The chip row** appears below the pills only when something is selected: the focused category, each
selected plugin, each selected marketplace, and a **Clear** action. Absent at rest, so the panel gains no
chrome when unused.

**The marketplace tag row** — currently decorative — becomes clickable using the same chip mechanism,
multi-select, matching an asset's `marketplace` field. Near-zero extra code for the only inert control in
the bar.

Type pill counts recompute against every other dimension, the way they already do for query and scope, so
the numbers move as you narrow.

Changing any filter resets the keyboard selection index to 0, matching current behaviour.

## The preview pane

### Layout

The detail block tightens: glyph and name, tag row, description, a two-line `Where`/`File` grid, the copy
snippet, the action buttons. Then a hairline, then the rendered file taking all remaining height with its
own scroll. The metadata stops being the pane and becomes a caption for it.

### Loading

New message pair:

```ts
// webview → host
{ type: "mkt:read"; file: string }
// host → webview
{ type: "mkt:file"; file: string; text: string; truncated: boolean }
```

The host reuses the `openable` allow-list that already guards open and reveal, so the webview still
cannot talk it into reading an arbitrary path. Files over **256 KB** return truncated at that boundary
with `truncated: true`, and the pane shows a "truncated — Open file for the rest" footer.

Contents are not part of the scan payload: 353 markdown bodies would bloat every rescan, and the panel
rescans on refocus. They load per selection into a bounded `Map<file, text>` in the webview — 50 entries,
oldest evicted — so arrow-keying through a list does not re-round-trip. A rescan clears the cache.

While a read is in flight the pane shows a placeholder line rather than the previous asset's content.

### What each row previews

| Row kind | Source | Treatment |
|---|---|---|
| skill / command / agent | its `.md` | markdown, frontmatter block hidden — the detail above already shows name and description |
| hook | its `hooks.json` | rendered as a fenced JSON code block |
| plugin | `README.md` in its content dir | markdown; empty state when the plugin isn't on disk |

A row whose file cannot be read shows the empty state, not an error toast — an unreadable file already
degrades to an empty entry elsewhere in the scan.

### Rendering

`src/engine/markdown.ts` is a pure function from source text to a token tree. React walks the tree and
emits elements. **No `dangerouslySetInnerHTML` anywhere in the path.** This is third-party content from
arbitrary marketplaces; building the DOM from a typed tree makes injection structurally impossible rather
than dependent on a sanitizer being correct and correctly configured. It also keeps the parser in
`engine/` — pure, fixture-testable, no `vscode` or `fs` import — which is how the rest of this codebase is
built, and adds no runtime dependency.

Covered: ATX headings, paragraphs, fenced code, inline code, bold, italic, links, ordered and unordered
lists, blockquotes, horizontal rules, pipe tables.

Everything else falls through as literal text — a file renders plainer than its author intended, never
wrongly. Raw HTML in the source is escaped and displayed as text. Links with an `http` or `https` scheme
route through the existing `openExternal` message; every other scheme, including `file:` and
`javascript:`, renders as inert text.

## Testing

Engine tests carry the bulk, over `memReader` fixture trees and a fixture corpus:

- category derivation: manifest value, missing value, user and workspace assets, `readme` resolution
- section ordering: Yours first, count-descending middle, Uncategorized last; ties; a single category
- the markdown parser: each supported construct, and hostile input — `<script>` tags, a `javascript:`
  href, an unterminated fence, a 300 KB body, CRLF line endings

Webview tests:

- chips add and remove; the five dimensions AND correctly; header click focuses and clears
- type pill and section header counts recompute against upstream filters
- selecting a row issues exactly one `mkt:read`; re-selecting a cached row issues none

Host tests:

- `mkt:read` rejects a path outside the allow-list
- the 256 KB truncation boundary, on both sides

The repo's existing coverage thresholds (90 statements / 85 branches / 85 functions / 90 lines) hold.

## Risks

- **`development` stays a third of everything.** The taxonomy is only as good as the manifests. Accepted:
  it is honest, and it improves for free as marketplaces fill the field in.
- **The markdown subset will miss constructs** real skill files use. Mitigated by literal-text fallback
  and by the corpus test; extending the parser later is additive.
- **Section headers as the category control is a novel gesture.** Mitigated by the chip row making the
  active focus explicit and clearable.
