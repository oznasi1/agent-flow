// The notepad's image store. Same purity bar as `src/notepad.ts`: no `vscode` and
// no mocked extension context, so every test here runs against a real temp dir.
// `fs` is fine — that file's own `canon` touches it for the same reason — and the
// directory is passed in rather than resolved from an extension context, which is
// what keeps this module out of the host's dependency web.
import * as fs from "fs";
import * as path from "path";
import { NotepadImage } from "./types";

/** Subdirectory of `globalStorageUri` the bytes live in. */
export const IMAGE_DIR = "notepad-images";

/** Refusal threshold. A screenshot is well under this; a video frame dump or a
 * mis-dropped disk image is not, and globalStorage is not the place to find that
 * out — it has no eviction and nothing else prunes it. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// Mime → extension, and the whitelist in one: an unlisted type is refused, so a
// dropped PDF or .mov can never reach the store. The extension is taken from here
// rather than from the incoming filename, which the sender controls and can lie
// about — a `.png` holding a PDF would be stored as an image the editor then
// cannot decode, with nothing to explain why.
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export type SaveResult = { ok: true; image: NotepadImage } | { ok: false; reason: string };

/** Write one image. `id` is injected rather than generated here — the same
 * pattern `newNote` and `newSection` use — so this stays clock- and
 * randomness-free and its tests need no stubs. A refusal writes nothing at all,
 * and its `reason` is user-facing copy, ready for a toast: the user just pasted
 * something and is owed an answer, not a silent drop. */
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
 * between the unlink and the state write that follows it, not an error worth
 * surfacing to someone who only deleted a note. */
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
 * an older version can leave half-done, so without this the store only grows.
 *
 * `keep` holds image IDS — the filename stem — not filenames, because the caller
 * reads note records, not the disk. Deleting on the strength of the notes alone is
 * exactly why this runs once on activate and never on the poll: a poll that raced
 * a half-written state file would delete files a note still points at. */
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
