// Filesystem layer for the reach store. Deliberately dumb: all judgment lives
// in ./merge.mjs. A corrupt file reads as the fallback rather than throwing,
// because a store the collector cannot parse should be rebuilt from the next
// fetch, not treated as a fatal error.

import * as fs from "fs";
import * as path from "path";

export function readJson(dir, rel, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(dir, rel, value) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function appendJsonl(dir, rel, record) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
}
