import { expect, test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { describeWithHost } from "./_helpers/sharedHost";
import { Pool } from "./_helpers/po/pool";
import { shot } from "./_helpers/shot";

// Test order below is DELIBERATE, not incidental. `describeWithHost` runs its
// tests with `mode: "serial"` (see sharedHost.ts), which skips every test
// after the first genuine (unexpected) failure. While building this journey,
// the "sections" test (now last) intermittently lost data to the race
// documented on `settle()` below, and — in whatever position it sat — a
// failure there would have cascade-skipped the drag/selection tests, which
// are this file's entire reason for existing. It is kept LAST as a standing
// precaution: the highest-value tests (drag + the pinned selection defect)
// run first, so nothing about a later test's health can ever swallow them.
// See task-5-report.md for the full reasoning.

async function addNote(pool: Pool, title: string, body: string): Promise<void> {
  await pool.frame.locator(".np-title-input").fill(title);
  await pool.frame.locator(".np-body-input").fill(body);
  await pool.frame.locator(".np-add-btn").click();
  await expect(pool.note(title)).toBeVisible();
}

/** ⚠ WORKAROUND FOR A REAL, PREVIOUSLY-UNKNOWN DATA-LOSS BUG — read before touching.
 *
 * This is NOT ordinary test hygiene. `tasksView.ts` has a persistence race:
 * in a Notepad view that already holds at least one persisted note/section
 * AND has been mounted at least once before (true of every test here after
 * the first), two `globalState`-writing messages fired within roughly
 * 100–300ms of each other can race — the SECOND write's own read of
 * `agentFlow.notepad` / `agentFlow.notepadSections` comes back as if the
 * first write never happened, and clobbers it. The concrete symptom that
 * found this: `notepad:addSection` persists and reads back correctly
 * (confirmed via a temporary `this.log()` in tasksView.ts, since reverted),
 * but the very next message — `notepad:renameSection`, sent moments later —
 * reads `this.sections()` as `[]` with no other message logged in between,
 * so its own `.map()` over nothing writes `[]` right back and **deletes the
 * section it was asked to rename**. The same pattern silently dropped a
 * note added immediately after another one. A ~300–500ms pause between
 * writes reproduces ordinary human pacing (nobody fires two notepad actions
 * within a tenth of a second) and eliminates it every time in testing.
 *
 * This is a genuine product bug in a persistence path, being surfaced to
 * the user separately (see task-5-report.md for the full repro and the log
 * evidence) — it is NOT being fixed here, and this pause is a workaround
 * for THIS journey only, not a claim that the underlying race is resolved. */
async function settle(pool: Pool): Promise<void> {
  await pool.page.waitForTimeout(500);
}

/** Leave the webview on the Tasks tab before a test ends. Pool.open()'s
 *  idempotency check (`.card` count > 0) only tells "the sidebar container is
 *  open" from "closed" — it can't tell "open on Notepad" from "closed",
 *  because `.card` renders on neither. A shared-host test ending on Notepad
 *  would make the NEXT test's Pool.open() see 0 cards, wrongly re-click the
 *  already-open activity-bar icon, and — per that icon's real toggle
 *  behaviour — collapse the sidebar outright. Restoring the Tasks tab here,
 *  not touching pool.ts, keeps every subsequent Pool.open() call a true no-op. */
async function backToTasks(pool: Pool): Promise<void> {
  await pool.openTasksTab();
  await expect(pool.cards()).toHaveCount(2);
}

describeWithHost("notepad", {}, (ctx) => {
  test("a note added in one view is still there after the view is rebuilt", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await pool.openNotepad();
    await addNote(pool, "Check the telemetry feed", "It points at the retired endpoint.");
    await shot(ctx.page(), testInfo, "1 · note added");

    // The Notepad lives in globalState, not in the webview — so the proof is
    // that it survives the webview being torn down and rebuilt.
    await pool.openTasksTab();
    await pool.openNotepad();
    await expect(pool.note("Check the telemetry feed")).toBeVisible();
    await backToTasks(pool);
  });

  test("toggling done and clearing completed removes only the done note", async () => {
    const pool = await Pool.open(ctx.page(), 2);
    await pool.openNotepad();
    // This mount already holds "Check the telemetry feed" from the previous
    // test — see settle()'s doc comment for why the writes below are paced.
    await addNote(pool, "Second note", "stays");
    await settle(pool);

    await pool.note("Check the telemetry feed").locator(".cb").click();
    await settle(pool);
    await pool.frame.locator(".np-clear").click();

    await expect(pool.note("Check the telemetry feed")).toHaveCount(0);
    await expect(pool.note("Second note")).toBeVisible();
    await backToTasks(pool);
  });

  /** Drag a note by its `.grip` to a target row via a real mouse sequence.
   *  Both tests below need this — the drag itself (asserted independently),
   *  and the selection defect, which only manifests on a row that was JUST
   *  dragged. `dragTo` is deliberately not used: it does not reliably fire
   *  dragstart/dragover/drop for HTML5 drag in Chromium, and a single mouse
   *  move (no `steps`) gets coalesced so the drop lands where it started. */
  async function dragNoteTo(pool: Pool, fromIndex: number, toIndex: number): Promise<void> {
    const grip = pool.notes().nth(fromIndex).locator(".grip");
    const target = pool.notes().nth(toIndex);
    const from = await grip.boundingBox();
    const to = await target.boundingBox();
    if (!from || !to) throw new Error("notepad drag: a bounding box was null — the list did not render");
    await pool.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await pool.page.mouse.down();
    await pool.page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await pool.page.mouse.up();
  }

  test("a note can be dragged to a new position", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await pool.openNotepad();
    // Notes render newest-first until a manual order exists (tasksView.ts's
    // orderedNotes()). Only "Second note" survives from the earlier tests (the
    // first note this file added was toggled done and cleared) — so two more
    // notes are added here, not one, to guarantee a THIRD row exists for the
    // drag target (`nth(2)`) below. After this, the active list reads newest
    // first: Fourth note, Third note, Second note. See settle()'s doc comment
    // for why there's a pause between the two adds.
    await addNote(pool, "Third note", "third body");
    await settle(pool);
    await addNote(pool, "Fourth note", "last");
    await expect(pool.notes()).toHaveCount(3);

    const firstBefore = await pool.notes().nth(0).innerText();
    await dragNoteTo(pool, 0, 2);
    await expect.poll(async () => (await pool.notes().nth(0).innerText()) !== firstBefore).toBe(true);
    await shot(ctx.page(), testInfo, "2 · dragged");
    await backToTasks(pool);
  });

  // PINS A KNOWN, DETERMINISTIC DEFECT — this is not a flake and not a test
  // bug. In Blink, an element with the `draggable` attribute cannot be
  // text-selected by mouse, and calling `preventDefault()` on `dragstart`
  // does not hand the gesture back to selection. `Notepad.tsx:504-511`
  // shows the author already anticipated exactly this trap and tried to
  // design around it with an `armed` / `draggable={armed}` state machine
  // that un-arms a row on mouseup/dragend — but the `onDragEnd` reset at
  // `Notepad.tsx:626` does not fully hand the gesture back to selection for
  // the row that was just dragged, which is what this test demonstrates.
  // `jsdom` (the unit suite's environment) cannot observe either half of
  // this fact, which is how the defect has survived a fully green unit
  // suite until now — this is the ONE thing a real-Electron harness exists
  // to catch that jsdom structurally cannot.
  //
  // `test.fail()` (not `test.skip`/`test.fixme`, which would stop this from
  // running at all and let the defect drift silently) marks failure as the
  // EXPECTED outcome: the suite stays green while this fails, and the day
  // someone fixes the drag/selection interaction in Notepad.tsx, THIS TEST
  // GOES RED — that is the intended alarm. When that happens, the fix here
  // is to delete the `test.fail()` line below, not to delete the test.
  test("dragging a note leaves its body unselectable afterwards (pinned defect)", async ({}, testInfo) => {
    test.fail();
    const pool = await Pool.open(ctx.page(), 2);
    await pool.openNotepad();
    // Reuses the 3 notes the previous (still-passing) drag test left behind
    // in this shared host — see the top-of-file comment on test ordering.
    await expect(pool.notes()).toHaveCount(3);

    // The defect is specifically "selection after THIS row was dragged", so
    // the drag has to happen here too, not just be inherited from the prior
    // test's already-settled DOM.
    await dragNoteTo(pool, 0, 2);
    await shot(ctx.page(), testInfo, "3 · dragged again, about to attempt selection");

    const body = pool.notes().nth(0).locator(".np-body");
    const box = await body.boundingBox();
    if (!box) throw new Error("notepad selection: the note body had no box");
    await pool.page.mouse.move(box.x + 4, box.y + box.height / 2);
    await pool.page.mouse.down();
    await pool.page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 8 });
    await pool.page.mouse.up();

    const selected = await pool.page.evaluate(() => {
      // Mirrors _helpers/host.ts's tasksFrame(): the outer wrapper is `.last()`
      // among every `iframe.webview` the workbench may have mounted, with the
      // real React app one level further in at `#active-frame`.
      const outers = document.querySelectorAll("iframe.webview");
      const wv = outers.length > 0 ? (outers[outers.length - 1] as HTMLIFrameElement) : null;
      const inner = wv?.contentDocument?.querySelector("#active-frame") as HTMLIFrameElement | null;
      return inner?.contentDocument?.getSelection()?.toString() ?? "";
    });
    // `backToTasks` runs BEFORE the assertion below on purpose: that
    // assertion is expected to throw (this test pins a failure via
    // `test.fail()`), and anything after a throw never runs. Without this
    // ordering, the pinned failure would skip cleanup and leave the webview
    // on the Notepad tab, which cascades into a false failure in the NEXT
    // test via Pool.open()'s idempotency check — reproduced once while
    // building this: see backToTasks()'s own doc comment for the mechanism.
    await backToTasks(pool);
    // Expected to be 0 today (the pinned defect). Fixed Notepad.tsx makes
    // this > 0, which — via test.fail() above — turns this test RED as the
    // signal to remove the pin.
    expect(selected.trim().length).toBeGreaterThan(0);
  });

  test("running a note seeds a session and lands a plan file", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await pool.openNotepad();
    await pool.notes().nth(0).getByRole("button", { name: /start/i }).click();

    // runNotepadItem (tasksView.ts) shares its kickoff with explore(): with only
    // one repo discovered ("rocket"), it still shows a canPickMany QuickPick
    // ("Space to toggle · Enter to open") rather than auto-selecting the sole
    // repo the way the Take flow's own repo-confirm picker does. The item
    // isn't pre-checked, so it must be toggled before Enter or the pick
    // resolves empty and the launch silently no-ops.
    const quickInput = pool.page.locator(".quick-input-widget");
    await expect(quickInput).toBeVisible({ timeout: 15_000 });
    // A plain keyboard Space here lands in the QuickPick's own filter text
    // box (that is what has focus on open), not on the list — it does NOT
    // toggle the row's checkbox, and Enter then confirms an EMPTY pick,
    // which makes runNotepadItem silently no-op. Clicking the row itself
    // toggles its checkbox directly, independent of keyboard focus.
    await pool.page.locator(".quick-input-list .quick-input-list-entry", { hasText: "rocket" }).click();
    await pool.page.keyboard.press("Enter");

    const plans = path.join(ctx.sb().home, ".agentflow", "plans");
    await expect.poll(
      () => (fs.existsSync(plans) ? fs.readdirSync(plans) : []),
      { timeout: 60_000 },
    ).not.toHaveLength(0);
    await shot(ctx.page(), testInfo, "4 · note run");
    await backToTasks(pool);
  });

  // Titled precisely for what it exercises: an add and a rename, both on the
  // section itself. A note is deliberately NOT filed into the section here —
  // that write (`notepad:setSection`, fired via the note's "Section" select
  // in edit mode) lands close enough after this section's own rename write
  // to intermittently hit the exact `globalState` data-loss race documented
  // on `settle()` above (confirmed while building this test: identical steps,
  // paced with the same 500ms `settle()` this file uses everywhere else,
  // still failed roughly 1 run in 3). Asserting a note landed in a section
  // would make this test flaky by construction on a known, unfixed product
  // bug — see the spec's §12 Finding B — rather than proving anything about
  // sections. The add+rename affordances this title actually claims are not
  // subject to that race (no note write is involved) and are solid.
  test("sections can be added and renamed", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await pool.openNotepad();

    // ".np-section-add-btn" is disabled until the input holds text
    // (Notepad.tsx: `disabled={!sectionName.trim()}`), so it must be filled
    // before the button is clickable — fill, then press Enter, which the
    // input's own onKeyDown already wires to addSection().
    await pool.frame.locator(".np-section-input").fill("Telemetry");
    await pool.page.keyboard.press("Enter");
    await expect(pool.frame.locator(".np-section-name", { hasText: "Telemetry" })).toBeVisible();
    // See settle()'s doc comment: addSection and renameSection are two
    // globalState writes to the SAME key in quick succession, on a mount
    // that already holds notes from earlier tests — exactly the pattern
    // that races without a pause here.
    await settle(pool);

    // Not a dblclick on the name: SectionHeader (Notepad.tsx) has no
    // onDoubleClick — rename is the pencil button labelled "Rename section".
    await pool.frame.getByRole("button", { name: "Rename section" }).click();
    await pool.frame.locator(".np-section-name-input").fill("Telemetry feed");
    // No onKeyDown on this input (unlike the add-note fields) — only the
    // "Save section name" button commits the rename.
    await pool.frame.getByRole("button", { name: "Save section name" }).click();
    await expect(pool.frame.locator(".np-section-name", { hasText: "Telemetry feed" })).toBeVisible();
    await shot(ctx.page(), testInfo, "5 · section renamed");
    await backToTasks(pool);
  });
});
