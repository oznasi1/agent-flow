export interface DailyBucket {
  count: number;
  uniques: number;
}
export type DailyMap = Record<string, DailyBucket>;
export interface TrafficBucket {
  timestamp: string;
  count: number;
  uniques: number;
}
export declare function toDailyMap(buckets: unknown): DailyMap;
export declare function mergeDaily(existing: DailyMap, incoming: DailyMap): DailyMap;
