import type { DailyMap } from "./merge.mjs";

export interface OpenVsxReach {
  downloads: number;
  reviews: number;
  version: string | null;
}
export interface VsMarketplaceReach {
  downloads: number;
  installs: number | null;
  updates: number | null;
  rating: number | null;
  version: string | null;
}
export declare function parseTraffic(payload: unknown): DailyMap;
export declare function parseOpenVsx(payload: unknown): OpenVsxReach;
export declare function parseVsMarketplace(payload: unknown): VsMarketplaceReach;
export declare function parseStars(payload: unknown): string[];
