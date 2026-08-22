export interface CollectOptions {
  dir: string;
  token: string;
  /** Token for the ordinary public-read endpoints. Defaults to `token`. */
  publicToken?: string;
  fetchImpl: typeof fetch;
  now: string;
}
export interface CollectResult {
  ok: string[];
  failed: { source: string; error: string }[];
}
export declare function collect(opts: CollectOptions): Promise<CollectResult>;
