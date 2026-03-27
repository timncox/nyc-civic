/**
 * NYC Democratic Party organization data.
 *
 * Strategy: Wikipedia API for boroughs with pages (Manhattan, Brooklyn),
 * known-leaders dataset for all 5 boroughs (county chairs change rarely),
 * and direct fetch for borough party websites when accessible.
 *
 * No Playwright dependency.
 */

import type { PartyOrg } from "../types.js";

// ---------------------------------------------------------------------------
// Borough configuration
// ---------------------------------------------------------------------------

const BOROUGH_SITES: Record<string, { url: string; county: string; wikipedia?: string }> = {
  manhattan: { url: "https://manhattandemocrats.org", county: "New York", wikipedia: "Manhattan_Democratic_Party" },
  brooklyn: { url: "https://brooklyndemocrats.com", county: "Kings", wikipedia: "Brooklyn_Democratic_Party" },
  queens: { url: "https://queensdemocrats.org", county: "Queens" },
  bronx: { url: "https://bronxdemocrats.org", county: "Bronx" },
  statenisland: { url: "https://richmondcountydemocrats.com", county: "Richmond" },
};

const BOROUGH_ALIASES: Record<string, string> = {
  manhattan: "manhattan",
  "new york": "manhattan",
  newyork: "manhattan",
  ny: "manhattan",
  brooklyn: "brooklyn",
  kings: "brooklyn",
  queens: "queens",
  bronx: "bronx",
  "the bronx": "bronx",
  "staten island": "statenisland",
  statenisland: "statenisland",
  richmond: "statenisland",
};

// ---------------------------------------------------------------------------
// Known leadership (updated periodically — county chairs serve multi-year terms)
// ---------------------------------------------------------------------------

interface KnownLeader {
  name: string;
  role: PartyOrg["role"];
  details?: Record<string, unknown>;
}

const KNOWN_LEADERS: Record<string, KnownLeader[]> = {
  manhattan: [
    { name: "Kyle Ishmael", role: "chair", details: { title: "County Chair" } },
  ],
  brooklyn: [
    { name: "Rodneyse Bichotte Hermelyn", role: "chair", details: { title: "County Chair", alsoServes: "Assembly Member, District 42" } },
  ],
  queens: [
    { name: "Gregory Meeks", role: "chair", details: { title: "County Chair", alsoServes: "U.S. Representative, NY-5" } },
  ],
  bronx: [
    { name: "Jamaal Bailey", role: "chair", details: { title: "County Chair", alsoServes: "State Senator, District 36" } },
  ],
  statenisland: [
    { name: "Jessica Scarcella-Spanton", role: "chair", details: { title: "County Chair", alsoServes: "State Senator, District 23" } },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT = 12_000;
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

export function boroughFromName(borough: string): string {
  const key = borough.trim().toLowerCase().replace(/\s+/g, " ");
  return BOROUGH_ALIASES[key] ?? key;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

function makeId(borough: string, role: PartyOrg["role"], name: string): string {
  return `dem-${borough}-${role}-${slugify(name)}`;
}

function categorizeRole(raw: string): PartyOrg["role"] {
  const lower = raw.toLowerCase();
  if (/\bcounty\s+chair\b|^chair(?:person|man|woman)?$/i.test(lower)) return "chair";
  if (/vice.chair/i.test(lower)) return "vice_chair";
  if (/district\s+leader/i.test(lower)) return "district_leader";
  if (/county\s+committee/i.test(lower)) return "county_committee";
  if (/executive/i.test(lower)) return "executive_committee";
  return "other";
}

// ---------------------------------------------------------------------------
// Wikipedia scraper
// ---------------------------------------------------------------------------

async function scrapeWikipediaLeadership(
  pageTitle: string,
  borough: string,
): Promise<{ orgs: PartyOrg[]; errors: string[] }> {
  const orgs: PartyOrg[] = [];
  const errors: string[] = [];
  const now = Date.now();

  try {
    const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(pageTitle)}&prop=wikitext&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!res.ok) {
      errors.push(`Wikipedia API ${res.status} for ${pageTitle}`);
      return { orgs, errors };
    }

    const data = await res.json() as any;
    const wikitext: string = data?.parse?.wikitext?.["*"] ?? "";
    if (!wikitext) {
      errors.push(`No wikitext found for ${pageTitle}`);
      return { orgs, errors };
    }

    // Extract infobox fields
    const infoboxFields: Record<string, string> = {};
    const fieldPattern = /\|\s*(\w+)\s*=\s*([^\n|{}]+)/g;
    let match;
    while ((match = fieldPattern.exec(wikitext)) !== null) {
      infoboxFields[match[1].toLowerCase()] = match[2].trim();
    }

    // Extract chairperson
    const chairRaw = infoboxFields.chairperson || infoboxFields.chairman || infoboxFields.chair || "";
    if (chairRaw) {
      // Remove wikilinks: [[Name]] or [[Name|Display]]
      const chairName = chairRaw.replace(/\[\[([^\]|]+)\|?[^\]]*\]\]/g, "$1").replace(/\[|\]/g, "").trim();
      if (chairName) {
        orgs.push({
          id: makeId(borough, "chair", chairName),
          borough,
          role: "chair",
          name: chairName,
          assemblyDistrict: null,
          electionDistrict: null,
          details: { source: `Wikipedia: ${pageTitle}` },
          scrapedAt: now,
        });
      }
    }

    // Extract other leaders from infobox
    for (let i = 1; i <= 5; i++) {
      const title = infoboxFields[`leader${i}_title`];
      const name = infoboxFields[`leader${i}_name`];
      if (title && name) {
        const cleanName = name.replace(/\[\[([^\]|]+)\|?[^\]]*\]\]/g, "$1").replace(/\[|\]/g, "").trim();
        const role = categorizeRole(title);
        if (cleanName) {
          orgs.push({
            id: makeId(borough, role, cleanName),
            borough,
            role,
            name: cleanName,
            assemblyDistrict: null,
            electionDistrict: null,
            details: { rawRole: title, source: `Wikipedia: ${pageTitle}` },
            scrapedAt: now,
          });
        }
      }
    }

    // Extract website from infobox
    const website = infoboxFields.website;
    if (website) {
      // Store as details on the chair org (if exists)
      const chairOrg = orgs.find(o => o.role === "chair");
      if (chairOrg) {
        chairOrg.details = { ...chairOrg.details, website };
      }
    }
  } catch (e) {
    errors.push(`Wikipedia scrape failed for ${borough}: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { orgs, errors };
}

// ---------------------------------------------------------------------------
// Website scraper (fetch-based, best effort)
// ---------------------------------------------------------------------------

async function scrapeWebsite(
  baseUrl: string,
  borough: string,
): Promise<{
  events: Array<{ date: string; description: string; location?: string }>;
  involveLinks: string[];
  errors: string[];
}> {
  const events: Array<{ date: string; description: string; location?: string }> = [];
  const involveLinks: string[] = [];
  const errors: string[] = [];

  // Try fetching the homepage
  let html = "";
  try {
    const res = await fetch(baseUrl, {
      headers: HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      redirect: "follow",
    });
    if (!res.ok) {
      errors.push(`${borough}: ${baseUrl} returned ${res.status}`);
      return { events, involveLinks, errors };
    }
    html = await res.text();
  } catch (e) {
    errors.push(`${borough}: ${baseUrl} unreachable — ${e instanceof Error ? e.message : String(e)}`);
    return { events, involveLinks, errors };
  }

  // Extract events (dates + surrounding text)
  const datePattern = /(\d{1,2}\/\d{1,2}\/\d{2,4})|(\w+\s+\d{1,2},?\s+\d{4})|(\d{4}-\d{2}-\d{2})/g;
  let dateMatch;
  while ((dateMatch = datePattern.exec(html)) !== null) {
    const date = dateMatch[0];
    // Get surrounding context (100 chars around the date)
    const start = Math.max(0, dateMatch.index - 100);
    const end = Math.min(html.length, dateMatch.index + date.length + 200);
    const context = html.slice(start, end).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (context.length > 10) {
      events.push({ date, description: context.slice(0, 200) });
    }
  }

  // Extract get-involved links
  const linkPattern = /<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let linkMatch;
  while ((linkMatch = linkPattern.exec(html)) !== null) {
    const href = linkMatch[1];
    const text = linkMatch[2].replace(/<[^>]+>/g, "").trim().toLowerCase();
    if (/volunteer|get.involved|join|sign.up|club|become.a.member|action/i.test(text) ||
        /volunteer|get-involved|join|signup|clubs/i.test(href)) {
      let url = href;
      if (url.startsWith("/")) url = `${baseUrl}${url}`;
      if (url.startsWith("http")) involveLinks.push(url);
    }
  }

  return { events, involveLinks: [...new Set(involveLinks)], errors };
}

// ---------------------------------------------------------------------------
// Leadership page scraper (fetch-based)
// ---------------------------------------------------------------------------

async function scrapeLeadershipPage(
  baseUrl: string,
  borough: string,
): Promise<{ orgs: PartyOrg[]; errors: string[] }> {
  const orgs: PartyOrg[] = [];
  const errors: string[] = [];
  const now = Date.now();

  const paths = ["/leadership", "/officers", "/about", "/about-us", "/our-leadership"];

  for (const path of paths) {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        headers: HEADERS,
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
        redirect: "follow",
      });
      if (!res.ok) continue;
      const html = await res.text();

      // Look for name/role pairs
      // Strategy 1: headings with role names followed by names
      const rolePattern = /(?:chair|vice.chair|secretary|treasurer|executive|leader|president)/i;
      const headingPattern = /<(?:h[2-5]|strong|b)[^>]*>([\s\S]*?)<\/(?:h[2-5]|strong|b)>/gi;
      let headingMatch;
      while ((headingMatch = headingPattern.exec(html)) !== null) {
        const headingText = headingMatch[1].replace(/<[^>]+>/g, "").trim();
        if (rolePattern.test(headingText)) {
          // Look for a name in the next 500 chars
          const after = html.slice(headingMatch.index + headingMatch[0].length, headingMatch.index + headingMatch[0].length + 500);
          const nameText = after.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
          const name = nameText.split(/[,\n]/)[0]?.trim();
          if (name && name.length > 2 && name.length < 80) {
            const role = categorizeRole(headingText);
            orgs.push({
              id: makeId(borough, role, name),
              borough,
              role,
              name,
              assemblyDistrict: null,
              electionDistrict: null,
              details: { rawRole: headingText, source: `${baseUrl}${path}` },
              scrapedAt: now,
            });
          }
        }
      }

      // Strategy 2: list items with "Name — Role" or "Role: Name" pattern
      if (orgs.length === 0) {
        const liPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;
        let liMatch;
        while ((liMatch = liPattern.exec(html)) !== null) {
          const text = liMatch[1].replace(/<[^>]+>/g, "").trim();
          const roleNameMatch = text.match(
            /(.+?)[\s\-–—:]+\s*(county\s+chair|chair(?:person|man|woman)?|vice.chair|district\s+leader|secretary|treasurer)/i,
          );
          if (roleNameMatch) {
            const role = categorizeRole(roleNameMatch[2]);
            orgs.push({
              id: makeId(borough, role, roleNameMatch[1].trim()),
              borough,
              role,
              name: roleNameMatch[1].trim(),
              assemblyDistrict: null,
              electionDistrict: null,
              details: { rawRole: roleNameMatch[2], source: `${baseUrl}${path}` },
              scrapedAt: now,
            });
          }
          const nameRoleMatch = text.match(
            /(county\s+chair|chair(?:person|man|woman)?|vice.chair|district\s+leader|secretary|treasurer)[\s\-–—:]+\s*(.+)/i,
          );
          if (nameRoleMatch && !roleNameMatch) {
            const role = categorizeRole(nameRoleMatch[1]);
            orgs.push({
              id: makeId(borough, role, nameRoleMatch[2].trim()),
              borough,
              role,
              name: nameRoleMatch[2].trim(),
              assemblyDistrict: null,
              electionDistrict: null,
              details: { rawRole: nameRoleMatch[1], source: `${baseUrl}${path}` },
              scrapedAt: now,
            });
          }
        }
      }

      if (orgs.length > 0) break;
    } catch {
      // This path failed — try next
    }
  }

  if (orgs.length === 0) {
    errors.push(`${borough}: could not find leadership on ${baseUrl}`);
  }

  return { orgs, errors };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrape Democratic Party data for a single borough.
 *
 * Combines data from: Wikipedia (leadership), website (events, involvement),
 * and known-leaders fallback.
 */
export async function scrapeBoroughParty(borough: string): Promise<{
  orgs: PartyOrg[];
  events: Array<{ date: string; description: string; location?: string }>;
  involveLinks: string[];
  errors: string[];
}> {
  const key = boroughFromName(borough);
  const site = BOROUGH_SITES[key];

  if (!site) {
    return {
      orgs: [],
      events: [],
      involveLinks: [],
      errors: [`Unknown borough: "${borough}" (resolved to "${key}")`],
    };
  }

  const orgs: PartyOrg[] = [];
  const errors: string[] = [];
  const now = Date.now();

  // 1. Try Wikipedia if available
  if (site.wikipedia) {
    const wiki = await scrapeWikipediaLeadership(site.wikipedia, key);
    orgs.push(...wiki.orgs);
    errors.push(...wiki.errors);
  }

  // 2. Try website for leadership (if Wikipedia didn't find anything)
  if (orgs.length === 0) {
    const web = await scrapeLeadershipPage(site.url, key);
    orgs.push(...web.orgs);
    errors.push(...web.errors);
  }

  // 3. Fill in from known leaders if we still have no data
  if (orgs.length === 0 && KNOWN_LEADERS[key]) {
    for (const leader of KNOWN_LEADERS[key]) {
      orgs.push({
        id: makeId(key, leader.role, leader.name),
        borough: key,
        role: leader.role,
        name: leader.name,
        assemblyDistrict: null,
        electionDistrict: null,
        details: { ...leader.details, source: "known-leaders-dataset" },
        scrapedAt: now,
      });
    }
  }

  // 4. Try website for events and involvement links
  let events: Array<{ date: string; description: string; location?: string }> = [];
  let involveLinks: string[] = [];
  const webData = await scrapeWebsite(site.url, key);
  events = webData.events;
  involveLinks = webData.involveLinks;
  // Website errors are non-critical (many sites are down)
  if (webData.errors.length > 0 && orgs.length === 0) {
    errors.push(...webData.errors);
  }

  return { orgs, events, involveLinks, errors };
}

/**
 * Scrape all 5 NYC borough Democratic Party organizations.
 */
export async function scrapeAllBoroughParties(): Promise<{
  orgs: PartyOrg[];
  errors: string[];
}> {
  const allOrgs: PartyOrg[] = [];
  const allErrors: string[] = [];

  const boroughs = Object.keys(BOROUGH_SITES);

  for (const borough of boroughs) {
    try {
      const result = await scrapeBoroughParty(borough);
      allOrgs.push(...result.orgs);
      allErrors.push(...result.errors);
    } catch (e) {
      allErrors.push(
        `${borough}: unexpected error — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return { orgs: allOrgs, errors: allErrors };
}

/**
 * Get party information relevant to a specific assembly district within a borough.
 */
export async function getPartyForDistrict(
  borough: string,
  assemblyDistrict: number,
  electionDistrict?: number,
): Promise<{
  leadership: PartyOrg[];
  districtLeaders: PartyOrg[];
  countyCommittee: PartyOrg[];
  events: Array<{ date: string; description: string }>;
  errors: string[];
}> {
  const result = await scrapeBoroughParty(borough);

  const leadership = result.orgs.filter(
    (o) => o.role === "chair" || o.role === "vice_chair" || o.role === "executive_committee",
  );

  const districtLeaders = result.orgs.filter(
    (o) =>
      o.role === "district_leader" &&
      (o.assemblyDistrict === assemblyDistrict || o.assemblyDistrict === null),
  );

  let countyCommittee = result.orgs.filter(
    (o) =>
      o.role === "county_committee" &&
      (o.assemblyDistrict === assemblyDistrict || o.assemblyDistrict === null),
  );

  if (electionDistrict != null) {
    const edFiltered = countyCommittee.filter(
      (o) => o.electionDistrict === electionDistrict || o.electionDistrict === null,
    );
    if (edFiltered.length > 0) {
      countyCommittee = edFiltered;
    }
  }

  const events = result.events.map(({ date, description }) => ({ date, description }));

  return {
    leadership,
    districtLeaders,
    countyCommittee,
    events,
    errors: result.errors,
  };
}
