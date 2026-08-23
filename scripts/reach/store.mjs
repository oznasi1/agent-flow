// Filesystem layer for the reach store. Deliberately dumb: all judgment lives
// in ./merge.mjs.
//
// readJson distinguishes two failure modes that look similar but are not:
//   - MISSING file: the legitimate first-run path. Returns the fallback.
//   - a file that EXISTS but does not parse (e.g. a run killed mid-write):
//     throws. The caller's per-source try/catch then skips the write and
//     preserves the damaged file for manual repair. Silently falling back to
//     `{}` here would let the collector's next merge treat 14 days of
//     traffic as the entire history and overwrite everything older — an
//     unrecoverable loss, since the store is append-only and upstream's
//     window has already moved on by the time anyone notices.
//
// writeJson writes to a temp file in the same directory and renames it over
// the target. `rename` is atomic within a filesystem, so a process killed
// mid-write (CI cancellation, ENOSPC) leaves either the old file or the new
// one, never a torn one — that's what readJson's corrupt-file case exists to
// catch when it still happens (a torn write on a filesystem where rename
// isn't atomic, or a file damaged some other way).

import * as fs from "fs";
import * as path from "path";

export function readJson(dir, rel, fallback) {
  const file = path.join(dir, rel);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return fallback;
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `reach: corrupt JSON in ${file} — refusing to treat it as empty; repair or delete it manually (${e.message})`,
    );
  }
}

export function writeJson(dir, rel, value) {
  const file = path.join(dir, rel);
  const dirName = path.dirname(file);
  fs.mkdirSync(dirName, { recursive: true });
  const tmp = path.join(dirName, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

export function appendJsonl(dir, rel, record) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
}

/**
 * The newest dated file under `snapshots/<kind>/`, or null when the directory
 * is missing or holds nothing dated.
 *
 * Referrers and paths are stored one dated file per run rather than merged,
 * because they are GitHub's top-10 *rankings* — two snapshots do not compose
 * into a sum. So "latest" is the only honest thing to read, and the date comes
 * back with the rows so the caller can say which day it describes rather than
 * implying it is current.
 *
 * Filenames are sorted lexically, which is chronological for `YYYY-MM-DD` and
 * only for that shape — hence the strict filter rather than a bare readdir.
 */
export function readLatestSnapshot(dir, kind) {
  const base = path.join(dir, "snapshots", kind);
  let names;
  try {
    names = fs.readdirSync(base);
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw e;
  }
  const dated = names.filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
  if (dated.length === 0) return null;
  const file = dated[dated.length - 1];
  // readJson throws on a corrupt file rather than masking it as empty; the
  // dashboard's CLI catches that and renders without this section, the same
  // way it tolerates a torn line in marketplace.jsonl.
  const rows = readJson(dir, `snapshots/${kind}/${file}`, null);
  if (!Array.isArray(rows)) return null;
  return { date: file.slice(0, 10), rows };
}
