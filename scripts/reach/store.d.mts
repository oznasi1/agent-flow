export declare function readJson<T>(dir: string, rel: string, fallback: T): T;
export declare function writeJson(dir: string, rel: string, value: unknown): void;
export declare function appendJsonl(dir: string, rel: string, record: unknown): void;
export interface Snapshot<Row> {
  date: string;
  rows: Row[];
}
export declare function readLatestSnapshot<Row = unknown>(
  dir: string,
  kind: string,
): Snapshot<Row> | null;
