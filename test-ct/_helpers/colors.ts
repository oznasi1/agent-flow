import type { Locator, Page } from "@playwright/test";

/** What a CSS custom property (`--c-attn`, `--c-progress`, …) computes to in
 *  this exact document — never a hardcoded hex. `tokens.ts` derives most hues
 *  from `--vscode-charts-*` variables that only exist inside a real VS Code
 *  webview; a plain browser falls through to the SAME fallback literal the
 *  token itself declares (`var(--vscode-charts-blue, #4aa3df)`), so this
 *  resolves the token exactly the way the component being tested would, and
 *  keeps matching it if the fallback is ever edited — no second copy of the
 *  hex to forget to update. A throwaway element is the only way to ask the
 *  browser "what does this var() resolve to as a color", since custom
 *  properties have no computed value of their own to read directly. */
export async function tokenColor(page: Page, cssVar: string): Promise<string> {
  return page.evaluate((v) => {
    const el = document.createElement("span");
    el.style.color = `var(${v})`;
    document.body.appendChild(el);
    const resolved = getComputedStyle(el).color;
    el.remove();
    return resolved;
  }, cssVar);
}

/** The resolved (`rgb(...)`) color a real element is actually painted with —
 *  the other half of every hue assertion in this suite, compared against
 *  `tokenColor`'s answer for the token the sheet is SUPPOSED to spend there. */
export async function elementColor(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).color);
}
