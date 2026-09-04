import { expect, test, type Locator, type Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { describeWithHost } from "./_helpers/sharedHost";
import { Pool } from "./_helpers/po/pool";
import type { Sandbox } from "./_helpers/sandbox";
import { shot } from "./_helpers/shot";

// The Notepad's edges, in one shared host — the same surface `notepad.e2e.ts`
// covers (globalState only, nothing a sibling test inherits badly) with one
// exception noted on the last test, which launches sessions and is therefore
// kept LAST for the same reason that file keeps its riskiest test last.
//
// Every test here adds the notes IT needs, under titles nothing else uses, and
// asserts on those titles rather than on absolute list counts. That is not
// tidiness: `describeWithHost` runs serial, so a single test can be re-run in
// isolation with `-g "<title>"` (which is exactly what a mutation check does),
// and a test that leaned on a predecessor's notes would fail there for reasons
// that have nothing to do with the mutation. The two ABSENCE assertions are the
// exceptions and are ordered for it: "Clear completed" needs a notepad with no
// done note (so it runs first, before anything checks a box) and "Reset order"
// needs no manual order on record (so it puts the order back before it ends).

async function addNote(pool: Pool, title: string, body: string): Promise<void> {
  await pool.frame.locator(".np-title-input").first().fill(title);
  await pool.frame.locator(".np-body-input").first().fill(body);
  await pool.frame.locator(".np-add-btn").click();
  await expect(pool.note(title)).toBeVisible();
}

/** ⚠ WORKAROUND FOR A REAL, UNFIXED DATA-LOSS BUG — see the full write-up on
 *  `settle()` in `notepad.e2e.ts`, which found it. Short version: two
 *  `globalState`-writing notepad messages fired within ~100–300ms of each other
 *  on an already-mounted view that already holds a note can race, and the second
 *  write's own read comes back as if the first never happened — clobbering it.
 *  A ~500ms pause reproduces ordinary human pacing and eliminates it. This file
 *  writes far more often than that one, so EVERY write here is paced. */
async function settle(pool: Pool): Promise<void> {
  await pool.page.waitForTimeout(500);
}

/** Leave the webview on the Tasks tab before a test ends — see the doc comment
 *  on `notepad.e2e.ts`'s own `backToTasks` for why `Pool.open()` collapses an
 *  already-open sidebar otherwise. */
async function backToTasks(pool: Pool): Promise<void> {
  await pool.openTasksTab();
  await expect(pool.cards()).toHaveCount(2);
}

/** The toolbar's ⋯ menu (`.np-menu-btn`, Notepad.tsx:305 on 2026-09-04). Its
 *  items are `role="menuitem"` inside `.np-menu` (Notepad.tsx:315). Opening is a
 *  plain toggle, so closing is the same click again — the click-outside handler
 *  (Notepad.tsx:156-162) listens on `mousedown`, and clicking a note to close
 *  the menu would fire that note's own handlers too. */
async function openMenu(pool: Pool): Promise<void> {
  await pool.frame.locator(".np-menu-btn").click();
  await expect(pool.frame.locator(".np-menu")).toBeVisible();
  // The one item that is ALWAYS rendered (Notepad.tsx:317-322). Asserted before
  // every absence below as a positive control: without it, "Clear completed is
  // not in the menu" and "Reset order is not in the menu" would both also pass
  // against a menu that never opened at all.
  await expect(pool.frame.getByRole("menuitem", { name: "New section…" })).toBeVisible();
}

async function closeMenu(pool: Pool): Promise<void> {
  await pool.frame.locator(".np-menu-btn").click();
  await expect(pool.frame.locator(".np-menu")).toHaveCount(0);
}

/** One tab of the note filter — `role="group" aria-label="Note filter"`
 *  (Notepad.tsx:291 on 2026-09-04), `aria-pressed` on the active one
 *  (Notepad.tsx:294). `exact` because "All" would otherwise be ambiguous with
 *  nothing here, but "Active" and "All" share no prefix by luck rather than by
 *  design. Deliberately NOT added to `po/pool.ts`: only this file reads it. */
function noteFilter(pool: Pool, label: string): Locator {
  return pool.frame
    .getByRole("group", { name: "Note filter" })
    .getByRole("button", { name: label, exact: true });
}

/** Drag a note by its `.grip` to another row via a real mouse sequence — copied
 *  from `notepad.e2e.ts` rather than imported, per this task's brief. `dragTo`
 *  is deliberately not used: it does not reliably fire dragstart/dragover/drop
 *  for HTML5 drag in Chromium, and a single un-stepped move gets coalesced so
 *  the drop lands where it started. */
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

/** Synthesise a file drop on a note row, inside the webview's own realm.
 *
 *  The native file picker is out of scope for this lane (an OS dialog Playwright
 *  cannot drive), and Playwright's own `setInputFiles` cannot reach a drop
 *  handler. So the `DataTransfer` is built INSIDE the frame — `frame.locator()`
 *  rooted `evaluate` runs there, where `File` and `DataTransfer` are the real
 *  things — and dispatched as a bubbling, cancelable `DragEvent` so React's
 *  root-level listener sees it and `preventDefault()` means something.
 *  `dt.items.add(file)` is what puts `"Files"` in `dataTransfer.types`, which is
 *  the exact test `isFileDrag` (Notepad.tsx:75-76) makes before treating the
 *  drop as an attach rather than a reorder.
 *
 *  `base64` gives a real decodable PNG; `bytes` allocates that many zero bytes
 *  instead, for the oversize path — the host's cap is on byte length, not on
 *  whether the payload decodes (notepadImages.ts:47). */
async function dropImageOn(
  row: Locator,
  name: string,
  src: { base64: string; bytes?: undefined } | { bytes: number; base64?: undefined },
): Promise<void> {
  await row.evaluate((el, arg: { name: string; base64?: string; bytes?: number }) => {
    const buf = arg.base64 !== undefined
      ? Uint8Array.from(atob(arg.base64), (c) => c.charCodeAt(0))
      : new Uint8Array(arg.bytes ?? 0);
    const file = new File([buf], arg.name, { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, { name, base64: src.base64, bytes: src.bytes });
}

/** A 1×1 transparent PNG — 68 bytes, a genuinely decodable image, so the
 *  thumbnail's `<img>` is a real render rather than a broken-image box. */
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Whatever the notepad image store holds on disk. The store lives under the
 *  extension's `globalStorageUri` (tasksView.ts:442, `IMAGE_DIR`), which VS Code
 *  puts at `<user-data>/User/globalStorage/<extension id>/` — the id's case is
 *  normalised by the workbench, so the directory is FOUND rather than spelled
 *  out here. This is the assertion of record for an attach: the thumbnail proves
 *  the round trip, these bytes prove the host wrote (or refused to write) them. */
function storedImages(sb: Sandbox): string[] {
  const root = path.join(sb.userDataDir, "User", "globalStorage");
  if (!fs.existsSync(root)) return [];
  for (const entry of fs.readdirSync(root)) {
    const dir = path.join(root, entry, "notepad-images");
    if (fs.existsSync(dir)) return fs.readdirSync(dir).sort();
  }
  return [];
}

/** Every notepad run record in the store. `runNotepadItem` (tasksView.ts:1696)
 *  keys a run `notepad-<title slug>-<note id>` and `writeRun` (engine/runs.ts:22)
 *  writes one file per key, so re-running the same note must land on the same
 *  filename — this list is what says whether it did. */
function notepadRuns(sb: Sandbox): string[] {
  const dir = path.join(sb.home, ".agentflow", "runs");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.startsWith("notepad-") && f.endsWith(".json")).sort();
}

/** Start a note as a session. Same QuickPick as `notepad.e2e.ts`'s run test —
 *  `runNotepadItem` shares its kickoff with `explore()`, so even with one repo
 *  discovered it shows a `canPickMany` picker with nothing pre-checked; a plain
 *  keyboard Space lands in the filter box rather than on the row, so the row is
 *  CLICKED to toggle it and only then confirmed. */
async function startNote(pool: Pool, title: string): Promise<void> {
  await pool.note(title).getByRole("button", { name: /start/i }).click();
  const quickInput = pool.page.locator(".quick-input-widget");
  await expect(quickInput).toBeVisible({ timeout: 30_000 });
  await pool.page.locator(".quick-input-list .quick-input-list-entry", { hasText: "rocket" }).click();
  await pool.page.keyboard.press("Enter");
}

/** Let every window this journey opened finish activating.
 *
 *  A Notepad run opens a REAL second window (`agentFlow.openIn: "new-window"`),
 *  and `describeWithHost`'s `afterAll` closes the Electron app. Closing while a
 *  window is still mid-activation hangs indefinitely — `review-launch.e2e.ts`
 *  documents that failure mode in full, having hit it. That file collects
 *  `app.on("window")` events; `describeWithHost` hands out no `app`, so the
 *  windows are read off the page's own context instead, which for an Electron
 *  app is the same set. */
async function settleWindows(page: Page, expected?: number): Promise<void> {
  const context = page.context();
  if (expected !== undefined) {
    await expect.poll(() => context.pages().length, { timeout: 150_000 }).toBeGreaterThanOrEqual(expected);
  } else {
    // No count to wait FOR — only a beat for a window that may still be on its
    // way, so it is booted rather than half-open when the app closes.
    await page.waitForTimeout(5_000);
  }
  for (const p of context.pages()) {
    await p.locator(".activitybar").waitFor({ timeout: 120_000 });
  }
}

describeWithHost("notepad edges", {}, (ctx) => {
  // Mutation-checked: made the menu render Clear completed unconditionally
  // (Notepad.tsx `{anyDone && (` → `{true && (`).
  test("Clear completed appears only when a note is done", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await pool.openNotepad();
    await addNote(pool, "Clear me only when done", "nothing is checked yet");
    await settle(pool);

    // Nothing in this notepad is done yet — this test runs first precisely so
    // that is true of the whole store, not just of the visible list.
    await openMenu(pool);
    await expect(pool.frame.locator(".np-clear")).toHaveCount(0);
    await closeMenu(pool);

    await pool.note("Clear me only when done").locator(".cb").click();
    await settle(pool);

    // `anyDone` reads the whole note list, not the filtered view (Notepad.tsx:118),
    // so the item appears even though the Active filter has just hidden the note
    // that earned it.
    await openMenu(pool);
    await expect(pool.frame.locator(".np-clear")).toBeVisible();
    await shot(ctx.page(), testInfo, "1 · Clear completed offered once a note is done");
    await closeMenu(pool);
    await backToTasks(pool);
  });

  // Mutation-checked: made the list ignore the filter (Notepad.tsx `shown` →
  // `notes.filter(() => true)`).
  test("the list opens on Active and the filter shows done notes only under Done and All", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await pool.openNotepad();
    await addNote(pool, "Filter fixture done", "this one gets checked");
    await settle(pool);
    await pool.note("Filter fixture done").locator(".cb").click();
    await settle(pool);
    await addNote(pool, "Filter fixture active", "this one stays open");
    await settle(pool);

    // "Opens on Active" is genuinely observable here: `filter` is local state
    // initialised to "active" on every mount (Notepad.tsx:91), and switching
    // tabs away and back — which every test in this file does — remounts it.
    await expect(noteFilter(pool, "Active")).toHaveAttribute("aria-pressed", "true");
    await expect(pool.note("Filter fixture active")).toBeVisible();
    await expect(pool.note("Filter fixture done")).toHaveCount(0);

    await noteFilter(pool, "Done").click();
    await expect(pool.note("Filter fixture done")).toBeVisible();
    await expect(pool.note("Filter fixture active")).toHaveCount(0);

    await noteFilter(pool, "All").click();
    await expect(pool.note("Filter fixture done")).toBeVisible();
    await expect(pool.note("Filter fixture active")).toBeVisible();
    await shot(ctx.page(), testInfo, "2 · All shows both");
    await backToTasks(pool);
  });

  // Mutation-checked: made Save send the note's stored title instead of the
  // edited one (Notepad.tsx `title` → `note.title` in the update message).
  test("editing a note saves the new title", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await pool.openNotepad();
    await addNote(pool, "Rename me in place", "body is left alone");
    await settle(pool);

    await pool.note("Rename me in place").getByRole("button", { name: "Edit note" }).click();
    // The editing row replaces its own contents with `.edit` (Notepad.tsx:597),
    // and only one row can be editing at a time — so this is unambiguous even
    // though the add form above carries a `.np-title-input` of its own.
    const editRow = pool.frame.locator(".np-item .edit");
    await expect(editRow).toBeVisible();
    await editRow.locator(".np-title-input").fill("Renamed and saved");
    await editRow.getByRole("button", { name: "Save" }).click();

    await expect(pool.note("Renamed and saved")).toBeVisible();
    await expect(pool.note("Rename me in place")).toHaveCount(0);
    // The body is what says the note was UPDATED rather than replaced.
    await expect(pool.note("Renamed and saved")).toContainText("body is left alone");
    await shot(ctx.page(), testInfo, "3 · title saved");
    await backToTasks(pool);
  });

  // Mutation-checked: made the host's notepad:delete handler a no-op
  // (tasksView.ts `case "notepad:delete"` → `break` before deleteNote).
  test("deleting a note removes it", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await pool.openNotepad();
    await addNote(pool, "Delete me and nothing else", "goes away");
    await settle(pool);

    const before = await pool.notes().count();
    await pool.note("Delete me and nothing else").getByRole("button", { name: "Delete note" }).click();

    await expect(pool.note("Delete me and nothing else")).toHaveCount(0);
    // Exactly one fewer: the count is the control that says the delete took the
    // note it was asked for and not the list.
    await expect(pool.notes()).toHaveCount(before - 1);
    await shot(ctx.page(), testInfo, "4 · note deleted");
    await backToTasks(pool);
  });

  // Mutation-checked: made the menu render Reset order unconditionally
  // (Notepad.tsx `{ordered && (` → `{true && (`).
  test("Reset order appears only after a drag", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await pool.openNotepad();
    // Three so the drag has somewhere to go and the newest-first claim has
    // something to be true OF.
    await addNote(pool, "Order fixture alpha", "first added");
    await settle(pool);
    await addNote(pool, "Order fixture beta", "second added");
    await settle(pool);
    await addNote(pool, "Order fixture gamma", "third added");
    await settle(pool);

    // No manual order has ever been saved in this host — `ordered` is
    // `noteOrder().length > 0` (tasksView.ts:526) and nothing before this test
    // drags anything.
    await openMenu(pool);
    await expect(pool.frame.getByRole("menuitem", { name: "Reset order" })).toHaveCount(0);
    await closeMenu(pool);

    // Newest-first with no manual order (tasksView.ts's `orderedNotes`).
    await expect(pool.notes().nth(0)).toContainText("Order fixture gamma");
    // 0 → 2, the same span `notepad.e2e.ts` drags, and deliberately not 0 → 1:
    // the mouse lands on the target row's exact centre, and `dropPos`
    // (Notepad.tsx:653) resolves that to "before" — dropping gamma BEFORE beta
    // is a reorder message whose order is the order it already had, so the list
    // does not move and the test cannot tell a working drag from a dead one
    // (this is what a first pass at this test actually saw). Landing on the
    // THIRD row means beta takes the top whichever side of alpha gamma lands.
    await dragNoteTo(pool, 0, 2);
    await expect(pool.notes().nth(0)).toContainText("Order fixture beta", { timeout: 15_000 });

    await openMenu(pool);
    const reset = pool.frame.getByRole("menuitem", { name: "Reset order" });
    await expect(reset).toBeVisible();
    await shot(ctx.page(), testInfo, "5 · Reset order offered after a drag");
    // The item closes the menu itself (Notepad.tsx:331).
    await reset.click();
    await expect(pool.notes().nth(0)).toContainText("Order fixture gamma", { timeout: 15_000 });

    // And the offer is gone again, which is what leaves the host in the state
    // this test found it in.
    await openMenu(pool);
    await expect(pool.frame.getByRole("menuitem", { name: "Reset order" })).toHaveCount(0);
    await closeMenu(pool);
    await backToTasks(pool);
  });

  // Mutation-checked: raised the store's cap out of reach
  // (notepadImages.ts `MAX_IMAGE_BYTES = 10 * 1024 * 1024` → `* 1024 * 1024 * 1024`).
  test("a dropped image renders a thumbnail and an oversize one is refused", async ({}, testInfo) => {
    test.setTimeout(240_000);
    const pool = await Pool.open(ctx.page(), 2);
    await pool.openNotepad();
    await addNote(pool, "Screenshot goes here", "an image is dropped on this row");
    await settle(pool);

    const row = pool.note("Screenshot goes here");
    const before = storedImages(ctx.sb()).length;

    await dropImageOn(row, "dropped.png", { base64: TINY_PNG });
    // The thumbnail is a full round trip: the webview read the File, the host
    // wrote the bytes and handed back a webview URI, and `ImageStrip`
    // (Notepad.tsx:513-541) rendered it.
    const thumb = row.locator(".np-thumb img");
    await expect(thumb).toHaveCount(1, { timeout: 60_000 });
    await expect(thumb).toHaveAttribute("alt", "dropped.png");
    // And the bytes really are on disk in the global image store.
    await expect.poll(() => storedImages(ctx.sb()).length, { timeout: 30_000 }).toBe(before + 1);
    await shot(ctx.page(), testInfo, "6 · dropped image thumbnail");

    // 11 MB against a 10 MB cap. The refusal is the store's own copy
    // (notepadImages.ts:47) surfaced through the webview's toast — NOT a
    // workbench notification: `tasksView.ts`'s `toast()` posts a message the
    // webview renders (see `Pool.toasts`).
    await dropImageOn(row, "oversize.png", { bytes: 11 * 1024 * 1024 });
    await expect(pool.toasts("error", /larger than 10 MB/)).toBeVisible({ timeout: 90_000 });
    await shot(ctx.page(), testInfo, "7 · oversize refused");
    // Refused means nothing was written — the toast alone would be satisfied by
    // a host that wrote the file and complained anyway.
    expect(storedImages(ctx.sb()).length).toBe(before + 1);
    await expect(thumb).toHaveCount(1);

    // The error toast stays until clicked (`Pool.toasts`), and it overlays the
    // list the next test drives — dismiss it here.
    await pool.toasts("error", /larger than 10 MB/).click();
    await backToTasks(pool);
  });

  // Kept LAST: this is the one test in this file that opens windows, so nothing
  // after it can inherit a half-booted one — the same precaution `notepad.e2e.ts`
  // takes with its own run test.
  //
  // Mutation-checked: made the run key unique per launch (tasksView.ts
  // `notepad-${slugify(...)}-${note.id}` → `…-${note.id}-${Date.now()}`).
  test("re-running a note replaces its earlier run record", async ({}, testInfo) => {
    test.setTimeout(420_000);
    const pool = await Pool.open(ctx.page(), 2);
    await pool.openNotepad();
    await addNote(pool, "Run me twice over", "the second run must not pile up");
    await settle(pool);

    const sb = ctx.sb();
    expect(notepadRuns(sb)).toHaveLength(0);

    await startNote(pool, "Run me twice over");
    await expect.poll(() => notepadRuns(sb), { timeout: 120_000 }).toHaveLength(1);
    const runFile = path.join(sb.home, ".agentflow", "runs", notepadRuns(sb)[0]);
    const first = JSON.parse(fs.readFileSync(runFile, "utf8")) as { kind?: string; createdAt: number };
    expect(first.kind).toBe("notepad");
    await shot(ctx.page(), testInfo, "8 · first run recorded");

    // The first launch's own window has to finish booting before the second
    // launch drives more pickers in this one — and before the suite closes the
    // app at all.
    await settleWindows(ctx.page(), 2);

    await startNote(pool, "Run me twice over");
    // Same key means the same FILE, so "it ran again" cannot be read from the
    // directory listing — it is read from the record being rewritten.
    await expect
      .poll(() => JSON.parse(fs.readFileSync(runFile, "utf8")).createdAt as number, { timeout: 120_000 })
      .toBeGreaterThan(first.createdAt);
    // …and that rewrite replaced the record rather than adding a second one.
    expect(notepadRuns(sb)).toHaveLength(1);
    await shot(ctx.page(), testInfo, "9 · second run replaced it");

    // No count this time: the second launch names the SAME folder as the first,
    // and the workbench reveals the window already open on it rather than
    // minting a third (measured — a first pass at this test waited 150s for a
    // third window that never comes). Every window there IS must still be
    // finished booting before the suite closes the app.
    await settleWindows(ctx.page());
    await backToTasks(pool);
  });
});
