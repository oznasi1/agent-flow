# Notepad Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user attach images to a notepad note's description — by paste, file drop, or an Attach button — see them as thumbnails in the panel, and have them reach the agent as real files when the note is started.

**Architecture:** Image bytes live on disk under `<globalStorageUri>/notepad-images/`, never in `globalState`. A new pure module `src/notepadImages.ts` owns that directory (fs allowed, no `vscode`). Each note stores lightweight `NotepadImage` records; the host derives webview URIs per post, the way it already derives `runStatus`. On Start, the files are copied next to the brief into the already-git-excluded `.pick-task/images/`, and both the brief and the seeded prompt name their repo-relative paths.

**Tech Stack:** TypeScript, VS Code extension API, React (webview, no framework beyond it), esbuild, Vitest (+ jsdom and @testing-library/react for webview tests). The `vscode` module is mocked in `test/_mocks/vscode.ts`.

**Spec:** `docs/superpowers/specs/2026-08-13-notepad-images-design.md` — read it before Task 1.

## Global Constraints

- **The feature ships inert.** Thousands of installs exist. A user who never attaches an image must see today's notepad exactly, and **the existing test suite must pass unmodified.** Two consequences that are easy to miss and are load-bearing:
  - `test/webview/Notepad.test.tsx` asserts `notepad:add` is called with exactly `{ type, title, body }`. The webview must therefore include an `images` key **only when at least one image is pending**.
  - `NotepadItemView.imageUris` must be **optional and omitted** when a note has no images, so tests asserting posted note shapes keep passing.
- **`src/webview/**` must never import `fs`, `os`, `path`, or `child_process`, even transitively.** `tsc` and the full Vitest suite both pass when this rule is broken; only `npm run build` catches it. Run it.
- **Gates, all four, before any task is called done:** `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:cov` (thresholds enforced; changed files ≥95%).
- **Accepted mime types, verbatim:** `image/png`, `image/jpeg`, `image/gif`, `image/webp`. Extension is derived from the accepted mime (`png`, `jpg`, `gif`, `webp`) and never taken from the incoming filename.
- **Size cap:** 10 MB (`10 * 1024 * 1024` bytes). Over the cap is a refusal with a toast, never a silent drop.
- **Ids** are minted the way note and section ids already are in `tasksView.ts`: `` `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` ``, at the call site, so `notepadImages.ts` stays clock-free.
- **Comment style:** this codebase's comments explain *why*, at length, and are part of the review bar. Match the density of `src/notepad.ts` and `src/webview/Notepad.tsx`; do not add narration comments that restate the code.
- **Commit per task**, using the repo's Conventional Commit style (`feat(notepad): …`, `test(notepad): …`).

---

### Task 1: The image store and the note model

**Files:**
- Create: `src/notepadImages.ts`
- Modify: `src/types.ts` (add `NotepadImage`, `PendingImage`; extend `NotepadItem`, `NotepadItemView`)
- Modify: `src/notepad.ts:65-84` (`sanitizeNotes`)
- Create test: `test/unit/notepadImages.test.ts`
- Modify test: `test/unit/notepad.test.ts` (append a describe block for the new field)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface NotepadImage { id: string; ext: string; name: string }`
  - `interface PendingImage { dataBase64: string; mime: string; name: string }`
  - `NotepadItem.images?: NotepadImage[]`, `NotepadItemView.imageUris?: string[]`
  - `IMAGE_DIR = "notepad-images"`, `MAX_IMAGE_BYTES = 10 * 1024 * 1024`
  - `saveImage(dir: string, bytes: Uint8Array, mime: string, name: string, id: string): SaveResult`
    where `type SaveResult = { ok: true; image: NotepadImage } | { ok: false; reason: string }`
  - `imageFileName(image: NotepadImage): string`
  - `imagePath(dir: string, image: NotepadImage): string`
  - `deleteImages(dir: string, images: readonly NotepadImage[]): void`
  - `sweepOrphans(dir: string, keep: ReadonlySet<string>): number`

- [ ] **Step 1: Add the types**

In `src/types.ts`, beside the existing notepad types (near `NotepadItem`):

```ts
/** One image attached to a note. `ext` comes from the accepted mime, never from
 * the source filename — a file called `screenshot.png` that is really a PDF must
 * not end up stored as `.png`. `name` is the user's own filename, kept only for
 * display and for naming the copy that reaches the agent. The bytes live at
 * `<globalStorageUri>/notepad-images/<id>.<ext>`; nothing about them is in
 * `globalState`, which is serialised into the webview on every poll and rides
 * Settings Sync. */
export interface NotepadImage {
  id: string;
  ext: string;
  name: string;
}

/** An image the webview holds but the host has not written yet — the add form has
 * no note id to attach to, so pending bytes ride along with `notepad:add` rather
 * than giving the host a second lifetime (a draft store) to reason about. */
export interface PendingImage {
  dataBase64: string;
  mime: string;
  name: string;
}
```

Extend `NotepadItem` with `images?: NotepadImage[];` (comment: absent means no images, which is what every existing install has — no migration to get wrong).

Extend the `NotepadItemView` alias at `src/types.ts:418`:

```ts
export type NotepadItemView = NotepadItem & {
  runStatus?: NotepadRunStatus;
  /** Webview-safe URIs for `images`, positionally parallel to it. Derived per post
   * from `asWebviewUri` and never persisted, same as `runStatus` — the webview has
   * no `vscode.Uri` and must not reach `fs`. Omitted entirely when the note has no
   * images, so an untouched note posts byte-identically to before this existed. */
  imageUris?: string[];
};
```

- [ ] **Step 2: Write the failing tests for the store**

Create `test/unit/notepadImages.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  MAX_IMAGE_BYTES,
  deleteImages,
  imagePath,
  saveImage,
  sweepOrphans,
} from "../../src/notepadImages";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "np-img-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe("saveImage", () => {
  it("writes the bytes under <id>.<ext> and returns the record", () => {
    const r = saveImage(dir, png(), "image/png", "shot.png", "img1");
    expect(r).toEqual({ ok: true, image: { id: "img1", ext: "png", name: "shot.png" } });
    expect(fs.readFileSync(path.join(dir, "img1.png"))).toEqual(Buffer.from(png()));
  });

  it("creates the directory when it does not exist yet", () => {
    const nested = path.join(dir, "notepad-images");
    expect(saveImage(nested, png(), "image/png", "a.png", "img1").ok).toBe(true);
    expect(fs.existsSync(path.join(nested, "img1.png"))).toBe(true);
  });

  it("derives the extension from the mime, not from the filename", () => {
    const r = saveImage(dir, png(), "image/jpeg", "lying.png", "img2");
    expect(r).toMatchObject({ ok: true, image: { ext: "jpg" } });
    expect(fs.existsSync(path.join(dir, "img2.jpg"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "img2.png"))).toBe(false);
  });

  it("accepts every supported mime, case-insensitively", () => {
    expect(saveImage(dir, png(), "IMAGE/PNG", "a", "a").ok).toBe(true);
    expect(saveImage(dir, png(), "image/gif", "b", "b")).toMatchObject({ image: { ext: "gif" } });
    expect(saveImage(dir, png(), "image/webp", "c", "c")).toMatchObject({ image: { ext: "webp" } });
  });

  it("refuses an unsupported type by mime, naming the file, and writes nothing", () => {
    const r = saveImage(dir, png(), "application/pdf", "paper.pdf", "img3");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("paper.pdf");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("refuses bytes over the cap and writes nothing", () => {
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    const r = saveImage(dir, big, "image/png", "huge.png", "img4");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("10 MB");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("accepts bytes exactly at the cap", () => {
    expect(saveImage(dir, new Uint8Array(MAX_IMAGE_BYTES), "image/png", "edge.png", "img5").ok).toBe(true);
  });

  it("falls back to a generated display name when the source has none", () => {
    expect(saveImage(dir, png(), "image/png", "   ", "img6")).toMatchObject({
      image: { name: "image.png" },
    });
  });
});

describe("deleteImages", () => {
  it("unlinks each file", () => {
    saveImage(dir, png(), "image/png", "a.png", "a");
    saveImage(dir, png(), "image/png", "b.png", "b");
    deleteImages(dir, [{ id: "a", ext: "png", name: "a.png" }]);
    expect(fs.readdirSync(dir)).toEqual(["b.png"]);
  });

  it("tolerates a file that is already gone", () => {
    expect(() => deleteImages(dir, [{ id: "ghost", ext: "png", name: "g.png" }])).not.toThrow();
  });
});

describe("sweepOrphans", () => {
  it("deletes only the files no note references, and reports the count", () => {
    saveImage(dir, png(), "image/png", "keep.png", "keep");
    saveImage(dir, png(), "image/png", "drop.png", "drop");
    expect(sweepOrphans(dir, new Set(["keep"]))).toBe(1);
    expect(fs.readdirSync(dir)).toEqual(["keep.png"]);
  });

  it("is a no-op — not a throw — when the directory does not exist", () => {
    expect(sweepOrphans(path.join(dir, "nope"), new Set())).toBe(0);
  });

  it("keeps a referenced file whatever its extension", () => {
    saveImage(dir, png(), "image/webp", "a.webp", "a");
    expect(sweepOrphans(dir, new Set(["a"]))).toBe(0);
    expect(fs.readdirSync(dir)).toEqual(["a.webp"]);
  });
});

describe("imagePath", () => {
  it("joins the directory with <id>.<ext>", () => {
    expect(imagePath("/store", { id: "i", ext: "gif", name: "n" })).toBe(path.join("/store", "i.gif"));
  });
});
```

- [ ] **Step 3: Run the tests and verify they fail**

Run: `npx vitest run test/unit/notepadImages.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/notepadImages"`.

- [ ] **Step 4: Write the store**

Create `src/notepadImages.ts`:

```ts
// The notepad's image store. Same purity bar as `src/notepad.ts`: no `vscode` and
// no mocked extension context, so every test here runs against a real temp dir —
// `fs` is fine (that file's own `canon` touches it for the same reason), the
// directory is passed in rather than resolved from an extension context.
import * as fs from "fs";
import * as path from "path";
import { NotepadImage } from "./types";

/** Subdirectory of `globalStorageUri` the bytes live in. */
export const IMAGE_DIR = "notepad-images";

/** Refusal threshold. A screenshot is well under this; a video frame dump or a
 * mis-dropped archive is not, and `globalStorage` is not the place to find out. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// Mime → extension. This map is the whitelist: an unlisted type is refused, so a
// dropped PDF or .mov can never reach the store. The extension is taken from here
// and not from the incoming filename, which the sender controls and can lie about.
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export type SaveResult = { ok: true; image: NotepadImage } | { ok: false; reason: string };

/** Write one image. `id` is injected (see the ids note in the plan/spec) so this
 * stays clock- and randomness-free and its tests need no stubs. A refusal writes
 * nothing at all — the reason is user-facing copy, ready for a toast. */
export function saveImage(
  dir: string,
  bytes: Uint8Array,
  mime: string,
  name: string,
  id: string,
): SaveResult {
  const label = name.trim() || "That file";
  const ext = EXT_BY_MIME[mime.trim().toLowerCase()];
  if (!ext) return { ok: false, reason: `${label} is not a supported image (PNG, JPEG, GIF or WebP).` };
  if (bytes.byteLength > MAX_IMAGE_BYTES) return { ok: false, reason: `${label} is larger than 10 MB.` };
  fs.mkdirSync(dir, { recursive: true });
  const image: NotepadImage = { id, ext, name: name.trim() || `image.${ext}` };
  fs.writeFileSync(imagePath(dir, image), bytes);
  return { ok: true, image };
}

export function imageFileName(image: NotepadImage): string {
  return `${image.id}.${image.ext}`;
}

export function imagePath(dir: string, image: NotepadImage): string {
  return path.join(dir, imageFileName(image));
}

/** Best-effort unlink. A file already gone is the normal case after a crash
 * between the unlink and the state write, not an error worth surfacing. */
export function deleteImages(dir: string, images: readonly NotepadImage[]): void {
  for (const image of images) {
    try {
      fs.unlinkSync(imagePath(dir, image));
    } catch {
      // already gone — nothing to do
    }
  }
}

/** Delete every file no note references, returning how many went. Every other
 * cleanup path is a best-effort write that a crash, a hand-edited state file, or
 * an older version can leave half-done; without this the directory only grows.
 * `keep` holds image ids — the filename stem — not filenames, because the caller
 * reads records, not the disk. */
export function sweepOrphans(dir: string, keep: ReadonlySet<string>): number {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0; // nothing was ever attached
  }
  let removed = 0;
  for (const entry of entries) {
    const stem = entry.replace(/\.[^.]+$/, "");
    if (keep.has(stem)) continue;
    try {
      fs.unlinkSync(path.join(dir, entry));
      removed++;
    } catch {
      // raced with another window's sweep — the file is gone either way
    }
  }
  return removed;
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npx vitest run test/unit/notepadImages.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Write the failing tests for `sanitizeNotes`**

Append to `test/unit/notepad.test.ts` inside its existing top level (matching the file's existing `describe("sanitizeNotes", …)` style — put these in that block if it exists, otherwise add a new one):

```ts
describe("sanitizeNotes — images", () => {
  it("keeps a well-formed images array", () => {
    const raw = [{ id: "n1", title: "t", body: "b", images: [{ id: "i1", ext: "png", name: "a.png" }] }];
    expect(sanitizeNotes(raw)[0].images).toEqual([{ id: "i1", ext: "png", name: "a.png" }]);
  });

  it("leaves a legacy note without the field untouched", () => {
    expect(sanitizeNotes([{ id: "n1", title: "t", body: "b" }])[0]).not.toHaveProperty("images");
  });

  it("drops the field entirely when it is not an array", () => {
    expect(sanitizeNotes([{ id: "n1", images: "nope" }])[0]).not.toHaveProperty("images");
  });

  it("drops a malformed entry while keeping its siblings", () => {
    const raw = [{
      id: "n1",
      images: [
        { id: "good", ext: "png", name: "a.png" },
        { id: "", ext: "png", name: "b.png" },
        { id: "noext", name: "c.png" },
        "junk",
      ],
    }];
    expect(sanitizeNotes(raw)[0].images).toEqual([{ id: "good", ext: "png", name: "a.png" }]);
  });

  it("coerces a missing name rather than dropping the image", () => {
    const raw = [{ id: "n1", images: [{ id: "i1", ext: "gif" }] }];
    expect(sanitizeNotes(raw)[0].images).toEqual([{ id: "i1", ext: "gif", name: "image.gif" }]);
  });

  it("omits the field when every entry was malformed", () => {
    expect(sanitizeNotes([{ id: "n1", images: [{ ext: "png" }] }])[0]).not.toHaveProperty("images");
  });
});
```

- [ ] **Step 7: Run and verify they fail**

Run: `npx vitest run test/unit/notepad.test.ts`
Expected: FAIL — the images assertions fail because `sanitizeNotes` drops the field.

- [ ] **Step 8: Coerce images in `sanitizeNotes`**

In `src/notepad.ts`, inside `sanitizeNotes`'s loop, after the `sectionId` line:

```ts
    const images = sanitizeImages(e.images);
    if (images.length > 0) note.images = images;
```

and add above `sanitizeNotes`:

```ts
/** A note's images as read back from untyped storage. An entry with no usable id
 * or no usable ext is dropped rather than defaulted: a record that names no
 * readable file is not an attachment, and a guessed extension would point the
 * webview at a URI that 404s. `name` is display-only, so it is coerced. The field
 * is left OFF the note when nothing survives, so a note that never had images
 * posts byte-identically to before this existed. */
function sanitizeImages(raw: unknown): NotepadImage[] {
  if (!Array.isArray(raw)) return [];
  const out: NotepadImage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || e.id.length === 0) continue;
    if (typeof e.ext !== "string" || e.ext.length === 0) continue;
    const name = typeof e.name === "string" && e.name.trim().length > 0 ? e.name : `image.${e.ext}`;
    out.push({ id: e.id, ext: e.ext, name });
  }
  return out;
}
```

Add `NotepadImage` to the existing type import at the top of `src/notepad.ts`.

- [ ] **Step 9: Run the full unit suite and typecheck**

Run: `npx vitest run test/unit && npm run typecheck`
Expected: PASS, with no existing test modified.

- [ ] **Step 10: Commit**

```bash
git add src/notepadImages.ts src/types.ts src/notepad.ts test/unit/notepadImages.test.ts test/unit/notepad.test.ts
git commit -m "feat(notepad): add the image store and the note image model"
```

---

### Task 2: Post image URIs to the webview (read path)

**Files:**
- Modify: `test/_helpers/factories.ts:100-124` (`fakeContext` gains `globalStorageUri`)
- Modify: `src/tasksView.ts:178-186` (`localResourceRoots`), `:329-345` (`postNotepad`), plus a private `imageDir()`
- Modify test: `test/unit/tasksView.test.ts` — including its notepad-block `mkProvider()` helper at `:4425`

**Interfaces:**
- Consumes: `IMAGE_DIR`, `imageFileName` (Task 1); `NotepadItemView.imageUris`.
- Produces: `private imageDir(): string` on `TasksViewProvider` — the absolute path of `<globalStorageUri>/notepad-images`, used by Tasks 3, 4 and 6. `fakeContext(...).context.globalStorageUri` with `fsPath: "/globalstorage"` by default.

**Test scaffolding, verified — do not invent a new harness:**
- The notepad tests use a local `mkProvider()` (`test/unit/tasksView.test.ts:4425`) returning `{ provider, posted, store, sendMsg }`. It seeds notes by writing `store.set("agentFlow.notepad", […])` before driving a message, and `notesIn(store)` reads them back.
- **`test/unit/tasksView.test.ts` does not mock `fs`, and must not start.** Every image assertion in Tasks 2–6 runs against a real `fs.mkdtempSync` directory.
- `mkProvider`'s stand-in webview has only `postMessage`. `postNotepad` now calls `asWebviewUri`, so the stub needs it — extend `mkProvider` once, in this task, as its first step.
- The panel's other helper, `setup()` (`:274`), *does* call `resolveWebviewView` against a webview with `options: {}` and `asWebviewUri`. Use `setup()` for the `localResourceRoots` assertion; `mkProvider` never resolves a view.

- [ ] **Step 1: Give `fakeContext` a `globalStorageUri`**

In `test/_helpers/factories.ts`, beside the existing `extensionUri` line inside `fakeContext`:

```ts
  // Mirrors extensionUri's shape — the notepad image store resolves under this,
  // and Uri.joinPath in the vscode mock reads `.fsPath`.
  const globalStorageUri = { fsPath: "/globalstorage", scheme: "file", toString: () => "/globalstorage" };
```

Add `globalStorageUri` to the object literal cast to `vscode.ExtensionContext`, and to the returned record (`return { context, workspaceState, globalState, secrets, extensionUri, globalStorageUri };`).

- [ ] **Step 2: Extend `mkProvider` for images**

In the notepad describe block of `test/unit/tasksView.test.ts`, change `mkProvider()` so it owns a real image directory and a webview that can convert URIs. Every later task's tests depend on this:

```ts
  function mkProvider() {
    // A real directory, because this file does NOT mock `fs` — the image store
    // writes and unlinks for real here, and the assertions read the disk.
    const imageDir = fs.mkdtempSync(path.join(os.tmpdir(), "np-img-"));
    const store = new Map<string, unknown>();
    const ctx = {
      ...fakeContext(),
      // Top level, not nested: the provider reads `this.context.globalStorageUri`,
      // and what this object spreads in is fakeContext's RESULT, not its context.
      globalStorageUri: { fsPath: imageDir, scheme: "file", toString: () => imageDir },
      globalState: {
        get: (k: string, d?: unknown) => (store.has(k) ? store.get(k) : d),
        update: async (k: string, v: unknown) => void store.set(k, v),
      },
    } as unknown as ConstructorParameters<typeof TasksViewProvider>[0];
    const posted: unknown[] = [];
    const provider = new TasksViewProvider(ctx, makeFixtureConnector(), () => {});
    (provider as unknown as { view: unknown }).view = {
      webview: {
        postMessage: (m: unknown) => void posted.push(m),
        // postNotepad converts each image path through this — the previous stub
        // had only postMessage, so a note with images would throw.
        asWebviewUri: (u: unknown) => u,
      },
    };
    const sendMsg = (m: InboundMessage) =>
      (provider as unknown as { onMessage(m: InboundMessage): Promise<void> }).onMessage(m);
    return { provider, posted, store, sendMsg, imageDir };
  }
```

Add `fs`, `os` and `path` imports to the file if it lacks them, and register an `afterEach` in the notepad block that removes the directories it made (`fs.rmSync(dir, { recursive: true, force: true })`) — collect them in an array as `mkProvider` runs.

- [ ] **Step 3: Write the failing tests**

```ts
  it("posts one imageUris entry per stored image, and omits the field otherwise", async () => {
    const { provider, posted, store } = mkProvider();
    store.set("agentFlow.notepad", [
      { id: "n1", title: "with", body: "", done: false, createdAt: 1,
        images: [{ id: "i1", ext: "png", name: "a.png" }, { id: "i2", ext: "webp", name: "b.webp" }] },
      { id: "n2", title: "without", body: "", done: false, createdAt: 2 },
    ]);
    provider.postNotepad();
    const last = posted.at(-1) as { type: string; notes: { imageUris?: string[] }[] };
    expect(last.type).toBe("notepad:notes");
    const [withImages, without] = last.notes;
    expect(withImages.imageUris).toHaveLength(2);
    expect(String(withImages.imageUris![0])).toContain("notepad-images/i1.png");
    expect(String(withImages.imageUris![1])).toContain("i2.webp");
    expect(without).not.toHaveProperty("imageUris");
  });

  it("allows the image store as a webview resource root", () => {
    const { view } = setup();
    const roots = ((view.webview.options as { localResourceRoots?: { fsPath: string }[] }).localResourceRoots ?? [])
      .map((u) => u.fsPath);
    expect(roots).toContain("/ext");
    expect(roots).toContain("/globalstorage");
  });
```

The second test belongs beside the file's other `setup()`-based tests, not in the notepad block — `setup()` is what resolves a view, and it reads `globalStorageUri` from `fakeContext`, hence the `/globalstorage` default added in Step 1.

- [ ] **Step 4: Run and verify they fail**

Run: `npx vitest run test/unit/tasksView.test.ts`
Expected: FAIL — `imageUris` is undefined on the first note, and `localResourceRoots` holds only `/ext`.

- [ ] **Step 5: Implement the read path**

In `src/tasksView.ts`, import `IMAGE_DIR` and `imageFileName` from `./notepadImages`, then:

Extend the resolve options at `:180`:

```ts
    view.webview.options = {
      enableScripts: true,
      // The notepad's images live under globalStorage, outside the extension
      // bundle — without this root every thumbnail 404s. The CSP needs no change:
      // `img-src` already allows `webview.cspSource`.
      localResourceRoots: [this.context.extensionUri, this.context.globalStorageUri],
    };
```

Add the private helper beside the other notepad helpers:

```ts
  /** Absolute path of the notepad's image store. One place computes it so the
   * host, the sweep, and the run handoff cannot drift onto different directories. */
  private imageDir(): string {
    return path.join(this.context.globalStorageUri.fsPath, IMAGE_DIR);
  }
```

In `postNotepad`, replace the `view` mapping with:

```ts
    const webview = this.view?.webview;
    const view: NotepadItemView[] = notes.map((n) => {
      const runStatus = noteStatus(n, runs, livePlaces);
      const base: NotepadItemView = runStatus ? { ...n, runStatus } : { ...n };
      const images = n.images ?? [];
      // One entry per STORED image, positionally parallel to `images`: a file that
      // vanished under us renders as a broken thumbnail rather than shifting every
      // later index onto the wrong record. Removing files is the sweep's job, never
      // the poll's. Without a webview there is nothing to convert against — the
      // post is a no-op in that state anyway.
      if (images.length === 0 || !webview) return base;
      return {
        ...base,
        imageUris: images.map((img) =>
          webview
            .asWebviewUri(vscode.Uri.joinPath(this.context.globalStorageUri, IMAGE_DIR, imageFileName(img)))
            .toString(),
        ),
      };
    });
```

- [ ] **Step 6: Run and verify they pass**

Run: `npx vitest run test/unit/tasksView.test.ts test/unit/extension.test.ts`
Expected: PASS, including every pre-existing notepad test.

- [ ] **Step 7: Commit**

```bash
git add src/tasksView.ts test/_helpers/factories.ts test/unit/tasksView.test.ts
git commit -m "feat(notepad): post webview URIs for a note's attached images"
```

---

### Task 3: Attach, remove, and open images (write path)

**Files:**
- Modify: `src/types.ts` (four inbound message types; `notepad:add` gains `images?`)
- Modify: `src/tasksView.ts:347-358` (`addNote`), `:585-588` (`notepad:add` case), plus new cases and handlers
- Modify test: `test/unit/tasksView.test.ts`

**Interfaces:**
- Consumes: `imageDir()` (Task 2); `saveImage`, `imagePath` (Task 1); `PendingImage`.
- Produces: inbound messages `notepad:addImage { id, dataBase64, mime, name }`, `notepad:pickImage { id }`, `notepad:removeImage { id, imageId }`, `notepad:openImage { id, imageId }`; `addNote(title, body, images?: PendingImage[])`.

- [ ] **Step 1: Add the message types**

In `src/types.ts`, in the `InboundMessage` union beside the other `notepad:` entries:

```ts
  | { type: "notepad:add"; title: string; body: string; images?: PendingImage[] }
  /** Paste or file-drop onto a saved note. Base64 because postMessage is a JSON
   * channel; this is one message per attachment, never something the poll repeats. */
  | { type: "notepad:addImage"; id: string; dataBase64: string; mime: string; name: string }
  /** The Attach button. The host runs the file picker and reads the bytes itself,
   * so nothing is encoded across the wire for this path. */
  | { type: "notepad:pickImage"; id: string }
  | { type: "notepad:removeImage"; id: string; imageId: string }
  /** A thumbnail click. Carries the note id too so the host can look the record up
   * and learn the extension — the webview only ever holds the derived URI. */
  | { type: "notepad:openImage"; id: string; imageId: string }
```

(Replace the existing `notepad:add` line with the version above; do not add a second one.)

`MESSAGE_OPS` in `tasksView.ts` needs no entries — it attributes telemetry ops for task-source messages only, and the existing `notepad:add`/`notepad:delete` are absent from it too.

- [ ] **Step 2: Write the failing tests**

Real disk throughout — `mkProvider` from Task 2 hands back the `imageDir` it owns, and `notesIn(store)` is the file's existing reader.

```ts
  const imagesOf = (store: Map<string, unknown>, i = 0) =>
    (store.get("agentFlow.notepad") as { images?: { id: string; ext: string; name: string }[] }[])[i].images;

  const seedNote = (store: Map<string, unknown>, over: Record<string, unknown> = {}) =>
    store.set("agentFlow.notepad", [{ id: "n1", title: "t", body: "", done: false, createdAt: 1, ...over }]);

  it("writes a pasted image and stores its record on the note", async () => {
    const { store, sendMsg, imageDir } = mkProvider();
    seedNote(store);
    await sendMsg({ type: "notepad:addImage", id: "n1", dataBase64: Buffer.from("PNGDATA").toString("base64"), mime: "image/png", name: "shot.png" });
    const images = imagesOf(store)!;
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ ext: "png", name: "shot.png" });
    const written = path.join(imageDir, "notepad-images", `${images[0].id}.png`);
    expect(fs.readFileSync(written, "utf8")).toBe("PNGDATA");
  });

  it("toasts the reason and stores nothing when the type is unsupported", async () => {
    const { store, sendMsg, posted, imageDir } = mkProvider();
    seedNote(store);
    await sendMsg({ type: "notepad:addImage", id: "n1", dataBase64: "AAAA", mime: "application/pdf", name: "paper.pdf" });
    const toast = (posted as { type: string; level?: string; message?: string }[]).find((m) => m.type === "toast");
    expect(toast).toMatchObject({ level: "error" });
    expect(toast!.message).toContain("paper.pdf");
    expect(imagesOf(store)).toBeUndefined();
    expect(fs.existsSync(path.join(imageDir, "notepad-images"))).toBe(false);
  });

  it("ignores an addImage for a note that no longer exists", async () => {
    const { store, sendMsg, imageDir } = mkProvider();
    store.set("agentFlow.notepad", []);
    await sendMsg({ type: "notepad:addImage", id: "gone", dataBase64: "AAAA", mime: "image/png", name: "a.png" });
    expect(fs.existsSync(path.join(imageDir, "notepad-images"))).toBe(false);
  });

  it("attaches the pending images that arrive with notepad:add", async () => {
    const { store, sendMsg } = mkProvider();
    await sendMsg({
      type: "notepad:add",
      title: "New",
      body: "",
      images: [{ dataBase64: Buffer.from("A").toString("base64"), mime: "image/png", name: "a.png" }],
    });
    expect(imagesOf(store)).toHaveLength(1);
  });

  it("adds a note that is nothing but an image", async () => {
    const { store, sendMsg } = mkProvider();
    await sendMsg({
      type: "notepad:add",
      title: "",
      body: "",
      images: [{ dataBase64: Buffer.from("A").toString("base64"), mime: "image/png", name: "a.png" }],
    });
    expect(notesIn(store)).toHaveLength(1);
  });

  it("removes an image from the note and unlinks its file", async () => {
    const { store, sendMsg, imageDir } = mkProvider();
    const dir = path.join(imageDir, "notepad-images");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "i1.png"), "A");
    fs.writeFileSync(path.join(dir, "i2.png"), "B");
    seedNote(store, { images: [{ id: "i1", ext: "png", name: "a.png" }, { id: "i2", ext: "png", name: "b.png" }] });
    await sendMsg({ type: "notepad:removeImage", id: "n1", imageId: "i1" });
    expect(imagesOf(store)!.map((i) => i.id)).toEqual(["i2"]);
    expect(fs.existsSync(path.join(dir, "i1.png"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "i2.png"))).toBe(true);
  });

  it("drops the images key entirely once the last image is removed", async () => {
    const { store, sendMsg, imageDir } = mkProvider();
    fs.mkdirSync(path.join(imageDir, "notepad-images"), { recursive: true });
    fs.writeFileSync(path.join(imageDir, "notepad-images", "i1.png"), "A");
    seedNote(store, { images: [{ id: "i1", ext: "png", name: "a.png" }] });
    await sendMsg({ type: "notepad:removeImage", id: "n1", imageId: "i1" });
    expect((store.get("agentFlow.notepad") as object[])[0]).not.toHaveProperty("images");
  });

  it("reads the picked file itself and attaches it", async () => {
    const { store, sendMsg, imageDir } = mkProvider();
    const src = path.join(imageDir, "pick.png");
    fs.writeFileSync(src, "PICKED");
    window.showOpenDialog.mockResolvedValue([{ fsPath: src }]);
    seedNote(store);
    await sendMsg({ type: "notepad:pickImage", id: "n1" });
    expect(imagesOf(store)![0]).toMatchObject({ ext: "png", name: "pick.png" });
  });

  it("does nothing when the picker is cancelled", async () => {
    const { store, sendMsg } = mkProvider();
    window.showOpenDialog.mockResolvedValue(undefined);
    seedNote(store);
    await sendMsg({ type: "notepad:pickImage", id: "n1" });
    expect(imagesOf(store)).toBeUndefined();
  });

  it("opens a thumbnail through the vscode.open command", async () => {
    const { store, sendMsg } = mkProvider();
    seedNote(store, { images: [{ id: "i1", ext: "gif", name: "a.gif" }] });
    await sendMsg({ type: "notepad:openImage", id: "n1", imageId: "i1" });
    expect(commands.executeCommand).toHaveBeenCalledWith(
      "vscode.open",
      expect.objectContaining({ fsPath: expect.stringContaining(path.join("notepad-images", "i1.gif")) }),
    );
  });
```

`window` and `commands` are already imported from `../_mocks/vscode` at the top of the file, and `test/_setup.ts` resets them per test — `showOpenDialog` defaults to `undefined` (cancelled), so only the tests that need a file set it.

- [ ] **Step 3: Run and verify they fail**

Run: `npx vitest run test/unit/tasksView.test.ts`
Expected: FAIL — the new message types are unhandled, so nothing is written.

- [ ] **Step 4: Implement the handlers**

In `src/tasksView.ts`, add cases beside the existing notepad ones:

```ts
        case "notepad:addImage": {
          await this.attachImage(m.id, Buffer.from(m.dataBase64, "base64"), m.mime, m.name);
          break;
        }
        case "notepad:pickImage": {
          await this.pickImage(m.id);
          break;
        }
        case "notepad:removeImage": {
          await this.removeImage(m.id, m.imageId);
          break;
        }
        case "notepad:openImage": {
          await this.openImage(m.id, m.imageId);
          break;
        }
```

and change the `notepad:add` case to `await this.addNote(m.title, m.body, m.images);`.

The handlers:

```ts
  /** Attach one image to a saved note. A refusal is toasted with the store's own
   * reason rather than swallowed: the user just pasted something and is owed an
   * answer. Unlike title/body — a draft that waits on Save — an attachment is
   * immediate, like toggleDone: it is on disk the moment it lands, and Cancel in
   * the edit form does not take it back. */
  private async attachImage(id: string, bytes: Uint8Array, mime: string, name: string): Promise<void> {
    const note = this.notes().find((n) => n.id === id);
    // A stale view can name a note the store no longer has. Nothing to attach to,
    // and writing the file anyway would seed the sweep with an instant orphan.
    if (!note) return;
    const imageId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const saved = saveImage(this.imageDir(), bytes, mime, name, imageId);
    if (!saved.ok) {
      this.toast("error", saved.reason);
      return;
    }
    await this.saveNotes(
      this.notes().map((n) => (n.id === id ? { ...n, images: [...(n.images ?? []), saved.image] } : n)),
    );
  }

  private async pickImage(id: string): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Attach",
      filters: { Images: ["png", "jpg", "jpeg", "gif", "webp"] },
    });
    const file = picked?.[0];
    if (!file) return;
    // The mime the store validates against comes from the extension here — a file
    // picker hands us a path, not a type. The filter above is a hint the user can
    // defeat, so an unlisted extension still has to fail the store's whitelist.
    const mime = MIME_BY_EXT[path.extname(file.fsPath).slice(1).toLowerCase()] ?? "";
    await this.attachImage(id, fs.readFileSync(file.fsPath), mime, path.basename(file.fsPath));
  }

  private async removeImage(id: string, imageId: string): Promise<void> {
    const note = this.notes().find((n) => n.id === id);
    const image = note?.images?.find((i) => i.id === imageId);
    if (!note || !image) return;
    deleteImages(this.imageDir(), [image]);
    const images = (note.images ?? []).filter((i) => i.id !== imageId);
    await this.saveNotes(
      this.notes().map((n) => (n.id === id ? (images.length > 0 ? { ...n, images } : stripImages(n)) : n)),
    );
  }

  private async openImage(id: string, imageId: string): Promise<void> {
    const image = this.notes().find((n) => n.id === id)?.images?.find((i) => i.id === imageId);
    if (!image) return;
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(imagePath(this.imageDir(), image)));
  }
```

Module-level, beside the other constants in `tasksView.ts`:

```ts
// The inverse of notepadImages' own map, for the one caller that starts from a
// path instead of a clipboard item. Kept here rather than exported from the store
// so the store's whitelist stays the single gate — this only proposes a mime.
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** A note with no images left keeps NO `images` key, so it serialises exactly like
 * a note that never had one — the shape every pre-existing install has. */
function stripImages(note: NotepadItem): NotepadItem {
  const { images: _images, ...rest } = note;
  return rest;
}
```

And extend `addNote`:

```ts
  private async addNote(title: string, body: string, pending?: PendingImage[]): Promise<void> {
    if (!title.trim() && !body.trim() && !(pending && pending.length > 0)) return;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // Written before the note so the single saveNotes (which posts) already carries
    // them — the add form's thumbnails must not blink out and back in.
    const images: NotepadImage[] = [];
    for (const p of pending ?? []) {
      const imageId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const saved = saveImage(this.imageDir(), Buffer.from(p.dataBase64, "base64"), p.mime, p.name, imageId);
      if (saved.ok) images.push(saved.image);
      else this.toast("error", saved.reason);
    }
    const order = this.noteOrder();
    if (order.length > 0) await this.saveNoteOrder([id, ...order]);
    const note = newNote(title, body, id, Date.now());
    await this.saveNotes([...this.notes(), images.length > 0 ? { ...note, images } : note]);
  }
```

Note the guard change: a note that is *only* an image is now worth keeping, where before an empty title and body meant nothing at all.

- [ ] **Step 5: Run and verify they pass**

Run: `npx vitest run test/unit && npm run typecheck`
Expected: PASS, existing tests unmodified.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/tasksView.ts test/unit/tasksView.test.ts
git commit -m "feat(notepad): attach, remove and open note images"
```

---

### Task 4: Cleanup — deletes and the orphan sweep

**Files:**
- Modify: `src/tasksView.ts:370-380` (`deleteNote`, `clearCompletedNotes`), plus a public `sweepNotepadImages()`
- Modify: `src/extension.ts` (call the sweep on activate)
- Modify test: `test/unit/tasksView.test.ts`, `test/unit/extension.test.ts`

**Interfaces:**
- Consumes: `imageDir()` (Task 2); `deleteImages`, `sweepOrphans` (Task 1).
- Produces: `public sweepNotepadImages(): void` on `TasksViewProvider`.

- [ ] **Step 1: Write the failing tests**

Same real-disk harness. A small local helper keeps these readable:

```ts
  /** Put `<id>.png` files on disk in the provider's store and return that dir. */
  const seedFiles = (imageDir: string, ...names: string[]): string => {
    const dir = path.join(imageDir, "notepad-images");
    fs.mkdirSync(dir, { recursive: true });
    for (const n of names) fs.writeFileSync(path.join(dir, n), "A");
    return dir;
  };

  it("unlinks a deleted note's images", async () => {
    const { store, sendMsg, imageDir } = mkProvider();
    const dir = seedFiles(imageDir, "i1.png");
    store.set("agentFlow.notepad", [{ id: "n1", title: "t", body: "", done: false, createdAt: 1,
      images: [{ id: "i1", ext: "png", name: "a.png" }] }]);
    await sendMsg({ type: "notepad:delete", id: "n1" });
    expect(fs.existsSync(path.join(dir, "i1.png"))).toBe(false);
  });

  it("unlinks the images of every note cleared as completed, and only those", async () => {
    const { store, sendMsg, imageDir } = mkProvider();
    const dir = seedFiles(imageDir, "i1.png", "i2.png");
    store.set("agentFlow.notepad", [
      { id: "n1", title: "done", body: "", done: true, createdAt: 1, images: [{ id: "i1", ext: "png", name: "a.png" }] },
      { id: "n2", title: "open", body: "", done: false, createdAt: 2, images: [{ id: "i2", ext: "png", name: "b.png" }] },
    ]);
    await sendMsg({ type: "notepad:clearCompleted" });
    expect(fs.existsSync(path.join(dir, "i1.png"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "i2.png"))).toBe(true);
  });

  it("sweeps image files no note references", () => {
    const { provider, store, imageDir } = mkProvider();
    const dir = seedFiles(imageDir, "i1.png", "orphan.png");
    store.set("agentFlow.notepad", [{ id: "n1", title: "t", body: "", done: false, createdAt: 1,
      images: [{ id: "i1", ext: "png", name: "a.png" }] }]);
    provider.sweepNotepadImages();
    expect(fs.existsSync(path.join(dir, "orphan.png"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "i1.png"))).toBe(true);
  });

  it("is a no-op when nothing was ever attached", () => {
    const { provider } = mkProvider();
    expect(() => provider.sweepNotepadImages()).not.toThrow();
  });
```

The "survives a throw" case cannot be reached on real disk without contriving permissions, and `sweepOrphans` already has its own unit coverage for the unreadable-directory path (Task 1). Do **not** add a `vi.mock("fs")` to this file to chase it.

- [ ] **Step 2: Run and verify they fail**

Run: `npx vitest run test/unit/tasksView.test.ts`
Expected: FAIL — no unlink happens on delete, and `sweepNotepadImages` is not a function.

- [ ] **Step 3: Implement cleanup**

```ts
  private async deleteNote(id: string): Promise<void> {
    const gone = this.notes().find((n) => n.id === id);
    const remaining = this.notes().filter((n) => n.id !== id);
    if (gone?.images?.length) deleteImages(this.imageDir(), gone.images);
    await this.pruneNoteOrder(remaining);
    await this.saveNotes(remaining);
  }

  private async clearCompletedNotes(): Promise<void> {
    const remaining = this.notes().filter((n) => !n.done);
    const cleared = this.notes().filter((n) => n.done);
    const images = cleared.flatMap((n) => n.images ?? []);
    if (images.length > 0) deleteImages(this.imageDir(), images);
    await this.pruneNoteOrder(remaining);
    await this.saveNotes(remaining);
  }

  /** Delete image files no note references. Called once on activate. Every other
   * cleanup path is a best-effort write a crash can leave half-done, so without
   * this the store only grows — and it is the ONLY writer that deletes on the
   * strength of the notes alone, which is why it never runs on the poll. */
  public sweepNotepadImages(): void {
    try {
      const keep = new Set(this.notes().flatMap((n) => (n.images ?? []).map((i) => i.id)));
      sweepOrphans(this.imageDir(), keep);
    } catch (e) {
      this.log(`notepad: image sweep failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
```

In `src/extension.ts`, after the provider is constructed and registered, in its own try/catch — an uncaught throw there disposes every registration that follows, which the file already warns about at `:75`:

```ts
  try {
    provider.sweepNotepadImages();
  } catch (e) {
    log(`notepad: image sweep failed (extension still active): ${e instanceof Error ? e.message : String(e)}`);
  }
```

- [ ] **Step 4: Run and verify they pass**

Run: `npx vitest run test/unit && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tasksView.ts src/extension.ts test/unit/tasksView.test.ts test/unit/extension.test.ts
git commit -m "feat(notepad): delete note images and sweep orphaned files"
```

---

### Task 5: The webview — thumbnails, paste, drop, Attach

**Files:**
- Modify: `src/webview/Notepad.tsx`
- Modify: `src/webview/styles.ts` (a `.np-images` block near the existing `.np-body` rules at `:392`)
- Modify: `src/webview/icons.tsx` (an `ImageIcon`, matching the existing icons' shape)
- Modify test: `test/webview/Notepad.test.tsx`

**Interfaces:**
- Consumes: `NotepadItemView.imageUris` (Task 1/2); the four messages from Task 3.
- Produces: no exports beyond the existing `Notepad`.

- [ ] **Step 1: Write the failing tests**

Add to `test/webview/Notepad.test.tsx`:

```ts
  const fileOf = (type: string, name = "shot.png") => new File(["AAAA"], name, { type });

  // jsdom's FileReader is real, so a paste test must await the read.
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("renders a thumbnail per imageUri", () => {
    render(<Notepad notes={[note({ imageUris: ["vscode-webview://a.png", "vscode-webview://b.png"] })]} ordered={false} />);
    expect(screen.getAllByRole("img")).toHaveLength(2);
  });

  it("renders no image strip for a note without images", () => {
    render(<Notepad notes={[note()]} ordered={false} />);
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });

  it("sends notepad:openImage when a thumbnail is clicked", () => {
    render(<Notepad notes={[note({ images: [{ id: "i1", ext: "png", name: "a.png" }], imageUris: ["vscode-webview://a.png"] })]} ordered={false} />);
    fireEvent.click(screen.getByRole("button", { name: /a\.png/ }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:openImage", id: "n1", imageId: "i1" });
  });

  it("sends notepad:addImage when an image is pasted into a saved note's body", async () => {
    render(<Notepad notes={[note()]} ordered={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
    const body = screen.getByDisplayValue("body");
    fireEvent.paste(body, { clipboardData: { files: [fileOf("image/png")], getData: () => "" } });
    await flush();
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "notepad:addImage", id: "n1", mime: "image/png", name: "shot.png" }));
  });

  it("ignores a paste with no image on the clipboard", async () => {
    render(<Notepad notes={[note()]} ordered={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
    fireEvent.paste(screen.getByDisplayValue("body"), { clipboardData: { files: [fileOf("text/plain", "notes.txt")], getData: () => "text" } });
    await flush();
    expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: "notepad:addImage" }));
  });

  it("carries pending images with notepad:add and clears them after", async () => {
    render(<Notepad notes={[]} ordered={false} />);
    const body = screen.getByPlaceholderText("Any detail the agent should know (optional)");
    fireEvent.paste(body, { clipboardData: { files: [fileOf("image/png")], getData: () => "" } });
    await flush();
    expect(screen.getAllByRole("img")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: "notepad:add",
      images: [expect.objectContaining({ mime: "image/png", name: "shot.png" })],
    }));
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });

  it("omits the images key from notepad:add when nothing is pending", () => {
    render(<Notepad notes={[]} ordered={false} />);
    fireEvent.change(screen.getByPlaceholderText("What needs doing?"), { target: { value: "Plain" } });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:add", title: "Plain", body: "" });
  });

  it("attaches a dropped file and does not reorder", () => {
    render(<Notepad notes={[note({ id: "a" }), note({ id: "b", title: "second" })]} ordered={false} />);
    const row = screen.getByText("Ship the thing").closest("li")!;
    fireEvent.drop(row, { dataTransfer: { types: ["Files"], files: [fileOf("image/png")] } });
    expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: "notepad:reorder" }));
  });

  it("sends notepad:pickImage from the Attach button in edit mode", () => {
    render(<Notepad notes={[note()]} ordered={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
    fireEvent.click(screen.getByRole("button", { name: "Attach image" }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:pickImage", id: "n1" });
  });

  it("sends notepad:removeImage from a thumbnail's remove control in edit mode", () => {
    render(<Notepad notes={[note({ images: [{ id: "i1", ext: "png", name: "a.png" }], imageUris: ["vscode-webview://a.png"] })]} ordered={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
    fireEvent.click(screen.getByRole("button", { name: /Remove a\.png/ }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:removeImage", id: "n1", imageId: "i1" });
  });
```

- [ ] **Step 2: Run and verify they fail**

Run: `npx vitest run test/webview/Notepad.test.tsx`
Expected: FAIL — no thumbnails, no Attach button, no paste handling.

- [ ] **Step 3: Implement the webview**

In `src/webview/Notepad.tsx`:

```tsx
/** A clipboard/drop item turned into what `notepad:addImage` needs. Returns null
 * for anything that is not an image, so a pasted text file or a dragged folder is
 * ignored rather than sent for the host to refuse. */
async function readImage(file: File): Promise<{ dataBase64: string; mime: string; name: string; dataUrl: string } | null> {
  if (!file.type.startsWith("image/")) return null;
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  // readAsDataURL gives `data:<mime>;base64,<payload>`. The payload is what the
  // host decodes; the whole URL doubles as the pending thumbnail's src, so the
  // bytes are never read twice.
  return { dataBase64: dataUrl.slice(dataUrl.indexOf(",") + 1), mime: file.type, name: file.name, dataUrl };
}

const imageFiles = (list: FileList | File[] | null | undefined): File[] =>
  Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
```

In `Notepad`, alongside `title`/`body`:

```tsx
  // Pending attachments for the ADD form only — the note does not exist yet, so
  // there is nothing to attach to on the host side. They ride along with
  // notepad:add; if the user never presses Add, the bytes were never written.
  const [pending, setPending] = React.useState<{ dataBase64: string; mime: string; name: string; dataUrl: string }[]>([]);
```

`canAdd` becomes `title.trim().length > 0 || body.trim().length > 0 || pending.length > 0`, and `add()`:

```tsx
  const add = () => {
    if (!canAdd) return;
    // The `images` key is omitted when nothing is pending, so a plain note's
    // message stays byte-identical to what it was before attachments existed.
    send(pending.length > 0
      ? { type: "notepad:add", title, body, images: pending.map(({ dataBase64, mime, name }) => ({ dataBase64, mime, name })) }
      : { type: "notepad:add", title, body });
    setTitle("");
    setBody("");
    setPending([]);
  };
```

The add form's textarea gains:

```tsx
            onPaste={async (e) => {
              const files = imageFiles(e.clipboardData?.files);
              if (files.length === 0) return; // a normal text paste, untouched
              e.preventDefault();
              const read = (await Promise.all(files.map(readImage))).filter((r) => r !== null);
              setPending((prev) => [...prev, ...read as NonNullable<Awaited<ReturnType<typeof readImage>>>[]]);
            }}
```

and, under it, a strip of pending thumbnails using `p.dataUrl` as `src`, each with a remove button that filters `pending` by index (no host round trip — nothing is on disk yet).

`NoteRow` gains, in edit mode: the same `onPaste` on its textarea but sending `notepad:addImage` per file, an "Attach image" button sending `notepad:pickImage`, and the image strip with per-thumbnail remove buttons labelled `Remove ${image.name}`.

In read mode, under `{note.body && …}`:

```tsx
      {note.imageUris && note.imageUris.length > 0 && (
        <div className="np-images">
          {note.imageUris.map((uri, i) => {
            const image = note.images?.[i];
            return (
              <button
                key={image?.id ?? uri}
                className="np-thumb"
                title={image?.name ?? "Attached image"}
                aria-label={`Open ${image?.name ?? "attached image"}`}
                onClick={() => image && send({ type: "notepad:openImage", id: note.id, imageId: image.id })}
              >
                <img src={uri} alt={image?.name ?? "Attached image"} />
              </button>
            );
          })}
        </div>
      )}
```

The row's drop fork — this is the one change that can break the existing drag:

```tsx
      onDragOver={(e) => {
        e.preventDefault();
        // A file drag is not a reorder: keep the copy cursor and show no
        // before/after hint, or the row lies about what the drop will do.
        if (isFileDrag(e)) { e.dataTransfer.dropEffect = "copy"; return; }
        e.dataTransfer.dropEffect = "move";
        dnd.onHover(dropPos(e));
      }}
      onDrop={async (e) => {
        e.preventDefault();
        if (isFileDrag(e)) {
          for (const file of imageFiles(e.dataTransfer.files)) {
            const read = await readImage(file);
            if (read) send({ type: "notepad:addImage", id: note.id, dataBase64: read.dataBase64, mime: read.mime, name: read.name });
          }
          return; // never reaches the reorder path
        }
        dnd.onDrop(dropPos(e));
      }}
```

with, at module level:

```tsx
/** A drag carrying files from outside the webview (Finder, Explorer) rather than
 * a note being reordered. Checked before anything else in both handlers: the
 * reorder path and the attach path share one row, and a Finder drop that fell
 * through to `dnd.onDrop` would silently reshuffle the list. */
const isFileDrag = (e: React.DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes("Files");
```

In `src/webview/styles.ts`, beside the `.np-body` rules:

```css
  /* Thumbnails share .np-body's left offset so the strip lines up under the
     title, not under the grip. Fixed height with cover cropping: a screenshot is
     usually wide, and letting each thumb keep its aspect ratio makes the row
     ragged. */
  .np-images { grid-column: 1; display: flex; flex-wrap: wrap; gap: 4px;
    margin: 4px 0 0 calc(var(--grip-w) + 7px + 20px); }
  .np-thumb { position: relative; padding: 0; border: 1px solid var(--vscode-panel-border);
    border-radius: 3px; background: none; cursor: pointer; line-height: 0; }
  .np-thumb img { height: 64px; max-width: 128px; object-fit: cover; display: block; }
  .np-thumb:hover { border-color: var(--vscode-focusBorder); }
  .np-thumb-remove { position: absolute; top: 1px; right: 1px; }
```

- [ ] **Step 4: Run and verify they pass**

Run: `npx vitest run test/webview && npm run typecheck`
Expected: PASS, including every pre-existing Notepad and drag test.

- [ ] **Step 5: Build, to catch a host import leaking into the webview**

Run: `npm run build`
Expected: success. A failure here means something in `src/webview/` reached `fs`/`path`/`os` — the only gate that catches it.

- [ ] **Step 6: Commit**

```bash
git add src/webview/Notepad.tsx src/webview/styles.ts src/webview/icons.tsx test/webview/Notepad.test.tsx
git commit -m "feat(notepad): paste, drop and show images on a note"
```

---

### Task 6: Hand the images to the agent on Start

**Files:**
- Modify: `src/engine/workspace.ts:65-100` (`OpenRequest`), `:258-271` (brief step)
- Modify: `src/tasksView.ts:1198-1228` (`runNotepadItem`)
- Modify test: `test/unit/engine/workspace.test.ts`, `test/unit/tasksView.test.ts`

**Interfaces:**
- Consumes: `imageDir()`, `imagePath`, the note's `images`.
- Produces: `OpenRequest.attachments?: { path: string; name: string }[]`.

- [ ] **Step 1: Write the failing tests**

In `test/unit/engine/workspace.test.ts`:

```ts
describe("openWorkspace — attachments", () => {
  it("copies each attachment into .pick-task/images/ in every repo", async () => {
    const copyFileSync = vi.mocked(fs.copyFileSync);
    copyFileSync.mockReset();
    await openWorkspace(baseReq({
      attachments: [{ path: "/store/i1.png", name: "shot.png" }],
    }));
    const targets = copyFileSync.mock.calls.map((c) => String(c[1]));
    expect(targets).toContain("/repos/account-service/.pick-task/images/shot.png");
    expect(targets).toContain("/repos/webapp/.pick-task/images/shot.png");
  });

  it("disambiguates two attachments that share a filename", async () => {
    const copyFileSync = vi.mocked(fs.copyFileSync);
    copyFileSync.mockReset();
    await openWorkspace(baseReq({
      services: mkRepos(["account-service"]),
      attachments: [
        { path: "/store/i1.png", name: "shot.png" },
        { path: "/store/i2.png", name: "shot.png" },
      ],
    }));
    const targets = copyFileSync.mock.calls.map((c) => String(c[1]));
    expect(new Set(targets).size).toBe(2);
    expect(targets.every((t) => t.startsWith("/repos/account-service/.pick-task/images/"))).toBe(true);
  });

  it("creates no images directory when there are no attachments", async () => {
    const mk = vi.mocked(fs.mkdirSync);
    mk.mockReset();
    await openWorkspace(baseReq());
    expect(mk.mock.calls.map((c) => String(c[0])).some((p) => p.includes("/images"))).toBe(false);
  });
});
```

`mkRepos` roots at `/repos` (`test/_helpers/factories.ts:32`), so the `/repos/account-service/…` expectations above are correct as written.

In `test/unit/tasksView.test.ts`:

```ts
  it("names the note's images in the brief and the prompt suffix, and passes them as attachments", async () => {
    const { store, sendMsg } = mkProvider();
    store.set("agentFlow.notepad", [{ id: "n1", title: "Rail colour", body: "see shots", done: false, createdAt: 1,
      images: [{ id: "i1", ext: "png", name: "before.png" }] }]);
    await sendMsg({ type: "notepad:run", id: "n1" });
    const req = vi.mocked(openWorkspace).mock.calls.at(-1)![0];
    expect(req.attachments).toEqual([
      { path: expect.stringContaining(path.join("notepad-images", "i1.png")), name: "before.png" },
    ]);
    expect(req.planMd).toContain("## Attached images");
    expect(req.planMd).toContain(".pick-task/images/before.png");
    expect(req.promptSuffix).toContain(".pick-task/images/before.png");
    expect(req.promptSuffix).toContain("Details from the note:");
  });

  it("leaves the brief and prompt untouched for a note with no images", async () => {
    const { store, sendMsg } = mkProvider();
    store.set("agentFlow.notepad", [{ id: "n1", title: "Plain", body: "detail", done: false, createdAt: 1 }]);
    await sendMsg({ type: "notepad:run", id: "n1" });
    const req = vi.mocked(openWorkspace).mock.calls.at(-1)![0];
    expect(req.attachments).toBeUndefined();
    expect(req.planMd).not.toContain("Attached images");
  });
```

`openWorkspace` is already mocked at the top of the file. The existing `notepad:run` test (around `:4515`) establishes whatever `discoverRepos`/`getConfig`/kickoff arrangement a run needs — copy that arrangement into these two rather than building a new one, since `mkProvider` alone does not satisfy it.

- [ ] **Step 2: Run and verify they fail**

Run: `npx vitest run test/unit/engine/workspace.test.ts test/unit/tasksView.test.ts`
Expected: FAIL — `attachments` is not a field on `OpenRequest` (a type error too), nothing is copied, and `planMd` has no images section.

- [ ] **Step 3: Implement the copy**

In `src/engine/workspace.ts`, add to `OpenRequest`:

```ts
  /** Files to place beside the brief, currently a notepad note's images. Copied
   * into `<repo>/.pick-task/images/` — the same directory `ensureGitExcluded`
   * already excludes whole — so the agent reads a real file at a repo-relative
   * path instead of being handed bytes it cannot open. Absent or empty creates no
   * directory and copies nothing. */
  attachments?: { path: string; name: string }[];
```

Inside the `briefs = services.map(…)` callback, after the brief write:

```ts
    // Attachments ride with the brief because they are part of it: the brief names
    // their repo-relative paths, so they must exist in EVERY repo the launch seeds,
    // not only the first. `name` collisions are possible within one note (two files
    // called shot.png), so a colliding target is suffixed with its stem.
    for (const [i, att] of (req.attachments ?? []).entries()) {
      const imagesDir = path.join(dir, "images");
      fs.mkdirSync(imagesDir, { recursive: true });
      fs.copyFileSync(att.path, path.join(imagesDir, attachmentFileName(req.attachments!, i)));
    }
```

and, module-level:

```ts
/** The filename an attachment lands under: its own name, unless an earlier
 * attachment already claimed it, in which case the source file's stem is folded
 * in. Deterministic — the brief names these paths, so the copy and the text must
 * agree. */
export function attachmentFileName(all: readonly { path: string; name: string }[], index: number): string {
  const att = all[index];
  const claimedEarlier = all.slice(0, index).some((a) => a.name === att.name);
  if (!claimedEarlier) return att.name;
  const stem = path.basename(att.path, path.extname(att.path));
  const ext = path.extname(att.name);
  return `${path.basename(att.name, ext)}-${stem}${ext}`;
}
```

- [ ] **Step 4: Implement the handoff in `runNotepadItem`**

In `src/tasksView.ts`, before `openWorkspace` is called:

```ts
    // Repo-relative, not relative to the brief: the agent's cwd is the repo root,
    // and a bare `images/foo.png` names no file from there — the same trap
    // batchWorkspace.ts:173 already records.
    const images = note.images ?? [];
    const attachments = images.map((img, i) => ({
      path: imagePath(this.imageDir(), img),
      name: attachmentFileName(images.map((im) => ({ path: imagePath(this.imageDir(), im), name: im.name })), i),
    }));
    const imageLines = attachments.map((a) => `- \`${BRIEF_DIR}/images/${a.name}\``).join("\n");
```

Append to `planMd` when `attachments.length > 0`:

```ts
      + (attachments.length > 0 ? `\n\n## Attached images\n\n${imageLines}` : "")
```

and extend the prompt suffix — the reasoning for a suffix at all is already written at `tasksView.ts:1202`, and it applies doubly here: an image the agent never opens is an image the user typed nothing to replace.

```ts
    const imageNote = attachments.length > 0
      ? `The user attached ${attachments.length === 1 ? "an image" : "images"} to this note. Read ${attachments.length === 1 ? "it" : "them"} before starting:\n${imageLines}`
      : undefined;
    const details = [
      note.body.trim() ? `Details from the note:\n\n${note.body.trim()}` : undefined,
      imageNote,
    ].filter(Boolean).join("\n\n") || undefined;
```

Pass `attachments: attachments.length > 0 ? attachments : undefined` in the `openWorkspace` call.

Import `BRIEF_DIR` and `attachmentFileName` from `./engine/workspace`, and `imagePath` from `./notepadImages`.

- [ ] **Step 5: Run and verify they pass**

Run: `npx vitest run test/unit && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Full gates**

Run: `npm test && npm run typecheck && npm run build && npm run test:cov`
Expected: all pass; coverage thresholds hold and changed files sit ≥95%.

- [ ] **Step 7: Commit**

```bash
git add src/engine/workspace.ts src/tasksView.ts test/unit/engine/workspace.test.ts test/unit/tasksView.test.ts
git commit -m "feat(notepad): hand a note's images to the agent on Start"
```

---

### Task 7: Docs and a real editor pass

**Files:**
- Modify: `README.md` (the Notepad section)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Document the behaviour**

Add to the README's Notepad description: images can be pasted, dropped, or attached to a note, and Start copies them into `.pick-task/images/` where the agent reads them. Match the surrounding voice; do not add a screenshot.

- [ ] **Step 2: Changelog entry**

Add an `### Added` bullet under the unreleased/next version heading, in the file's existing style.

- [ ] **Step 3: Verify in a dev host**

Launch with VS Code's own `code` CLI and `--extensionDevelopmentPath` (the Cursor CLI silently drops that flag). Then, by hand:

1. Paste a `Cmd+Shift+4` screenshot into the add form's body → a thumbnail appears before the note exists.
2. Add the note → the thumbnail survives, and a reload keeps it.
3. Drag a PNG from Finder onto the note row → it attaches, and the list order does not change.
4. Drag the note by its grip → it still reorders, and nothing attaches.
5. Click a thumbnail → the image opens in an editor tab.
6. Edit → remove a thumbnail → the file is gone from `<globalStorage>/notepad-images/`.
7. Start the note → `.pick-task/images/` holds the copy, `TASK.md` names it, and the seeded prompt mentions it.
8. Drop a PDF → an error toast naming the file, and nothing is stored.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs(notepad): document image attachments"
```

---

## Self-Review Notes

Spec coverage checked section by section:

| Spec requirement | Task |
|---|---|
| Bytes under `globalStorageUri/notepad-images/`, mime whitelist, size cap | 1 |
| `NotepadImage`, `NotepadItem.images`, `sanitizeNotes` coercion | 1 |
| `NotepadItemView.imageUris` derived per post; `localResourceRoots` | 2 |
| `notepad:addImage` / `pickImage` / `removeImage` / `openImage`; pending images on `notepad:add` | 3 |
| Deletes unlink; activate-time orphan sweep | 4 |
| Thumbnail strip, click-to-open, paste, file-drop fork, Attach button, remove control, styles | 5 |
| `OpenRequest.attachments`, copy into `.pick-task/images/`, `## Attached images`, prompt suffix | 6 |
| Refusal toasts naming the reason | 1 (reason text) + 3 (toast) |
| Ships inert | Global Constraints, enforced by tests in 2, 3 and 5 |

Scaffolding facts checked against the real files rather than assumed, because getting them wrong is how a plan's own tests become the defect: `test/unit/tasksView.test.ts` does not mock `fs` (so every image assertion is real-disk), its notepad block drives a local `mkProvider()`/`sendMsg` pair whose webview stub had no `asWebviewUri` (Task 2 extends it), `setup()` is the only helper that resolves a webview (so it owns the `localResourceRoots` assertion), and `test/unit/engine/workspace.test.ts` *does* mock `fs` (so the attachment copy is assertable through `vi.mocked(fs.copyFileSync)`).

Nothing is left unresolved: `mkRepos` roots at `/repos`, which Task 6's copy-target expectations use directly.
