import type { DailyMap } from "./merge.mjs";
import type { OpenVsxReach, VsMarketplaceReach } from "./sources.mjs";

export interface DashboardData {
  meta: { firstCollected?: string; lastRun?: string; schemaVersion?: number };
  views: DailyMap;
  clones: DailyMap;
  stars: string[];
  marketplace: { ts: string; openvsx: OpenVsxReach; vsmarketplace: VsMarketplaceReach }[];
}
export declare function renderDashboard(data: DashboardData): string;
export interface MarketplaceJsonlResult {
  records: unknown[];
  skipped: number;
}
export declare function parseMarketplaceJsonl(text: string): MarketplaceJsonlResult;
