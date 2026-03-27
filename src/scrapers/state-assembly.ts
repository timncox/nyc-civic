/**
 * NY State Assembly data.
 *
 * - Rep lookup: direct fetch against nyassembly.gov/mem/ (works without JS)
 * - Bill search: fetch-based against nyassembly.gov/leg/
 * - Votes: Floor votes require JS rendering; not available via fetch.
 *   Would need the NY Open Legislation API key (legislation.nysenate.gov)
 */

import type { Rep, Bill, Vote } from "../types.js";
import { lookupAssemblyMember } from "../reps-lookup.js";

const BASE_URL = "https://nyassembly.gov";
const FETCH_TIMEOUT = 15_000;
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  "Accept": "text/html",
};

// ---------------------------------------------------------------------------
// Rep lookup wrapper
// ---------------------------------------------------------------------------

export async function scrapeAssemblyMember(district: number): Promise<{ rep: Rep | null; errors: string[] }> {
  try {
    const rep = await lookupAssemblyMember(district);
    return { rep, errors: rep ? [] : [`Could not find assembly member for district ${district}`] };
  } catch (e) {
    return { rep: null, errors: [`Assembly member lookup failed: ${e instanceof Error ? e.message : String(e)}`] };
  }
}

// ---------------------------------------------------------------------------
// Bill search — fetch-based
// ---------------------------------------------------------------------------

/**
 * Search assembly bills by keyword.
 * Uses the nyassembly.gov legislation search form.
 */
export async function searchAssemblyBills(query: string): Promise<{ bills: Bill[]; errors: string[] }> {
  const bills: Bill[] = [];
  const errors: string[] = [];

  try {
    const url = `${BASE_URL}/leg/?default_fld=&leg_video=&bn=${encodeURIComponent(query)}&term=0&Summary=Y&Actions=Y`;
    const res = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });

    if (!res.ok) {
      errors.push(`nyassembly.gov returned ${res.status}`);
      return { bills, errors };
    }

    const html = await res.text();

    // Extract bill info from the results page
    // Bills appear as links like /leg/?bn=A01234
    const billPattern = /href="[^"]*\/leg\/\?bn=([A]\d+[A-Z]?)(?:&[^"]*)?"/gi;
    const seen = new Set<string>();
    let match;
    while ((match = billPattern.exec(html)) !== null) {
      const billNum = match[1].toUpperCase();
      if (seen.has(billNum)) continue;
      seen.add(billNum);

      // Extract title from nearby text
      const idx = match.index;
      const context = html.slice(idx, idx + 500);
      const titleMatch = context.match(/>([^<]{10,200})</);
      const title = titleMatch ? titleMatch[1].trim() : billNum;

      bills.push({
        id: billNum,
        level: "state",
        title,
        summary: null,
        status: null,
        sponsors: [],
        scrapedAt: Date.now(),
      });
    }

    // If direct bill number search, try to extract details from the page
    if (bills.length === 0) {
      // Check if the page has bill details (direct bill number match)
      const titleMatch = html.match(/<title>\s*(.+?)\s*<\/title>/i);
      const billNumMatch = query.match(/^[A]\d+/i);
      if (billNumMatch && titleMatch) {
        const summary = html.match(/id="jump_to_Summary"[\s\S]*?<pre[^>]*>([\s\S]*?)<\/pre>/i);
        bills.push({
          id: billNumMatch[0].toUpperCase(),
          level: "state",
          title: titleMatch[1].replace(/ - New York State Assembly$/, "").trim(),
          summary: summary ? summary[1].replace(/<[^>]+>/g, "").trim().slice(0, 500) : null,
          status: null,
          sponsors: [],
          scrapedAt: Date.now(),
        });
      }
    }

    if (bills.length === 0) {
      errors.push("No assembly bill results found");
    }
  } catch (e) {
    errors.push(`Assembly bill search: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { bills, errors };
}

// ---------------------------------------------------------------------------
// Vote scrapers — require JS or NY Open Legislation API
// ---------------------------------------------------------------------------

/**
 * Get votes for a specific assembly member.
 * Floor votes on nyassembly.gov require JS rendering.
 * Would need the NY Open Legislation API key for reliable access.
 */
export async function scrapeAssemblyMemberVotes(district: number): Promise<{ votes: Vote[]; errors: string[] }> {
  return {
    votes: [],
    errors: [
      `State assembly voting records require the NY Open Legislation API key. ` +
      `Register at https://legislation.nysenate.gov to get one. ` +
      `The nyassembly.gov floor votes page requires JavaScript rendering.`,
    ],
  };
}
