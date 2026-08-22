export interface CollectOptions {
  dir: string;
  token: string;
  fetchImpl: typeof fetch;
  now: string;
}
export interface CollectResult {
  ok: string[];
  failed: { source: string; error: string }[];
}
export declare function collect(opts: CollectOptions): Promise<CollectResult>;
