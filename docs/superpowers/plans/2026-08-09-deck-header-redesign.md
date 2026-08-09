# In-flight Header Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip the Deck's In-flight header to information plus the lens and refresh, so it stops clipping — and fix the two defects found underneath it: toggles that flip back before settling, and a lens that spends a full board rebuild to redraw a board the webview already holds.

**Architecture:** Five sequential tasks against `src/deckView.ts` (extension host), `src/webview/DeckApp.tsx` + `src/webview/deckStyles.ts` (webview), and `src/types.ts` (the message contract between them). Task 1 is purely additive and makes VS Code settings the real control surface; Tasks 2–3 then remove the buttons that were that surface; Task 4 trims the tiles; Task 5 moves lens ownership into the webview.

**Tech Stack:** TypeScript, React 18 (webview, no router/state library), esbuild, Vitest + @testing-library/react, jsdom for webview tests. The `vscode` module is mocked at `test/_mocks/vscode.ts`.

**Spec:** [`docs/superpowers/specs/2026-08-09-deck-header-redesign-design.md`](../specs/2026-08-09-deck-header-redesign-design.md)

## Global Constraints

- **Work in the worktree.** All paths are relative to `/Users/oznasi/dev/agent-flow-wt/deck-header`, branch `deck-header-redesign`. Other sessions share the root checkout at `/Users/oznasi/dev/agent-flow` and will switch its branch under you — use absolute paths in shell commands and never `cd` to the root checkout.
- **Gates, run at the end of every task, all four:** `npm run typecheck`, `npm test`, `npm run test:cov` (thresholds are enforced and will fail the build), `npm run build`. `npm run build` is the only gate that catches a webview module importing `fs`/`os`/`path`/`child_process`; typecheck and the suite both pass regardless. Do not report a task complete on a subset.
- **Commit at the end of every task**, with the task's tests passing. Do not batch tasks into one commit.
- **Settings are frozen.** `agentFlow.prFacts`, `agentFlow.openAgents`, `agentFlow.reviewRequests`, `agentFlow.deckGrouping` keep their exact keys, descriptions and `true`/`"agents"` defaults. No `package.json` `contributes.configuration` edits in this plan.
- **House style, enforced by review:** monospace is for identifiers and counts only — anything that reads as English is set in the UI font. Saturated colour is spent only on attention debt. Comments explain *why*, not *what*; match the density of the surrounding code, which is heavily commented.
- **This is a removal.** Existing tests that drive deleted messages must be rewritten to drive the same behaviour through its new entry point, keeping their assertions verbatim. Delete a test only when its entire subject is a deleted thing, and only where this plan names it.
- **Never weaken a test to make it pass.** If an assertion fails, the implementation is wrong until proven otherwise.

---

### Task 1: Settings take effect without reopening the panel

Additive, and it must land first: it makes the VS Code settings a working control surface *before* Tasks 2–3 delete the buttons that are that surface today.

**Files:**
- Modify: `src/deckView.ts` — constructor (~line 124-145), new private method
- Test: `test/unit/deckView.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `DeckPanel` re-seeds `this.prFacts`, `this.openAgents`, `this.reviewQueue` from `getConfig()` on a `workspace.onDidChangeConfiguration` event, and refreshes. Tasks 2–3 rewrite existing tests to drive those fields through this listener instead of through deleted messages.

- [ ] **Step 1: Read the ground you're standing on**

Read `src/deckView.ts` lines 54-70 (the fields), 124-150 (the constructor), 871-925 (`onMessage`, in particular the `deck:setPrFacts` and `deck:setReviewQueue` handlers — the listener has to reproduce their side effects), and 1148-1152 (`dispose`).

Read `test/_mocks/vscode.ts` lines 137-149: `fireConfigurationChanged(affected)` already exists and matches a section the way VS Code does. No mock work is needed.

- [ ] **Step 2: Write the failing tests**

Add to `test/unit/deckView.test.ts`, inside the existing top-level `describe("DeckPanel", ...)`:

```ts
describe("DeckPanel settings without a reload", () => {
  it("re-seeds prFacts from the setting and re-probes gh when it turns on", async () => {
    h.prFacts = false;
    show();
    await settled();
    h.probeGh.mockClear();

    h.prFacts = true;
    setConfig({ prFacts: true });
    fireConfigurationChanged("agentFlow.prFacts");
    await settled();

    // The re-probe is the point: the user may have run `gh auth login` since the
    // last check, which is exactly why the removed deck:setPrFacts handler reset
    // ghGap/ghProbe on the way on.
    expect(h.probeGh).toHaveBeenCalled();
  });

  it("re-seeds openAgents from the setting", async () => {
    h.openAgents = false;
    h.runs = [mkRun({ key: "ASM-1", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "b" }] })];
    h.openSessions = [sess()];
    show();
    await settled();
    expect(builtFor("ASM-1").agents).toEqual([]);

    h.openAgents = true;
    setConfig({ openAgents: true });
    fireConfigurationChanged("agentFlow.openAgents");
    await settled();

    expect(builtFor("ASM-1").agents).toHaveLength(1);
  });

  it("clears the review strip immediately when reviewRequests goes off", async () => {
    show();
    await settled();
    const p = lastPanel();
    h.reviewSearch.mockClear();

    h.reviewRequests = false;
    setConfig({ reviewRequests: false });
    fireConfigurationChanged("agentFlow.reviewRequests");
    await settled();

    // Posted before the rebuild, not through it: switching off must empty the
    // strip now rather than seconds later, which is why the removed
    // deck:setReviewQueue handler called postCachedReviews() ahead of the refresh.
    expect(posts(p).filter((m) => m.type === "deck:reviews").at(-1)).toMatchObject({ enabled: false });
    expect(h.reviewSearch).not.toHaveBeenCalled();
  });

  it("ignores a configuration change that touches none of its keys", async () => {
    show();
    await settled();
    const p = lastPanel();
    const before = posts(p).length;

    fireConfigurationChanged("agentFlow.somethingElse");
    await settled();

    expect(posts(p)).toHaveLength(before);
  });
});
```

These use the suite's own idiom, which you should confirm before writing: `show()` then `await settled()` to open a panel, `lastPanel()` for the handle, `posts(p)` (line 279) for its messages, `builtFor(key)` for the `RunStatus` handed to the builder, and the `sess()` / `mkRun()` fixtures — see the `DeckPanel open agents` block at lines 798-870 for all of them together. Import `fireConfigurationChanged` from `../_mocks/vscode` alongside the existing `setConfig`.

The last test is the one most likely to be vacuous: confirm it can actually fail by temporarily making the listener refresh unconditionally and watching it go red. A test that passes against a broken implementation is worse than no test.

- [ ] **Step 3: Run the tests and confirm they fail**

```bash
npx vitest run test/unit/deckView.test.ts -t "settings without a reload"
```

Expected: all four fail — no listener is registered, so `fireConfigurationChanged` reaches nothing and the panel never re-seeds.

- [ ] **Step 4: Register the listener**

In the constructor, after the three `getConfig()` seeds and next to the other `onDid*` registrations:

```ts
    vscode.workspace.onDidChangeConfiguration(
      (e) => void this.onConfigChanged(e),
      null,
      this.disposables,
    );
```

Add the method next to `onMessage`:

```ts
  /** The panel seeds these three from config once and then holds them, so a
   * routine refresh cannot stomp them mid-session. With no toggles left on the
   * header, a settings edit is the only way to change them — and without this
   * listener it would do nothing until the panel was closed and reopened. */
  private async onConfigChanged(e: vscode.ConfigurationChangeEvent): Promise<void> {
    const cfg = getConfig();
    let touched = false;
    if (e.affectsConfiguration("agentFlow.prFacts")) {
      this.prFacts = cfg.prFacts;
      // The user may have run `gh auth login` since the last probe; a stale gap
      // would otherwise keep PR facts dark for the rest of the session.
      if (cfg.prFacts) {
        this.ghGap = undefined;
        this.ghProbe = null;
      }
      touched = true;
    }
    if (e.affectsConfiguration("agentFlow.openAgents")) {
      this.openAgents = cfg.openAgents;
      touched = true;
    }
    if (e.affectsConfiguration("agentFlow.reviewRequests")) {
      this.reviewQueue = cfg.reviewRequests;
      // Before the rebuild, not through it: switching off has to empty the strip
      // now, not after a full board build.
      this.postCachedReviews();
      touched = true;
    }
    if (touched) await this.refreshBusy();
  }
```

Update the three field comments at lines 65-67, which currently name the messages being deleted. For example:

```ts
  private prFacts: boolean; // seeded from config in the constructor; re-seeded only by onConfigChanged
```

- [ ] **Step 5: Run the new tests**

```bash
npx vitest run test/unit/deckView.test.ts -t "settings without a reload"
```

Expected: PASS.

- [ ] **Step 6: Run the full gates**

```bash
npm run typecheck && npm test && npm run test:cov && npm run build
```

Expected: all four pass. If coverage dropped, the uncovered lines are in `onConfigChanged` — add the missing case rather than lowering a threshold.

- [ ] **Step 7: Commit**

```bash
git add src/deckView.ts test/unit/deckView.test.ts
git commit -m "feat(deck): apply prFacts, openAgents and reviewRequests without reopening the panel"
```

---

### Task 2: Remove Live signal

**Files:**
- Modify: `src/deckView.ts` — field at line 59, `buildAll` lines 613 and 637, the `deck:runs` post at line 835, the `deck:setLive` case at line 887
- Modify: `src/types.ts` — line 156 comment, line 378, line 452
- Modify: `src/webview/DeckApp.tsx` — `stateView` line 53-62, `Card` lines 190-203, state line 358, line 411, `toggleLive` lines 477-481, button lines 515-517, `Card` render line 638
- Test: `test/unit/deckView.test.ts`, `test/webview/DeckApp.test.tsx`

**Interfaces:**
- Consumes: Task 1's `onConfigChanged`.
- Produces: `stateView(r: RunStatus, sourceLabel: string)` — the `live` parameter is gone. `Card` no longer takes a `live` prop. `OutboundMessage` `deck:runs` no longer carries `liveSignal`. `InboundMessage` no longer has `deck:setLive`.

- [ ] **Step 1: Rewrite the two host tests whose subject is the toggle**

In `test/unit/deckView.test.ts`:

`"re-posts with liveSignal off when toggled"` (line 442) is deleted outright — its whole subject is the deleted message.

`"marks every attached agent's activity unknown when the live signal is off, while still listing the session"` (line 823) is deleted, and replaced by a test of what actually survives — an unreadable transcript:

```ts
  it("still lists an attached session when its transcript is unreadable", async () => {
    // The registry knows the session is open; only the transcript goes unread.
    // That is now the sole route to an unknown activity, and it must not drop the
    // session from the card.
    h.runs = [mkRun({ key: "ASM-1", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "b" }] })];
    h.openSessions = [sess()];
    h.sessionActivity.mockReturnValue({ state: "unknown", lastActivityMs: null, slug: null });
    show();
    await settled();

    const agents = builtFor("ASM-1").agents;
    expect(agents).toHaveLength(1);
    expect(agents[0].session.name).toBe("svc-7e");
    expect(agents[0].activity).toEqual({ state: "unknown", lastActivityMs: null, slug: null });
  });
```

Note that the deleted test also asserted `expect(h.sessionActivity).not.toHaveBeenCalled()` — that assertion dies with the toggle and must **not** be carried over. The reader is now always called; it is its return value that reports the unknown.

`"still makes local cards with the live signal off"` (line 1151) keeps its assertions; drop the `deck:setLive` fire at line 1159 and instead make `h.sessionActivity` return the unknown activity above, then rename it to `"still makes local cards when a transcript is unreadable"`.

Delete the `liveSignal` assertion at line 404 and the `liveSignal:` key from the `buildRunStatus` argument matchers at lines 450, 670, 691, 1282, 1424, 1541.

- [ ] **Step 2: Rewrite the webview tests that click the switch**

In `test/webview/DeckApp.test.tsx`: delete `liveSignal: true` from the `runsMsg` helper (line 39) and from the inline `deck:runs` literal at line 565. Delete the two tests that click `/Live signal/i` (lines ~131, ~1295, ~1310) — read each first: if a test clicks the switch only as a way to reach some *other* assertion, keep the assertion and delete only the click.

- [ ] **Step 3: Run the suite and confirm it fails**

```bash
npx vitest run test/unit/deckView.test.ts test/webview/DeckApp.test.tsx
```

Expected: FAIL — `liveSignal` is still on the posted payload, and the tests you rewrote assert it is not.

- [ ] **Step 4: Delete Live signal from the host**

In `src/deckView.ts`: delete `private liveSignal = true;` (line 59). At lines 613 and 637 call the reader unconditionally:

```ts
            activity: readSessionActivity(projectsRoot, s.cwd, s.sessionId, now),
```

Delete `liveSignal: this.liveSignal,` from the `deck:runs` post (line 835) and from the `buildRunStatus` argument (line 682). Delete the entire `case "deck:setLive":` block (lines 887-890).

If `UNKNOWN_ACTIVITY` becomes an unused import in this file, remove it from the import at line 26 — `npm run typecheck` will not flag it, but the linter and review will.

- [ ] **Step 5: Delete it from the contract**

In `src/types.ts`: delete line 378 (`deck:setLive`) and the `liveSignal: boolean;` field from `deck:runs` (line 452). Rewrite the `CardAgent` doc comment at lines 155-157:

```ts
/** One open Claude Code session attached to a card, with its own live state.
 * `activity` is UNKNOWN_ACTIVITY when the transcript cannot be read — the registry
 * still knows the session is open, it is only the transcript that goes unread. */
```

- [ ] **Step 6: Delete it from the webview**

In `src/webview/DeckApp.tsx`:

```ts
function stateView(r: RunStatus, sourceLabel: string): { text: string; tone: Tone } {
  if (r.column === "done") return { text: allMerged(r.prs) ? "merged" : "done", tone: "merged" };
  if (r.agent.state === "unknown") return { text: `parked · git + ${sourceLabel} only`, tone: "parked" };
```

The rest of the function is unchanged — the `switch`'s `default` arm stays, unreachable-looking but load-bearing if `AgentState` ever grows.

Drop `live` from `Card`'s props type and destructuring (lines 190-191), from the `stateView` call at line 203, and from the `<Card ... />` render at line 638. Delete the `live` state (line 358), `setLive(m.liveSignal)` (line 411), the whole `toggleLive` function (lines 477-481), and the Live signal `<button>` (lines 515-517).

- [ ] **Step 7: Run the suite**

```bash
npx vitest run test/unit/deckView.test.ts test/webview/DeckApp.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Run the full gates and commit**

```bash
npm run typecheck && npm test && npm run test:cov && npm run build
git add -A
git commit -m "feat(deck): make the live signal unconditional and drop its toggle"
```

---

### Task 3: Remove the PR facts, Open agents and Review queue buttons

The settings stay. Only the header buttons, their messages, and the payload fields go.

**Files:**
- Modify: `src/deckView.ts` — the `deck:runs` post (lines 836-838), the three `case` blocks (891-903, 915-923)
- Modify: `src/types.ts` — lines 379-381, the three fields on `deck:runs`
- Modify: `src/webview/DeckApp.tsx` — states at lines 359, 360, 367; lines 412-414; the three buttons at lines 518-538
- Modify: `src/webview/deckStyles.ts` — delete `.switch` rules (lines 68-79), rewrite the `--brand` comment
- Test: `test/unit/deckView.test.ts`, `test/webview/DeckApp.test.tsx`

**Interfaces:**
- Consumes: Task 1's `onConfigChanged` — the only remaining way to change these three fields mid-session.
- Produces: `deck:runs` carries none of `prFacts`, `openAgents`, `reviewQueue`. `InboundMessage` has none of `deck:setPrFacts`, `deck:setOpenAgents`, `deck:setReviewQueue`.

- [ ] **Step 1: Rewrite the host tests to drive the settings instead of the messages**

Each of these keeps its assertions verbatim. Only the two lines that change a flag change. The pattern, in every case:

```ts
    // was: await p._fire({ type: "deck:setPrFacts", on: false });
    h.prFacts = false;
    setConfig({ prFacts: false });
    await act(() => fireConfigurationChanged("agentFlow.prFacts"));
```

Apply it to, at these line numbers: `"brackets a prFacts toggle with the busy indicator"` (722 — rename to `"brackets a prFacts change with the busy indicator"`), `"re-reads when the toggle comes back on"` (859, `openAgents`), `"re-probes gh when prFacts is toggled back on"` (1459), `"toggles prFacts from the webview"` (1471 — rename to `"applies a prFacts change from settings"`), `"does not let a probe orphaned by a toggle overwrite a fresher one (F6)"` (1546), `"stops searching and clears the strip when the review queue is toggled off"` (1717), `"restores the queue from cache when toggled back on, without a fresh search"` (1746), and `"clears the strip and refuses a queued row's submit once PR facts (and therefore the strip) go off"` (1812).

Three are not mechanical:

`"carries the review-queue toggle on deck:runs so the webview can render its pill"` (1710) — **delete**. Its whole subject is a payload field this task removes.

`"tells the webview which way the toggle is set"` (~869, in the `DeckPanel open agents` block) — **delete**, for the same reason: it reads `openAgents` off a `deck:runs` post. Read it first and confirm that is all it asserts.

`"keeps the toggle's answer across a refresh, rather than re-reading the setting"` (1732) — rewrite to assert the split the change creates, since a configuration event now legitimately does re-seed:

```ts
  it("re-reads reviewRequests on a configuration change but not on a routine refresh", async () => {
    const p = await openDeck();

    // A refresh must not re-read config: the field is seeded once and held, so a
    // poll tick cannot silently undo what the user last set.
    h.reviewRequests = false;
    setConfig({ reviewRequests: false });
    await p._fire({ type: "deck:refresh" });
    expect(posts(p).filter((m) => m.type === "deck:reviews").at(-1)).toMatchObject({ enabled: true });

    // A configuration change is the one thing that does.
    await act(() => fireConfigurationChanged("agentFlow.reviewRequests"));
    expect(posts(p).filter((m) => m.type === "deck:reviews").at(-1)).toMatchObject({ enabled: false });
  });
```

- [ ] **Step 2: Rewrite the webview tests**

In `test/webview/DeckApp.test.tsx`: drop `prFacts: true, openAgents: true, reviewQueue: true` from the `runsMsg` helper (line 39) and the inline literal (line 565). Delete `"toggles PR facts"` (line 531) and the "Open agents toggle always renders" assertion around line 627 — both test deleted controls. `"collapses to one card per run when Open agents is off"` (line 1110) is about card grouping, not the button: read it, and keep it if it only needs the fixture change.

- [ ] **Step 3: Run and confirm failure**

```bash
npx vitest run test/unit/deckView.test.ts test/webview/DeckApp.test.tsx
```

Expected: FAIL — the payload still carries the three fields and the messages still exist.

- [ ] **Step 4: Delete the handlers and payload fields**

In `src/deckView.ts`, delete `prFacts:`, `openAgents:` and `reviewQueue:` from the `deck:runs` post (lines 836-838). Keep `ghNote` — it reads `this.prFacts` on the host and stays.

Delete the three `case` blocks: `"deck:setPrFacts"` (891-899), `"deck:setOpenAgents"` (900-903), `"deck:setReviewQueue"` (915-923). Their side effects now live in `onConfigChanged` from Task 1 — verify by reading both before deleting, and if anything in a handler has no equivalent there, move it rather than dropping it.

In `src/types.ts`, delete lines 379-381 and the three fields from `deck:runs`.

- [ ] **Step 5: Delete the buttons and their state**

In `src/webview/DeckApp.tsx`, delete the `prFacts`, `openAgents` and `reviewQueue` states (lines 359, 360, 367), their three setters in the `deck:runs` handler (lines 412-414), and the three `<button>` elements (lines 518-538). The `<div className="ctls">` wrapper that held them goes with them, along with the comment above it at lines 511-513 describing four toggles that no longer exist.

- [ ] **Step 6: Delete the dead CSS**

In `src/webview/deckStyles.ts`, delete `.switch`, `.switch::after`, `.ctl.on .switch` and `.ctl.on .switch::after` (lines 68-79) — no control uses them now. Keep `.ctls`, `.ctls .ctl`, `.ctls .ctl + .ctl`, `.ctls .ctl:focus-visible` and `.ctls.seg`: the lens still uses all five.

Rewrite the comment that used to justify spending `--brand` on a switch track (lines 72-79) — with the switches gone, `.act.primary` is the only brand-filled surface left in the deck, and the comment should say that rather than describe a control that no longer exists. Update the `.ctls` comment at lines 54-55, which counts toggles.

- [ ] **Step 7: Run, gate and commit**

```bash
npx vitest run test/unit/deckView.test.ts test/webview/DeckApp.test.tsx
npm run typecheck && npm test && npm run test:cov && npm run build
git add -A
git commit -m "feat(deck): move the PR facts, Open agents and Review queue toggles to settings"
```

---

### Task 4: Three tiles, and a header that cannot clip

**Files:**
- Modify: `src/webview/DeckApp.tsx` — `reviewsSeen` state (line 404), its setter (line 432), the stats block (lines 495-509)
- Modify: `src/webview/deckStyles.ts` — `.hd` (lines 32-33)
- Test: `test/webview/DeckApp.test.tsx`

**Interfaces:**
- Consumes: Tasks 2-3's cleaned `deck:runs` payload.
- Produces: the header renders exactly three `.stat` tiles. `reviewsSeen` no longer exists in `DeckApp`.

- [ ] **Step 1: Write the failing tests**

In `test/webview/DeckApp.test.tsx`:

```ts
  it("shows three tiles: the board's own columns", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ column: "progress" }), mkStatus({ column: "needs" })]));

    const labels = screen.getAllByText(/./, { selector: ".stat .l" }).map((n) => n.textContent);
    expect(labels).toEqual(["In progress", "Action required", "In review"]);
  });

  it("drops the To review and Total tiles", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));

    // Both restated something already on screen: the review strip renders its own
    // count directly below, and Total is the sum of the three tiles beside it.
    expect(screen.queryByText("To review")).not.toBeInTheDocument();
    expect(screen.queryByText("Total")).not.toBeInTheDocument();
  });

  it("accents Action required only when something is asking for you", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ column: "progress" })]));
    expect(document.querySelector(".stat.attn")).toBeNull();

    host(runsMsg([mkStatus({ column: "needs" })]));
    expect(document.querySelector(".stat.attn")).not.toBeNull();
  });
```

Match `mkStatus`'s real `column` values by reading `COLUMNS` in `src/webview/deckCards.ts` first — use the actual ids, not the ones written here, if they differ.

Delete the four tests whose subject is the removed tiles: `"shows no To review stat until the host posts a queue"` (line 648), `"drops the To review stat entirely once the host reports the strip disabled"` (660), `"keeps the To review stat at zero, while the strip itself disappears"` (675), `"spins the To review tile instead of counting zero while loading"` (768). Fix the `Total` assertions at lines 100 and 1224 — read each test and keep whatever it was really about.

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run test/webview/DeckApp.test.tsx -t "tiles"
```

Expected: FAIL — five tiles render, so the label array does not match.

- [ ] **Step 3: Cut the stats block down**

In `src/webview/DeckApp.tsx`, replace the stats block (lines 495-509) with:

```tsx
        {/* The three board columns and nothing else. "To review" lived here too,
            six pixels above the review strip that renders its own count; "Total"
            was the sum of these three, over a board showing every card it counted. */}
        <div className="stats">
          <div className="stat"><span className="n">{cards.filter((c) => c.column === "progress").length}</span><span className="l">In progress</span></div>
          <div className={`stat ${needs > 0 ? "attn" : ""}`}><span className="n">{needs}</span><span className="l">Action required</span></div>
          <div className="stat"><span className="n">{cards.filter((c) => c.column === "review").length}</span><span className="l">In review</span></div>
        </div>
```

Delete the `reviewsSeen` state (line 404) and `setReviewsSeen(m.enabled)` (line 432) — the tile was its only consumer. Leave everything else in the `deck:reviews` handler alone; the strip itself is untouched by this plan.

- [ ] **Step 4: Make the header wrap**

In `src/webview/deckStyles.ts`, line 32:

```css
  /* Wraps, always. The row is the panel's widest object and gains controls over
     time; without this it clips its right end off-screen instead of folding. */
  .hd { flex: none; display: flex; flex-wrap: wrap; row-gap: 10px; align-items: center; gap: 14px;
    padding: 13px 20px; border-bottom: 1px solid var(--hair); }
```

`gap: 14px` after `row-gap` would reset it — keep `row-gap` before `gap`, or write `gap: 10px 14px` instead. Verify whichever you choose actually applies in the rendered output.

- [ ] **Step 5: Run, gate and commit**

```bash
npx vitest run test/webview/DeckApp.test.tsx
npm run typecheck && npm test && npm run test:cov && npm run build
git add -A
git commit -m "feat(deck): three stat tiles, and a header row that wraps instead of clipping"
```

---

### Task 5: The webview owns the lens

Fixes the flake at its root and stops a full rebuild being spent on a purely local view switch.

**Files:**
- Modify: `src/deckView.ts` — the `deck:runs` post (line 844), `deck:ready` (873-883), `deck:setGrouping` (907-914), `onConfigChanged` from Task 1
- Modify: `src/types.ts` — the `grouping` field on `deck:runs` (lines 454-456), new outbound message
- Modify: `src/webview/DeckApp.tsx` — the `deck:runs` handler (line 415)
- Test: `test/unit/deckView.test.ts`, `test/webview/DeckApp.test.tsx`

**Interfaces:**
- Consumes: Tasks 2-3's cleaned payload.
- Produces: new `OutboundMessage` member `{ type: "deck:grouping"; grouping: "agents" | "workspaces" }`. `deck:runs` no longer carries `grouping`. `deck:setGrouping` persists and does not rebuild.

- [ ] **Step 1: Write the failing host tests**

The existing `describe("board grouping")` block at line 996 holds two tests that assert `grouping` on a `deck:runs` post — `"persists the grouping globally and echoes it back on the next post"` and `"posts the grouping the setting already holds, without being asked"`. Both are replaced by the four below, which cover the same ground against the new message.

```ts
  it("seeds the lens on ready, ahead of the board build", async () => {
    setConfig({ deckGrouping: "workspaces" });
    show();
    await settled();

    const all = posts(lastPanel());
    const seed = all.findIndex((m) => m.type === "deck:grouping");
    const board = all.findIndex((m) => m.type === "deck:runs");
    expect(all[seed]).toEqual({ type: "deck:grouping", grouping: "workspaces" });
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThan(board);
  });

  it("persists a lens change without rebuilding the board", async () => {
    show();
    await settled();
    const p = lastPanel();
    const boardsBefore = posts(p).filter((m) => m.type === "deck:runs").length;

    await p._fire({ type: "deck:setGrouping", grouping: "workspaces" });
    await settled();

    // getConfiguration hands out a fresh stub per call, so the write is asserted
    // across every stub this pass produced rather than against one of them.
    const updates = workspace.getConfiguration.mock.results
      .flatMap((r) => (r.value as { update: { mock: { calls: unknown[][] } } }).update.mock.calls);
    expect(updates).toContainEqual(["deckGrouping", "workspaces", ConfigurationTarget.Global]);
    // deckGrouping is display-only — the webview draws both lenses from the run
    // list it already holds, so a rebuild here spends git per repo and a connector
    // round trip per run to produce the identical board.
    expect(posts(p).filter((m) => m.type === "deck:runs")).toHaveLength(boardsBefore);
  });

  it("re-posts the lens when the setting changes under the panel", async () => {
    show();
    await settled();
    const p = lastPanel();

    setConfig({ deckGrouping: "workspaces" });
    fireConfigurationChanged("agentFlow.deckGrouping");
    await settled();

    expect(posts(p).at(-1)).toEqual({ type: "deck:grouping", grouping: "workspaces" });
  });

  it("no longer carries the lens on the board post", async () => {
    // Control state on deck:runs is what made every toggle flip back before it
    // settled: that message costs a full rebuild, so one already in flight when
    // the user clicks lands carrying a pre-click snapshot.
    show();
    await settled();
    expect(posts(lastPanel()).find((m) => m.type === "deck:runs")).not.toHaveProperty("grouping");
  });
```

The `updates` expression is copied from the existing test at line 1005 — that suite computes it inline rather than sharing a helper, so keep it inline here too. `workspace` and `ConfigurationTarget` are already imported at the top of the file.

- [ ] **Step 2: Write the failing webview test**

```ts
  it("takes the lens from its own seed message and keeps it across board posts", () => {
    render(<DeckApp />);
    host({ type: "deck:grouping", grouping: "workspaces" });
    host(runsMsg([mkStatus()]));

    expect(screen.getByText("Workspaces").closest("button")).toHaveClass("on");
  });
```

Then update `runsMsg` (line 39) to drop its `grouping` argument and field, and fix the call sites that passed one.

- [ ] **Step 3: Run and confirm failure**

```bash
npx vitest run test/unit/deckView.test.ts test/webview/DeckApp.test.tsx
```

Expected: FAIL — `deck:grouping` does not exist.

- [ ] **Step 4: Add the message to the contract**

In `src/types.ts`, add to `OutboundMessage` beside the other `deck:` members:

```ts
  /** The lens, seeded once on ready and re-sent only if the setting changes under
   * the panel. Deliberately not a field on deck:runs: that message costs a full
   * board rebuild, so one already in flight when the user flips the lens lands
   * carrying a pre-click value and visibly reverts the control. */
  | { type: "deck:grouping"; grouping: "agents" | "workspaces" }
```

Delete the `grouping` field and its comment from `deck:runs` (lines 454-456).

- [ ] **Step 5: Change the host**

In `src/deckView.ts`, delete `grouping: getConfig().deckGrouping,` from the `deck:runs` post (line 844).

In the `deck:ready` case, post the seed before `refreshBusy()`, next to `postCachedReviews()`:

```ts
        this.post({ type: "deck:grouping", grouping: getConfig().deckGrouping });
        this.postCachedReviews();
        await this.refreshBusy();
```

Replace the `deck:setGrouping` case body with a persist and nothing else:

```ts
      case "deck:setGrouping":
        // Persisted, so the lens survives a reload — but not refreshed: the
        // webview derives both lenses from the run list it already holds, so a
        // rebuild here would redraw an identical board at the cost of git per
        // repo and a connector round trip per run.
        await vscode.workspace
          .getConfiguration("agentFlow")
          .update("deckGrouping", m.grouping, vscode.ConfigurationTarget.Global);
        break;
```

In `onConfigChanged`, handle the lens without setting `touched` — it needs no rebuild:

```ts
    // Posted, not refreshed: display-only, and this is what keeps a settings-page
    // edit landing now that the lens no longer rides along on every board post.
    if (e.affectsConfiguration("agentFlow.deckGrouping")) {
      this.post({ type: "deck:grouping", grouping: cfg.deckGrouping });
    }
```

Note this fires on the panel's own `update()` call too, which simply re-sends the value the webview already holds — harmless, and cheaper than tracking provenance.

- [ ] **Step 6: Change the webview**

In `src/webview/DeckApp.tsx`, delete `setGrouping(m.grouping);` from the `deck:runs` handler (line 415) and add a branch beside it:

```tsx
      } else if (m.type === "deck:grouping") {
        setGrouping(m.grouping);
      }
```

The click handler at line 551 already sets local state before sending, and now nothing echoes back to overtake it — leave it as it is.

- [ ] **Step 7: Run, gate and commit**

```bash
npx vitest run test/unit/deckView.test.ts test/webview/DeckApp.test.tsx
npm run typecheck && npm test && npm run test:cov && npm run build
git add -A
git commit -m "fix(deck): let the webview own the lens, and stop rebuilding the board to switch it"
```

- [ ] **Step 8: Look at it**

Build and open the extension development host — per the project's own notes, only VS Code's `code` CLI honours `--extensionDevelopmentPath`; the Cursor CLI silently drops it. Open the Deck, narrow the panel until it would previously have clipped, confirm the header folds instead, and flip the lens a few times to confirm it moves once and stays.

---

## Self-Review

**Spec coverage.** Header contents → Task 4 (tiles, wrap) and Tasks 2-3 (what leaves). Counts → Task 4. Live signal removed entirely → Task 2. Three buttons out, settings kept → Task 3. Dead `.switch` CSS and the `--brand` comment → Task 3 Step 6. Settings apply without a reload, including the `gh` re-probe and the early review post → Task 1. `deckGrouping` posted but not refreshed → Task 5 Step 5. Flake fix → Task 5. No-rebuild-on-lens → Task 5. Existing-test rewrites, with both non-mechanical cases named → Task 2 Step 1 and Task 3 Step 1. Gates → Global Constraints, repeated in every task's final step. Out-of-scope items are untouched by every task.

**Placeholders.** None: every code step carries the code, every test step carries the test, and each command has its expected result.

**Type consistency.** `stateView(r, sourceLabel)` is declared in Task 2's Interfaces and used with that signature in Task 2 Step 6. `deck:grouping` has one shape, declared in Task 5's Interfaces and identical in Steps 1, 4, 5 and 6. `onConfigChanged` is created in Task 1 Step 4 and extended in Task 5 Step 5 with the same `cfg`/`e` names.

**Known soft spots, flagged rather than papered over.**

- Line numbers are from `main` at `a395451` and shift as each task lands. Every task names the symbol as well as the line; locate by symbol.
- The test snippets were rewritten against the suite's real idiom (`show()`, `await settled()`, `lastPanel()`, `posts()`, `builtFor()`, `sess()`, `mkRun()`) after checking it, but they have not been executed. Treat each as a draft to be made red before it is made green: if a new test passes the first time you run it, that is a defect in the test, not a head start.
- The webview snippets in Tasks 4 and 5 assume `.stat .l` and the lens button's accessible text. Confirm against the rendered DOM rather than trusting the selector.
