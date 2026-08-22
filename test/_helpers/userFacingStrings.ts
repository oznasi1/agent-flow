import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/** One user-facing string containing the agent-word, and where it lives.
 * `location` is a file path or a `package.json#<json-path>` — deliberately NOT
 * a line number, so an unrelated edit above a string cannot invalidate the
 * allowlist. */
export interface Hit {
  location: string;
  text: string;
}

const AGENT_WORD = /\bagents?\b/i;

/** The product is "Agent Flow Deck". That "Agent" is a proper noun and is never
 * in scope, so strip the product name before looking for the common noun.
 * Without this, the product name alone accounts for most matches. */
const PRODUCT_NAME = /\bAgent Flow(?: Deck)?\b/g;

export const hasAgentWord = (s: string): boolean =>
  AGENT_WORD.test(s.replace(PRODUCT_NAME, ""));

/** Stylesheet modules each export ONE template literal holding a whole CSS
 * file. That string is code, not prose: its class names (`.c-agents`) and CSS
 * comments would land in the allowlist as multi-kilobyte entries that any
 * unrelated style edit invalidates. Same set vitest.config.ts excludes from
 * coverage. */
export const EXCLUDED_MODULES: readonly string[] = [
  "src/webview/styles.ts",
  "src/webview/deckStyles.ts",
  "src/webview/orchestratorStyles.ts",
  "src/webview/marketplaceStyles.ts",
  "src/webview/tokens.ts",
];

/** A string literal is NOT user-facing copy when it is a module specifier, sits
 * inside a type, or is an object/property key. Everything else — values, JSX
 * text, and each literal chunk of a template — is text a human may read.
 * Comments are never visited at all, which is the whole reason this uses the
 * compiler API instead of a regex. */
function isNotCopy(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) return true;
  if (ts.isImportTypeNode(p) || ts.isModuleDeclaration(p)) return true;
  if (ts.isExternalModuleReference(p)) return true;
  if (ts.isLiteralTypeNode(p)) return true;
  if (ts.isPropertyAssignment(p) && p.name === node) return true;
  if (ts.isPropertySignature(p) && p.name === node) return true;
  if (ts.isEnumMember(p) && p.name === node) return true;
  return false;
}

/** Every user-facing string in one source file that contains the agent-word,
 * whitespace-collapsed so a reflowed line does not change the allowlist. */
export function userFacingStrings(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: string[] = [];
  const take = (text: string) => {
    // Collapse whitespace RUNS but do not trim the ends: a template chunk
    // adjacent to an interpolation (e.g. `${n} agents open`) carries a
    // leading/trailing space that is part of the rendered copy.
    if (hasAgentWord(text)) out.push(text.replace(/\s+/g, " "));
  };
  const visit = (n: ts.Node): void => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !isNotCopy(n)) take(n.text);
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) take(n.text);
    else if (ts.isJsxText(n)) take(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (/\.tsx?$/.test(e.name)) acc.push(full);
  }
  return acc;
}

export function scanSources(root: string): Hit[] {
  const excluded = new Set(EXCLUDED_MODULES);
  const hits: Hit[] = [];
  for (const file of walk(path.join(root, "src")).sort()) {
    const location = path.relative(root, file).split(path.sep).join("/");
    if (excluded.has(location)) continue;
    for (const text of userFacingStrings(file, fs.readFileSync(file, "utf8"))) {
      hits.push({ location, text });
    }
  }
  return hits;
}

/** The manifest's user-visible prose: setting descriptions, enum descriptions,
 * command titles, view names. Located by JSON path, which is stable. */
export function scanManifest(root: string): Hit[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, any>;
  const c = pkg.contributes ?? {};
  const hits: Hit[] = [];
  const add = (jsonPath: string, text: unknown) => {
    if (typeof text === "string" && hasAgentWord(text)) {
      hits.push({ location: `package.json#${jsonPath}`, text: text.replace(/\s+/g, " ").trim() });
    }
  };
  for (const [key, v] of Object.entries<any>(c.configuration?.properties ?? {})) {
    for (const f of ["description", "markdownDescription", "deprecationMessage"]) add(`${key}.${f}`, v[f]);
    (v.enumDescriptions ?? []).forEach((d: unknown, i: number) => add(`${key}.enumDescriptions[${i}]`, d));
    (v.markdownEnumDescriptions ?? []).forEach((d: unknown, i: number) =>
      add(`${key}.markdownEnumDescriptions[${i}]`, d));
  }
  for (const cmd of c.commands ?? []) {
    add(`command:${cmd.command}.title`, cmd.title);
    add(`command:${cmd.command}.category`, cmd.category);
  }
  for (const [grp, views] of Object.entries<any>(c.views ?? {})) {
    for (const v of views) add(`view:${grp}/${v.id}.name`, v.name);
  }
  for (const vc of c.viewsContainers?.activitybar ?? []) add(`viewsContainer:${vc.id}.title`, vc.title);
  return hits;
}
