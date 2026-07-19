import { InboundMessage } from "../types";

interface VsCodeApi {
  postMessage(msg: InboundMessage): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// acquireVsCodeApi() may only be called once per webview.
export const vscodeApi: VsCodeApi = acquireVsCodeApi();

export function send(msg: InboundMessage): void {
  vscodeApi.postMessage(msg);
}
