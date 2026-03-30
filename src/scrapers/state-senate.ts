/**
 * NY State Senate data.
 *
 * - Rep lookup: Wikipedia API (nysenate.gov is Cloudflare-blocked)
 * - Bill search: fetch-based against nysenate.gov search (best-effort)
 * - Votes: Not available without NY Open Legislation API key
 *   (register at legislation.nysenate.gov)
 *
 * Note: Federal-level senate votes (Schumer, Gillibrand) are handled by
 * the congress module using senate.gov XML. This module covers state-level
 * senate activity only.
 */

import type { Bill, Vote } from "../types.js";

// ---------------------------------------------------------------------------
// Bill search — fetch-based
// ---------------------------------------------------------------------------

/**
 * Search NY State Senate bills by keyword.
 * Uses nysenate.gov search which may be Cloudflare-protected.
 */
export async function searchSenateBills(query: string): Promise<{ bills: Bill[]; errors: string[] }> {
  const bills: Bill[] = [];
  const errors: string[] = [];

  try {
    const url = `https://www.nysenate.gov/search/legislation?search=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "text/html",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      if (res.status === 403) {
        errors.push("nysenate.gov blocked request (Cloudflare). State senate bill search unavailable.");
      } else {
        errors.push(`nysenate.gov returned ${res.status}`);
      }
      return { bills, errors };
    }

    const html = await res.text();

    // Extract bill links from search results
    const billPattern = /href="[^"]*\/legislation\/bills\/(\d{4})\/([SA]\d+[A-Z]?)"/gi;
    const seen = new Set<string>();
    let match;
    while ((match = billPattern.exec(html)) !== null) {
      const year = match[1];
      const billNum = match[2].toUpperCase();
      const id = `${billNum}-${year}`;
      if (seen.has(id)) continue;
      seen.add(id);

      // Try to extract title from surrounding context
      const idx = match.index;
      const context = html.slice(Math.max(0, idx - 200), idx + 300);
      const titleMatch = context.match(/>([^<]{10,200})</);
      const title = titleMatch ? titleMatch[1].trim() : id;

      bills.push({
        id,
        level: "state",
        title,
        summary: null,
        status: null,
        sponsors: [],
        scrapedAt: Date.now(),
      });
    }

    if (bills.length === 0) {
      errors.push("No legislation results found on nysenate.gov");
    }
  } catch (e) {
    errors.push(`Senate bill search: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { bills, errors };
}

// ---------------------------------------------------------------------------
// Vote scrapers — require NY Open Legislation API key
// ---------------------------------------------------------------------------

/**
 * Scrape votes cast by a specific state senator.
 * Requires NY Open Legislation API key (not currently configured).
 */
export async function scrapeSenatorVotes(district: number): Promise<{ votes: Vote[]; errors: string[] }> {
  return {
    votes: [],
    errors: [
      `State senate voting records require the NY Open Legislation API key. ` +
      `Register at https://legislation.nysenate.gov to get one. ` +
      `Note: Federal senate votes (Schumer/Gillibrand) are available under "Federal" level.`,
    ],
  };
}
