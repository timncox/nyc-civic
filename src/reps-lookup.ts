/**
 * Lightweight rep lookup using direct HTTP fetch (no Playwright).
 * Falls back gracefully when sources are unavailable.
 */
import type { Rep } from "./types.js";
import { getCongressMembers, getNYSenators } from "./apis/congress.js";

// ─── City Council (council.nyc.gov) ──────────────────────────────────────────

export async function lookupCouncilMember(district: number): Promise<Rep | null> {
  try {
    const url = `https://council.nyc.gov/district-${district}/`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const html = await res.text();

    // Name is in the 3rd h1 (1st = logo, 2nd = district number, 3rd = member name)
    const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)];
    let name = "";
    for (const h1 of h1s) {
      const text = h1[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
      // Skip logo text, district numbers, and empty
      if (!text || text.includes("Council") || text.includes("NYC") || /^District\s*\d+$/.test(text)) continue;
      name = text;
      break;
    }

    if (!name) return null;

    // Extract committees
    const committees = [...html.matchAll(/committees\/[^"]*"[^>]*>([^<]+)<\/a>/gi)]
      .map(m => m[1].trim())
      .filter(c => c.length > 3);

    // Extract email
    const emailMatch = html.match(/mailto:([^"]+@council\.nyc\.gov)/i);
    const email = emailMatch?.[1] || undefined;

    // Extract phone
    const phoneMatch = html.match(/(\(\d{3}\)\s*\d{3}[-.]?\d{4})/);
    const phone = phoneMatch?.[1] || undefined;

    return {
      id: `city-council-${district}`,
      level: "city",
      district: String(district),
      name,
      party: "Democratic", // NYC council is overwhelmingly Democratic; individual party detection would need more parsing
      profile: {
        title: "Council Member",
        email,
        phone,
        website: url,
        committees,
      },
      scrapedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

// ─── State Assembly (nyassembly.gov) ─────────────────────────────────────────

export async function lookupAssemblyMember(district: number): Promise<Rep | null> {
  try {
    const url = `https://nyassembly.gov/mem/?ad=${district}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const html = await res.text();

    // Name is in <title> and in h2
    const titleMatch = html.match(/<title>\s*(.+?)\s*-\s*Assembly District/i);
    const name = titleMatch?.[1]?.trim() || "";
    if (!name) return null;

    // Extract party from page
    const partyMatch = html.match(/(Democrat|Republican|Working Families|Independent|Conservative)/i);
    const party = partyMatch?.[1] || null;

    // Extract contact info
    const emailMatch = html.match(/mailto:([^"]+@nyassembly\.gov)/i);
    const phoneMatch = html.match(/(\(\d{3}\)\s*\d{3}[-.]?\d{4})/);

    return {
      id: `state-assembly-${district}`,
      level: "state_assembly",
      district: String(district),
      name,
      party,
      profile: {
        title: "Assembly Member",
        email: emailMatch?.[1] || undefined,
        phone: phoneMatch?.[1] || undefined,
        website: url,
      },
      scrapedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

// ─── State Senate (nysenate.gov is Cloudflare-protected) ─────────────────────
// Use Wikipedia's current members list as fallback since the official site blocks all automated access.

export async function lookupStateSenator(district: number): Promise<Rep | null> {
  try {
    // Try fetching the Wikipedia page for the specific senate district
    const url = `https://en.wikipedia.org/w/api.php?action=parse&page=New_York%27s_${district}${ordinalSuffix(district)}_State_Senate_district&prop=wikitext&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    const wikitext = data?.parse?.wikitext?.["*"] || "";

    // Extract current senator from infobox
    const nameMatch = wikitext.match(/\|\s*member\d*\s*=\s*\[\[([^\]|]+)/i)
      || wikitext.match(/\|\s*representative\s*=\s*\[\[([^\]|]+)/i)
      || wikitext.match(/\|\s*senator\s*=\s*\[\[([^\]|]+)/i);
    const name = nameMatch?.[1]?.trim() || "";

    const partyMatch = wikitext.match(/\|\s*party\d*\s*=\s*(\w[\w\s]*)/i);
    const party = partyMatch?.[1]?.trim() || null;

    if (!name) return null;

    return {
      id: `state-senate-${district}`,
      level: "state_senate",
      district: String(district),
      name,
      party,
      profile: {
        title: "State Senator",
        website: `https://www.nysenate.gov/senators`,
      },
      scrapedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

function ordinalSuffix(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

// ─── Federal (Congress.gov API) ──────────────────────────────────────────────

export async function lookupFederalReps(state: string, congressionalDistrict: number): Promise<Rep[]> {
  const reps: Rep[] = [];
  try {
    const members = await getCongressMembers(state, congressionalDistrict);
    reps.push(...members);
  } catch { /* rate limited or unavailable */ }

  try {
    const senators = await getNYSenators();
    reps.push(...senators);
  } catch { /* rate limited or unavailable */ }

  return reps;
}

// ─── Unified lookup ──────────────────────────────────────────────────────────

export async function lookupAllReps(districts: {
  council: number | null;
  stateSenate: number | null;
  stateAssembly: number | null;
  congressional: number | null;
}): Promise<{ reps: Rep[]; errors: string[] }> {
  const reps: Rep[] = [];
  const errors: string[] = [];

  // Run all lookups in parallel
  const results = await Promise.allSettled([
    districts.council ? lookupCouncilMember(districts.council) : Promise.resolve(null),
    districts.stateAssembly ? lookupAssemblyMember(districts.stateAssembly) : Promise.resolve(null),
    districts.stateSenate ? lookupStateSenator(districts.stateSenate) : Promise.resolve(null),
    districts.congressional ? lookupFederalReps("NY", districts.congressional) : Promise.resolve([]),
  ]);

  // Council
  if (results[0].status === "fulfilled" && results[0].value) {
    reps.push(results[0].value);
  } else if (results[0].status === "rejected") {
    errors.push(`Council: ${results[0].reason}`);
  }

  // Assembly
  if (results[1].status === "fulfilled" && results[1].value) {
    reps.push(results[1].value);
  } else if (results[1].status === "rejected") {
    errors.push(`Assembly: ${results[1].reason}`);
  }

  // Senate
  if (results[2].status === "fulfilled" && results[2].value) {
    reps.push(results[2].value);
  } else if (results[2].status === "rejected") {
    errors.push(`Senate: ${results[2].reason}`);
  }

  // Federal
  if (results[3].status === "fulfilled" && Array.isArray(results[3].value)) {
    reps.push(...results[3].value);
  } else if (results[3].status === "rejected") {
    errors.push(`Federal: ${results[3].reason}`);
  }

  return { reps, errors };
}
