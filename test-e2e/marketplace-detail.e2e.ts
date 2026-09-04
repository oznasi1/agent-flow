import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { describeWithHost } from "./_helpers/sharedHost";
import { Marketplace } from "./_helpers/po/marketplace";
import { runCommand } from "./_helpers/palette";
import { type Sandbox } from "./_helpers/sandbox";
import { shot } from "./_helpers/shot";

// The Marketplace's detail pane: keyboard navigation, what a row renders, and
// the two header actions. One Electron boot for the file — the panel is
// read-only (marketplaceView.ts never writes to ~/.claude), so the only state a
// test can leave behind is which row is selected and which editor tabs are open,
// neither of which any assertion below depends on.
//
// The seed is written in `prepare`, before the host launches, because the panel
// scans on `mkt:ready`. Row ORDER is load-bearing for the arrow-key test, and it
// falls out of two rules read from the product: everything here is category
// `yours` so there is exactly one section (sections.ts), and inside a section
// rows sort by TYPE_ORDER skills → commands → agents → hooks
// (MarketplaceApp.tsx:25,286-291) with each type alphabetical
// (claudeAssets.ts's `discoverAssets`). So the list is:
//
//   0 /checklist · 1 /links · 2 /refit · 3 telemetry-auditor · 4 transcript-archivist · 5 PreToolUse
//
// which is why ↓↓ from the search box lands on /refit. The oversized file is an
// AGENT, not a command, so it sorts below the two rows the arrow test walks
// through and is never the initially selected row — a 300,000-character
// markdown render on panel open would slow every test in the file.

/** Just over `MAX_PREVIEW` (262,144 chars, marketplaceView.ts:42). */
const BIG_CHARS = 300_000;

/** The editor tab strip. `.tabs-container .tab` is workbench chrome — the same
 *  selector `orchestrator-nodes.e2e.ts` reads tabs from. */
function editorTab(page: Page, title: string): Locator {
  return page.locator(".tabs-container .tab", { hasText: title });
}

function seedDetailAssets(sb: Sandbox): void {
  const claude = path.join(sb.home, ".claude");
  const commands = path.join(claude, "commands");
  const agents = path.join(claude, "agents");
  fs.mkdirSync(path.join(claude, "hooks"), { recursive: true });

  fs.writeFileSync(
    path.join(commands, "checklist.md"),
    "---\ndescription: Walk the pre-launch checklist.\n---\n\nRead every line aloud.\n",
  );
  // Two links, one of each kind the renderer has to tell apart. The label of the
  // refused one is kept, so its absence as an anchor is provable without the
  // text itself disappearing (markdown.ts:26-28,71).
  fs.writeFileSync(
    path.join(commands, "links.md"),
    "---\ndescription: Links, safe and not.\n---\n\n" +
      "See [the handbook](https://handbook.fixture.invalid/rocket) and [blocked](javascript:alert(1)).\n",
  );
  // 300,000 characters of body — over the preview cap, so the host truncates and
  // the pane says so.
  fs.writeFileSync(
    path.join(agents, "transcript-archivist.md"),
    "---\nname: transcript-archivist\ndescription: Files old session transcripts.\n---\n\n" +
      `${"archive line, repeated to overflow the preview cap. ".repeat(Math.ceil(BIG_CHARS / 50))}\n`,
  );
  fs.writeFileSync(
    path.join(claude, "hooks", "hooks.json"),
    JSON.stringify(
      { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo checked-by-hook" }] }] } },
      null,
      2,
    ),
  );
}

/** Open the Marketplace panel through the real command, not a seam. See
 *  `openMarketplace` in marketplace.e2e.ts for the palette's races and the
 *  bare-title rule; the panel is a host-side singleton, so later calls reveal
 *  the same one. */
async function openMarketplace(page: Page): Promise<Marketplace> {
  await runCommand(page, "Open the Marketplace");
  const mkt = new Marketplace(page);
  await expect(mkt.results().first()).toBeVisible({ timeout: 30_000 });
  return mkt;
}

describeWithHost(
  "marketplace detail",
  {},
  (ctx) => {
    // Mutation-checked, once per half: MarketplaceApp.tsx:310 `else if (e.key === "Enter" && active?.file)` → `else if (false && active?.file)` (Enter does nothing) — the editor-tab assertion failed; and :308 `Math.min(s + 1, rows.length - 1)` → `Math.min(s, rows.length - 1)` (↓ does not move) — the /refit selection assertion failed.
    test("arrow keys move the selection and Enter opens the file", async ({}, testInfo) => {
      const mkt = await openMarketplace(ctx.page());
      const selected = mkt.frame.locator(".results .row.on");
      // The panel opens with the first row selected — the control that makes
      // the two ↓ presses below provable rather than incidental.
      await expect(selected).toContainText("/checklist");
      await mkt.search().click();
      await mkt.search().press("ArrowDown");
      await mkt.search().press("ArrowDown");
      await expect(selected).toContainText("/refit");
      await shot(ctx.page(), testInfo, "1 · two rows down");
      await mkt.search().press("Enter");
      await expect(editorTab(ctx.page(), "refit.md")).toBeVisible({ timeout: 15_000 });
      await shot(ctx.page(), testInfo, "2 · opened in an editor tab");
    });

    // Mutation-checked: marketplaceView.ts:171 `await vscode.window.showTextDocument(doc, { preview: true })` deleted — the editor-tab assertion failed.
    test("Open file opens the asset in an editor tab", async ({}, testInfo) => {
      const mkt = await openMarketplace(ctx.page());
      await mkt.result("telemetry-auditor").click();
      await mkt.openButton().click();
      await expect(editorTab(ctx.page(), "telemetry-auditor.md")).toBeVisible({ timeout: 15_000 });
      await shot(ctx.page(), testInfo, "1 · Open file");
    });

    // Mutation-checked: MarketplaceApp.tsx:531 `fence={active.type === "hook" ? "json" : ""}` → `fence=""` (the body renders as prose) — the `pre code` assertion failed.
    test("a hook renders its hooks.json as a fenced JSON block", async ({}, testInfo) => {
      const mkt = await openMarketplace(ctx.page());
      // A hook row's name is the event it fires on (claudeAssets.ts's
      // `flattenHooks`), and its file is the hooks.json it came out of.
      await mkt.result("PreToolUse").click();
      const fenced = mkt.frame.locator(".preview pre code");
      await expect(fenced).toContainText("\"PreToolUse\"");
      await expect(fenced).toContainText("echo checked-by-hook");
      await shot(ctx.page(), testInfo, "1 · hooks.json fenced");
    });

    // Mutation-checked: marketplaceView.ts:42 `const MAX_PREVIEW = 262_144` → `2_620_144` (nothing truncates) — the `.mdtrunc` assertions failed.
    test("a file over 262,144 characters is truncated with Open file covering the rest", async ({}, testInfo) => {
      const mkt = await openMarketplace(ctx.page());
      await mkt.result("transcript-archivist").click();
      await expect(mkt.truncNote()).toContainText("Truncated at 262,144 characters.");
      // The pane's own Open file button, the one that covers the rest — scoped
      // to the note, not the actions row above it.
      await expect(mkt.truncNote().locator(".btn")).toHaveText("Open file");
      await shot(ctx.page(), testInfo, "1 · truncated");
    });

    // Mutation-checked: markdown.ts:28 `const SAFE_HREF = /^https?:\/\//i` → `/^/` (every scheme becomes an anchor) — the "one anchor only" assertion failed.
    test("only http and https links are clickable", async ({}, testInfo) => {
      const mkt = await openMarketplace(ctx.page());
      await mkt.result("/links").click();
      const anchors = mkt.frame.locator(".preview a");
      await expect(anchors).toHaveCount(1);
      await expect(anchors).toHaveAttribute("href", "https://handbook.fixture.invalid/rocket");
      // The refused link keeps its label as plain text — the proof that the
      // second link was rendered at all and simply is not an anchor.
      await expect(mkt.preview()).toContainText("blocked");
      await expect(mkt.frame.locator('.preview a:has-text("blocked")')).toHaveCount(0);
      await shot(ctx.page(), testInfo, "1 · one anchor of two links");
    });

    // Mutation-checked: MarketplaceApp.tsx:327 `send({ type: "mkt:copy", text: "/plugin marketplace add owner/repo" })` → `text: "/plugin marketplace add"` — the clipboard assertion failed while the toast still appeared, which is why the toast alone is not the assertion of record here.
    test("Add a marketplace copies the command", async ({}, testInfo) => {
      const mkt = await openMarketplace(ctx.page());
      // A sentinel first, so a pre-existing clipboard value can never pass this.
      const sentinel = `af-e2e-sentinel-${Date.now()}`;
      const clipboardReadable = process.platform === "darwin";
      if (clipboardReadable) execFileSync("pbcopy", { input: sentinel });
      await mkt.addMarketplaceButton().click();
      await expect(mkt.toast()).toContainText("Copied to clipboard", { timeout: 5_000 });
      await shot(ctx.page(), testInfo, "1 · copied");
      if (clipboardReadable) {
        // The host wrote through `vscode.env.clipboard`, which is the real
        // machine pasteboard — so the test can read back exactly what a user
        // would paste into Claude Code.
        expect(execFileSync("pbpaste", { encoding: "utf8" })).toBe("/plugin marketplace add owner/repo");
      }
    });

    // Mutation-checked: marketplaceView.ts:162 the `case "mkt:refresh":` label removed from the `mkt:ready` arm (Rescan falls through to the unknown-type log) — the new row never appeared.
    test("Rescan picks up a file added after the first scan", async ({}, testInfo) => {
      const mkt = await openMarketplace(ctx.page());
      // Written AFTER the panel is up and revealed, so the stale-refocus rescan
      // (marketplaceView.ts:86-92) cannot be what finds it.
      await expect(mkt.result("pad-inspector")).toHaveCount(0);
      fs.writeFileSync(
        path.join(ctx.sb().home, ".claude", "agents", "pad-inspector.md"),
        "---\nname: pad-inspector\ndescription: Inspects the pad before a launch.\n---\n\nWalk the pad.\n",
      );
      await expect(mkt.result("pad-inspector")).toHaveCount(0);
      await mkt.rescanButton().click();
      await expect(mkt.result("pad-inspector")).toBeVisible({ timeout: 15_000 });
      await shot(ctx.page(), testInfo, "1 · rescanned");
    });
  },
  seedDetailAssets,
);

// The not-set-up state needs a sandbox WITHOUT `~/.claude/plugins`, and
// `makeSandbox` always seeds one (the base seed's comment says why), so this is
// its own boot with the directory removed in `prepare` — before the host, since
// the panel scans on `mkt:ready`.
describeWithHost(
  "marketplace without Claude Code set up",
  {},
  (ctx) => {
    // Mutation-checked: claudeAssets.ts:362 `const notSetUp = !reader.isDir(pluginsDir)` → `= false` (the panel renders the results list instead) — the empty-state assertion failed.
    test("without a plugins directory the panel explains Claude Code is not set up", async ({}, testInfo) => {
      await runCommand(ctx.page(), "Open the Marketplace");
      const mkt = new Marketplace(ctx.page());
      // `notSetUp` replaces the whole split — the seeded agent and command are
      // still scanned and still counted in the pills, but no row renders.
      await expect(mkt.emptyBig()).toContainText("Claude Code isn't set up on this machine yet", { timeout: 30_000 });
      await expect(mkt.frame.locator(".results")).toHaveCount(0);
      await expect(mkt.kindCount("Agents")).toHaveText("1");
      await shot(ctx.page(), testInfo, "1 · not set up");
    });
  },
  (sb) => fs.rmSync(path.join(sb.home, ".claude", "plugins"), { recursive: true, force: true }),
);
