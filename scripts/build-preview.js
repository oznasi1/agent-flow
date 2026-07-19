// Compose the browser preview: preview/head.html (a mock VS Code host + canned Jira
// data) with the built webview bundle injected. The bundle's index.tsx injects the
// webview CSS at runtime, so this only needs to drop the script in before </body>.
// Usage: npm run build && npm run preview   (then open preview/agent-flow-preview.html)
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const head = fs.readFileSync(path.join(root, "preview/head.html"), "utf8");
const bundle = fs.readFileSync(path.join(root, "dist/webview.js"), "utf8");

const out = head.replace("</body>", `  <script>${bundle}</script>\n</body>`);
fs.writeFileSync(path.join(root, "preview/agent-flow-preview.html"), out);
console.log("preview → preview/agent-flow-preview.html");
