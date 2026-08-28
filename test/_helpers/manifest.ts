/** Accessors for package.json's `contributes.configuration`, tolerant of both
 * released shapes: a single `{ title, properties }` object, or an array of
 * titled sections (the Settings-UI grouping shipped for the Features tab).
 * Setting ids are identical in either shape — only the presentation differs —
 * so tests asserting on ids, defaults, or enums should read through this
 * helper rather than hardcoding one shape. */

type ConfigSection = { properties?: Record<string, unknown> };

export function manifestSettings<T = unknown>(pkg: {
  contributes: { configuration: ConfigSection | ConfigSection[] };
}): Record<string, T> {
  const sections = Array.isArray(pkg.contributes.configuration)
    ? pkg.contributes.configuration
    : [pkg.contributes.configuration];
  return Object.assign({}, ...sections.map((s) => s.properties ?? {})) as Record<string, T>;
}
