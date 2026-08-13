// Compose the browser preview: preview/head.html (a mock VS Code host + canned Jira
// data) with the built webview bundle injected. The bundle's index.tsx injects the
// webview CSS at runtime, so this only needs to drop the script in before </body>.
// Usage: npm run build && npm run preview   (then open preview/agent-flow-preview.html)
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const head = fs.readFileSync(path.join(root, "preview/head.html"), "utf8");
const bundle = fs.readFileSync(path.join(root, "dist/webview.js"), "utf8");

// The replacement is a FUNCTION, not a string, and must stay one. A string
// replacement is scanned for $-patterns, and a minified bundle contains `$&` —
// which expands to the matched text, silently pasting a stray "</body>" into the
// middle of the JavaScript being injected. That lands inside a string literal
// often enough to go unnoticed, and produces an unparseable page when it doesn't.
// A function's return value is used verbatim, so `$` means `$`.
const out = head.replace("</body>", () => `  <script>${bundle}</script>\n</body>`);
fs.writeFileSync(path.join(root, "preview/agent-flow-preview.html"), out);
console.log("preview → preview/agent-flow-preview.html");
