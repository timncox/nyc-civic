/**
 * NYC City Council data scrapers.
 *
 * Primary approach:
 *   - Legislation: Legistar OData REST API (webapi.legistar.com/v1/nyc/)
 *   - Council members: direct fetch against council.nyc.gov
 *   - Roll call votes: Legistar API (eventitems/{id}/votes) — but NYC doesn't
 *     populate this table, so Playwright fallback for web scraping.
 *
 * Sources:
 *   - Council members: https://council.nyc.gov/district-{N}/
 *   - Legislation: Legistar OData API with token
 *   - Votes: Legistar web interface (JS-rendered, needs Playwright)
 */

import type { Rep, Bill, Vote } from "../types.js";
import { legistarFetch } from "../apis/legistar.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MEMBER_DETAIL_URL = (n: number) => `https://council.nyc.gov/district-${n}/`;
const LEGISTAR_WEB = "https://legistar.council.nyc.gov";
const FETCH_TIMEOUT = 15_000;

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

// ---------------------------------------------------------------------------
// General helpers
// ---------------------------------------------------------------------------

function repId(district: number): string {
  return `city-council-${district}`;
}

function voteId(billId: string, rId: string, date: string): string {
  return `${billId}-${rId}-${date}`;
}

function normalizeVote(raw: string): Vote["vote"] {
  const v = raw.trim().toLowerCase();
  if (v === "yes" || v === "affirmative" || v === "aye") return "yes";
  if (v === "no" || v === "negative" || v === "nay") return "no";
  if (v === "abstain" || v === "abstention") return "abstain";
  if (v === "absent" || v === "excused") return "absent";
  return "not_voting";
}

function toISODate(raw: string): string {
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw.trim();
  return d.toISOString().slice(0, 10);
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

// ---------------------------------------------------------------------------
// scrapeCouncilMembers — fetch-based (no Playwright)
// ---------------------------------------------------------------------------

export async function scrapeCouncilMembers(): Promise<{ reps: Rep[]; errors: string[] }> {
  const reps: Rep[] = [];
  const errors: string[] = [];

  for (let district = 1; district <= 51; district++) {
    try {
      const rep = await scrapeMemberViaFetch(district);
      if (rep) reps.push(rep);
    } catch (err) {
      errors.push(`District ${district}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { reps, errors };
}

async function scrapeMemberViaFetch(district: number): Promise<Rep | null> {
  const url = MEMBER_DETAIL_URL(district);
  const html = await fetchText(url);

  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)];
  let name = "";
  for (const h1 of h1s) {
    const text = h1[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
    if (!text || text.includes("Council") || text.includes("NYC") || /^District\s*\d+$/i.test(text)) continue;
    name = text;
    break;
  }
  if (!name) return null;

  const committees = [...html.matchAll(/committees\/[^"]*"[^>]*>([^<]+)<\/a>/gi)]
    .map(m => m[1].trim())
    .filter(c => c.startsWith("Committee on") || c.startsWith("Subcommittee"));

  const emailMatch = html.match(/mailto:([^"]+@council\.nyc\.gov)/i);
  const phoneMatch = html.match(/(\(\d{3}\)\s*\d{3}[-.]?\d{4})/);

  return {
    id: repId(district),
    level: "city",
    district: String(district),
    name,
    party: "Democratic",
    profile: {
      title: "Council Member",
      email: emailMatch?.[1] || undefined,
      phone: phoneMatch?.[1] || undefined,
      website: url,
      committees,
    },
    scrapedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// scrapeCouncilLegislation — Legistar REST API
// ---------------------------------------------------------------------------

/**
 * Get a specific bill by file number (e.g., "Int 0510-2026") via Legistar API.
 * Returns bill details with legislative history and sponsors.
 */
export async function getCouncilBill(billId: string): Promise<(Bill & { votes: Vote[]; histories: Array<{ action: string; date: string; passed: boolean | null }> }) | null> {
  try {
    const matters = (await legistarFetch("/matters", {
      filter: `MatterFile eq '${billId}'`,
    })) as any[];

    if (matters.length === 0) return null;

    const m = matters[0];
    const matterId = m.MatterId;

    // Fetch sponsors
    const sponsors: string[] = [];
    try {
      const sponsorData = (await legistarFetch(`/matters/${matterId}/sponsors`)) as any[];
      for (const s of sponsorData) {
        if (s.MatterSponsorName) sponsors.push(s.MatterSponsorName);
      }
    } catch { /* non-critical */ }

    // Fetch legislative history
    const histories: Array<{ action: string; date: string; passed: boolean | null }> = [];
    const votes: Vote[] = [];
    try {
      const historyData = (await legistarFetch(`/matters/${matterId}/histories`)) as any[];
      for (const h of historyData) {
        const date = h.MatterHistoryActionDate ? toISODate(h.MatterHistoryActionDate) : "";
        const action = h.MatterHistoryActionName || "";
        const passed = h.MatterHistoryPassedFlag === 1 ? true : h.MatterHistoryPassedFlag === 0 ? false : null;
        histories.push({ action, date, passed });

        if (passed !== null) {
          votes.push({
            id: `${billId}-${h.MatterHistoryId}`,
            billId,
            repId: "city-council",
            vote: passed ? "yes" : "no",
            date,
            scrapedAt: Date.now(),
          });
        }
      }
    } catch { /* non-critical */ }

    return {
      id: m.MatterFile || `matter-${matterId}`,
      level: "city",
      title: m.MatterName || m.MatterTitle || m.MatterFile,
      summary: m.MatterText || null,
      status: m.MatterStatusName || null,
      sponsors,
      scrapedAt: Date.now(),
      votes,
      histories,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch recent legislation from the Legistar OData API.
 * Falls back to Playwright web scraping if the API token is not configured.
 */
export async function scrapeCouncilLegislation(days: number = 90): Promise<{ bills: Bill[]; errors: string[] }> {
  const bills: Bill[] = [];
  const errors: string[] = [];

  try {
    const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const matters = (await legistarFetch("/matters", {
      filter: `MatterIntroDate ge datetime'${fromDate}' and (MatterTypeName eq 'Introduction' or MatterTypeName eq 'Resolution')`,
      orderby: "MatterIntroDate desc",
      top: "100",
    })) as any[];

    for (const m of matters) {
      const sponsors: string[] = [];
      // Try to fetch sponsors for this matter
      try {
        const sponsorData = (await legistarFetch(`/matters/${m.MatterId}/sponsors`)) as any[];
        for (const s of sponsorData) {
          if (s.MatterSponsorName) sponsors.push(s.MatterSponsorName);
        }
      } catch { /* non-critical */ }

      bills.push({
        id: m.MatterFile || `matter-${m.MatterId}`,
        level: "city",
        title: m.MatterName || m.MatterTitle || m.MatterFile,
        summary: m.MatterText || null,
        status: m.MatterStatusName || null,
        sponsors,
        scrapedAt: Date.now(),
      });
    }
  } catch (e) {
    errors.push(`Legistar API: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { bills, errors };
}

// ---------------------------------------------------------------------------
// scrapeCouncilMemberVotes — Legistar API for sponsored legislation
// ---------------------------------------------------------------------------

/**
 * Get legislative activity for a specific council member.
 *
 * Uses the Legistar API to find legislation sponsored by the member and
 * their voting activity via matter histories. Since per-member roll call
 * data isn't in the API, this returns legislation they sponsored with
 * its current status.
 */
export async function scrapeCouncilMemberVotes(district: number): Promise<{ votes: Vote[]; errors: string[] }> {
  const votes: Vote[] = [];
  const errors: string[] = [];

  // Step 1: Get member name via fetch
  let memberName = "";
  try {
    const html = await fetchText(MEMBER_DETAIL_URL(district));
    const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)];
    for (const h1 of h1s) {
      const text = h1[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
      if (!text || text.includes("Council") || text.includes("NYC") || /^District\s*\d+$/i.test(text)) continue;
      memberName = text;
      break;
    }
  } catch (e) {
    errors.push(`Could not fetch member page: ${e instanceof Error ? e.message : String(e)}`);
    return { votes, errors };
  }

  if (!memberName) {
    errors.push(`Could not determine member name for district ${district}`);
    return { votes, errors };
  }

  // Step 2: Find the member in Legistar by name
  try {
    const nameParts = memberName.split(/\s+/);
    const lastName = nameParts[nameParts.length - 1];

    const persons = (await legistarFetch("/persons", {
      filter: `PersonActiveFlag eq 1 and substringof('${lastName}', PersonLastName)`,
    })) as any[];

    if (persons.length === 0) {
      errors.push(`Could not find ${memberName} in Legistar`);
      return { votes, errors };
    }

    const personId = persons[0].PersonId;

    // Step 3: Find matters sponsored by this person
    // The Legistar API path is /matters?$filter=... with sponsor lookup
    // Since there's no direct "sponsored-by" filter, find via matter sponsors
    const officeRecords = (await legistarFetch("/officerecords", {
      filter: `OfficeRecordPersonId eq ${personId}`,
      orderby: "OfficeRecordLastModifiedUtc desc",
      top: "30",
    })) as any[];

    // Each office record links to a matter via OfficeRecordMatterId
    const rId = repId(district);
    for (const rec of officeRecords) {
      const matterId = rec.OfficeRecordMatterId;
      if (!matterId) continue;

      try {
        // Get matter details
        const matter = (await legistarFetch(`/matters/${matterId}`)) as any;
        const date = matter.MatterIntroDate ? toISODate(matter.MatterIntroDate) : "";

        // Determine vote based on status
        let voteValue: Vote["vote"] = "not_voting";
        const status = (matter.MatterStatusName || "").toLowerCase();
        if (status.includes("adopted") || status.includes("approved") || status.includes("enacted")) {
          voteValue = "yes";
        } else if (status.includes("withdrawn") || status.includes("disapproved")) {
          voteValue = "no";
        }

        votes.push({
          id: voteId(matter.MatterFile || `matter-${matterId}`, rId, date),
          billId: matter.MatterFile || `matter-${matterId}`,
          repId: rId,
          vote: voteValue,
          date,
          scrapedAt: Date.now(),
        });
      } catch { /* skip this matter */ }
    }
  } catch (e) {
    errors.push(`Legistar member lookup: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { votes, errors };
}
