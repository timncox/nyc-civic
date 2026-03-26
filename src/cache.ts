import { loadConfig } from "./config.js";

// Default TTLs in milliseconds
const DEFAULT_TTLS: Record<string, number> = {
  city: 24 * 60 * 60 * 1000,           // 24 hours
  state: 24 * 60 * 60 * 1000,          // 24 hours
  federal: 24 * 60 * 60 * 1000,        // 24 hours
  party: 30 * 24 * 60 * 60 * 1000,     // 30 days
  community_board: 7 * 24 * 60 * 60 * 1000, // 7 days
  districts: 90 * 24 * 60 * 60 * 1000, // 90 days
  boe: 90 * 24 * 60 * 60 * 1000,       // 90 days
};

export function getTtl(category: string): number {
  const overrides = loadConfig().ttl_overrides;
  return overrides[category] ?? DEFAULT_TTLS[category] ?? DEFAULT_TTLS.city;
}

export function isStale(scrapedAt: number, category: string): boolean {
  return Date.now() - scrapedAt > getTtl(category);
}

export function isExpired(scrapedAt: number, category: string): boolean {
  // Hard expiry at 3x TTL — after this, refuse to serve stale
  return Date.now() - scrapedAt > getTtl(category) * 3;
}
