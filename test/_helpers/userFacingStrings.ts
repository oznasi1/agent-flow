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

/** The template/workflow gate's word. Matched the same way as the agent-word —
 * boundary-only, so "workflow"/"Workflows" (no boundary before "flow", since
 * the preceding letter is a word character too) never trips it, only a bare
 * "flow"/"flows" does. The product name is "Agent Flow Deck", so it must be
 * stripped first for the same reason `hasAgentWord` strips it: without that,
 * the product's own name would fail the gate everywhere it is printed. */
const FLOW_WORD = /\bflows?\b/i;

export const hasFlowWord = (s: string): boolean =>
  FLOW_WORD.test(s.replace(PRODUCT_NAME, ""));

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

/** Every candidate user-facing string in one source file — plain literals,
 * template chunks, JSX text — whitespace-collapsed so a reflowed line does not
 * change the allowlist, and with no word filter applied. This is the shared
 * extraction the agent-word and flow-word gates both build on, so a fix to
 * what counts as "copy" (comments excluded, object keys excluded, etc.) helps
 * every gate at once rather than needing a second AST walk. */
export function allUiStrings(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: string[] = [];
  const take = (text: string) => {
    // Collapse whitespace RUNS but deliberately do NOT trim the ends: a
    // template chunk adjacent to an interpolation (e.g. `${n} agents open`)
    // carries a leading/trailing space that is part of the rendered copy.
    // Trimming would make that chunk's allowlist key collide with a bare
    // string literal like "agents" in the same file — allowlisting the wire
    // value would then silently allowlist the display string too. Do not
    // "fix" this by adding .trim() back.
    out.push(text.replace(/\s+/g, " "));
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

/** Every user-facing string in one source file that contains the agent-word.
 * Kept as its own export — rather than inlining `allUiStrings(...).filter(hasAgentWord)`
 * at every call site — because it is the one the top-level describe block below
 * documents and tests directly. */
export function userFacingStrings(fileName: string, source: string): string[] {
  return allUiStrings(fileName, source).filter(hasAgentWord);
}

/** The exact source text of one top-level function — a `function NAME(...)`
 * declaration, or a `const NAME = (...) => {...}` / `const NAME = function
 * (...) {...}` assignment — found by name anywhere in the file. Lets a gate
 * scope a scan to one component's own render body ("does a workflow verb
 * appear anywhere INSIDE TemplateRow") rather than to a string's own content
 * ("does a string contain both 'template' and a verb"), which is what makes
 * the difference between catching a bare `Detach` button dropped into that
 * component and missing it. Throws when the name is not found, so renaming or
 * removing the component fails the test loudly instead of silently scanning
 * nothing. */
export function functionSource(fileName: string, source: string, name: string): string {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let found: ts.Node | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) {
      found = n;
      return;
    }
    if (
      ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name &&
      n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) {
      found = n.initializer;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!found) throw new Error(`functionSource: no function or const named ${JSON.stringify(name)} in ${fileName}`);
  return source.slice(found.getStart(sf), found.getEnd());
}

/** The full source text of the smallest enclosing JSX element (or fragment)
 * that contains a given landmark string — a className, an aria-label, any
 * literal or JSX-text substring. A second way to scope a scan to one region
 * of a render method, for a block that is inline JSX rather than its own
 * named component (`functionSource` cannot find what has no name). Throws
 * when the landmark is not found, for the same reason `functionSource` does. */
export function jsxBlockAround(fileName: string, source: string, landmark: string): string {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let marker: ts.Node | undefined;
  const findMarker = (n: ts.Node): void => {
    if (marker) return;
    if ((ts.isStringLiteralLike(n) || ts.isJsxText(n)) && n.getText(sf).includes(landmark)) {
      marker = n;
      return;
    }
    ts.forEachChild(n, findMarker);
  };
  findMarker(sf);
  if (!marker) throw new Error(`jsxBlockAround: landmark ${JSON.stringify(landmark)} not found in ${fileName}`);
  let n: ts.Node | undefined = marker;
  while (n && !ts.isJsxElement(n) && !ts.isJsxFragment(n)) n = n.parent;
  if (!n) {
    throw new Error(`jsxBlockAround: no enclosing JSX element around ${JSON.stringify(landmark)} in ${fileName}`);
  }
  return source.slice(n.getStart(sf), n.getEnd());
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
      hits.push({ location: `package.json#${jsonPath}`, text: text.replace(/\s+/g, " ") });
    }
  };
  // `configuration` may be a single section or an array of titled sections;
  // the settings prose must be scanned in either shape.
  const sections: any[] = Array.isArray(c.configuration)
    ? c.configuration
    : c.configuration
      ? [c.configuration]
      : [];
  sections.forEach((s, i) => add(`configuration[${i}].title`, s.title));
  const properties = Object.assign({}, ...sections.map((s) => s.properties ?? {}));
  for (const [key, v] of Object.entries<any>(properties)) {
    for (const f of ["description", "markdownDescription", "deprecationMessage"]) add(`${key}.${f}`, v[f]);
    (v.enumDescriptions ?? []).forEach((d: unknown, i: number) => add(`${key}.enumDescriptions[${i}]`, d));
    (v.markdownEnumDescriptions ?? []).forEach((d: unknown, i: number) =>
      add(`${key}.markdownEnumDescriptions[${i}]`, d));
    // Some settings' `default` carries user-facing prompt prose, not just a
    // stored wire value (e.g. agentFlow.explorePrompts.*, agentFlow.prReviewPrompt).
    // A plain string default is scanned directly; an array-of-object default
    // (e.g. agentFlow.reviewRequestModes) is scanned field-by-field, since its
    // `label`/`prompt`/`detail` strings are copy but its `id`/`hidden` are wire
    // values indistinguishable from copy without reading each field's role.
    const def = v.default;
    if (typeof def === "string") {
      add(`${key}.default`, def);
    } else if (Array.isArray(def)) {
      def.forEach((item: unknown, i: number) => {
        if (item && typeof item === "object") {
          for (const [field, val] of Object.entries(item as Record<string, unknown>)) {
            add(`${key}.default[${i}].${field}`, val);
          }
        }
      });
    }
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
