import type { DailyMap } from "./merge.mjs";
import type { OpenVsxReach, VsMarketplaceReach } from "./sources.mjs";
import type { Snapshot } from "./store.mjs";

export interface ReferrerRow {
  referrer: string;
  count: number;
  uniques: number;
}
export interface PathRow {
  path: string;
  title?: string;
  count: number;
  uniques: number;
}
export interface DashboardData {
  meta: { firstCollected?: string; lastRun?: string; schemaVersion?: number };
  views: DailyMap;
  clones: DailyMap;
  stars: string[];
  marketplace: { ts: string; openvsx: OpenVsxReach; vsmarketplace: VsMarketplaceReach }[];
  /** Latest dated snapshot, or null when none has been collected. */
  referrers?: Snapshot<ReferrerRow> | null;
  paths?: Snapshot<PathRow> | null;
}
export declare function renderDashboard(data: DashboardData): string;
export interface MarketplaceJsonlResult {
  records: unknown[];
  skipped: number;
}
export declare function parseMarketplaceJsonl(text: string): MarketplaceJsonlResult;

export declare function sliceDays(buckets: DailyMap, days: number | null): DailyMap;
export interface Preset {
  days: number;
  enabled: boolean;
}
export declare function availablePresets(buckets: DailyMap, presets?: number[]): Preset[];
/** Only the fields the delta reads — a caller does not need a whole record. */
export interface CumulativeSample {
  ts: string;
  openvsx?: { downloads?: number } | null;
  vsmarketplace?: { downloads?: number } | null;
}
export declare function deltaWithin(
  marketplace: CumulativeSample[],
  days: number | null,
  anchorDay: string | null,
): { vsx: number; vsm: number } | null;

/** The inlined favicon as a `data:image/svg+xml,` URI, percent-encoded. */
export declare function faviconDataUri(svg?: string): string;
