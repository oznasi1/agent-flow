import { beforeMount } from "@playwright/experimental-ct-react/hooks";
import { CSS } from "../src/webview/styles";

beforeMount(async () => {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
});
