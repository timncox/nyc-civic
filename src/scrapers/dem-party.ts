import { chromium, type Browser, type Page } from "playwright";
import type { PartyOrg } from "../types.js";

// ---------------------------------------------------------------------------
// Borough sites
// ---------------------------------------------------------------------------

const BOROUGH_SITES: Record<string, { url: string; county: string }> = {
  manhattan: { url: "https://nycdemocrats.org", county: "New York" },
  brooklyn: { url: "https://brooklyndemocrats.com", county: "Kings" },
  queens: { url: "https://queensdemocrats.org", county: "Queens" },
  bronx: { url: "https://bronxdemocrats.org", county: "Bronx" },
  statenisland: { url: "https://richmondcountydemocrats.com", county: "Richmond" },
};

// ---------------------------------------------------------------------------
// Name normalization
// ---------------------------------------------------------------------------

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

/**
 * Normalize a borough name to a canonical key used in BOROUGH_SITES.
 *
 * Accepts common aliases ("New York" → "manhattan", "Kings" → "brooklyn",
 * "Richmond" → "statenisland", etc.).
 */
export function boroughFromName(borough: string): string {
  const key = borough.trim().toLowerCase().replace(/\s+/g, " ");
  return BOROUGH_ALIASES[key] ?? key;
}

// ---------------------------------------------------------------------------
// Slug helper
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function makeId(borough: string, role: PartyOrg["role"], name: string): string {
  return `dem-${borough}-${role}-${slugify(name)}`;
}

// ---------------------------------------------------------------------------
// Per-borough scrapers
// ---------------------------------------------------------------------------

/**
 * Scrape leadership from a typical party website.
 *
 * Strategy: look for pages containing "leadership", "officers", "executive",
 * or scan the homepage for common headings.  Because these sites vary wildly,
 * we try several selectors and return whatever we find.
 */
async function scrapeLeadership(
  page: Page,
  baseUrl: string,
  borough: string,
  errors: string[],
): Promise<PartyOrg[]> {
  const orgs: PartyOrg[] = [];
  const now = Date.now();

  // Candidate paths for a leadership page
  const paths = [
    "/leadership",
    "/officers",
    "/about",
    "/about-us",
    "/executive-committee",
    "/our-leadership",
    "/county-committee",
  ];

  let found = false;

  for (const path of paths) {
    try {
      const resp = await page.goto(`${baseUrl}${path}`, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      if (!resp || resp.status() >= 400) continue;

      // Wait a moment for any JS rendering
      await page.waitForTimeout(2_000);

      // Try to extract structured name/role pairs from the page
      const people = await page.evaluate(() => {
        const results: Array<{ name: string; role: string }> = [];

        // Strategy 1: look for heading + paragraph pairs
        const headings = document.querySelectorAll("h2, h3, h4, h5, strong, b");
        for (const h of headings) {
          const text = (h.textContent ?? "").trim();
          // Check if text looks like a role
          const rolePattern =
            /chair|vice.chair|secretary|treasurer|executive|leader|president/i;
          if (rolePattern.test(text)) {
            // The next sibling or parent may have names
            const parent = h.closest("li, div, p, section, article");
            if (parent) {
              const allText = (parent.textContent ?? "").trim();
              // Try to separate role from name
              const nameText = allText.replace(text, "").trim().replace(/^[:\-–—\s]+/, "");
              if (nameText && nameText.length < 120) {
                results.push({ role: text, name: nameText.split("\n")[0].trim() });
              }
            }
          }
        }

        // Strategy 2: look for list items with role-like text
        if (results.length === 0) {
          const items = document.querySelectorAll("li, .team-member, .member, .officer");
          for (const item of items) {
            const text = (item.textContent ?? "").trim();
            const match = text.match(
              /(.+?)[\s\-–—:]+\s*(county\s+chair|chair(?:person|man|woman)?|vice.chair|district\s+leader|secretary|treasurer)/i,
            );
            if (match) {
              results.push({ name: match[1].trim(), role: match[2].trim() });
            }
            const matchReverse = text.match(
              /(county\s+chair|chair(?:person|man|woman)?|vice.chair|district\s+leader|secretary|treasurer)[\s\-–—:]+\s*(.+)/i,
            );
            if (matchReverse && !match) {
              results.push({ name: matchReverse[2].trim(), role: matchReverse[1].trim() });
            }
          }
        }

        return results;
      });

      for (const p of people) {
        const role = categorizeRole(p.role);
        orgs.push({
          id: makeId(borough, role, p.name),
          borough,
          role,
          name: p.name,
          assemblyDistrict: null,
          electionDistrict: null,
          details: { rawRole: p.role, source: `${baseUrl}${path}` },
          scrapedAt: now,
        });
      }

      if (people.length > 0) {
        found = true;
        break;
      }
    } catch {
      // This path failed — try next
    }
  }

  if (!found) {
    errors.push(`${borough}: could not find leadership page on ${baseUrl}`);
  }

  return orgs;
}

/**
 * Scrape district leaders from the site.
 *
 * District leaders are elected per Assembly District (one male, one female
 * per part).  Sites may list them on a dedicated page or embedded in the
 * leadership page.
 */
async function scrapeDistrictLeaders(
  page: Page,
  baseUrl: string,
  borough: string,
  errors: string[],
): Promise<PartyOrg[]> {
  const orgs: PartyOrg[] = [];
  const now = Date.now();

  const paths = [
    "/district-leaders",
    "/leadership/district-leaders",
    "/district-leader",
    "/leaders",
    "/about/district-leaders",
  ];

  for (const path of paths) {
    try {
      const resp = await page.goto(`${baseUrl}${path}`, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      if (!resp || resp.status() >= 400) continue;

      await page.waitForTimeout(2_000);

      const leaders = await page.evaluate(() => {
        const results: Array<{ name: string; ad: number | null; gender: string | null }> = [];

        // Look for tabular data first
        const tables = document.querySelectorAll("table");
        for (const table of tables) {
          const rows = table.querySelectorAll("tr");
          for (const row of rows) {
            const cells = row.querySelectorAll("td, th");
            const texts = Array.from(cells).map((c) => (c.textContent ?? "").trim());
            const joined = texts.join(" ");

            // Try to find AD number
            const adMatch = joined.match(/(?:AD|Assembly\s*District)\s*(\d{1,3})/i);
            const ad = adMatch ? parseInt(adMatch[1], 10) : null;

            // Names are typically in cells — look for non-numeric, non-header cells
            for (const text of texts) {
              if (
                text.length > 2 &&
                text.length < 80 &&
                !/^(AD|Assembly|District|Name|Male|Female|Part|Leader|\d+)$/i.test(text) &&
                !/^\d+$/.test(text)
              ) {
                const genderMatch = joined.match(/\b(male|female)\b/i);
                results.push({
                  name: text,
                  ad,
                  gender: genderMatch ? genderMatch[1].toLowerCase() : null,
                });
              }
            }
          }
        }

        // Fallback: list items
        if (results.length === 0) {
          const items = document.querySelectorAll("li, .district-leader, .leader");
          for (const item of items) {
            const text = (item.textContent ?? "").trim();
            const adMatch = text.match(/(?:AD|Assembly\s*District)\s*(\d{1,3})/i);
            const nameMatch = text.match(
              /(?:AD\s*\d+\s*[-–:]\s*)(.+)|(.+?)(?:\s*[-–:]\s*AD\s*\d+)/i,
            );
            if (nameMatch) {
              results.push({
                name: (nameMatch[1] || nameMatch[2]).trim(),
                ad: adMatch ? parseInt(adMatch[1], 10) : null,
                gender: null,
              });
            }
          }
        }

        return results;
      });

      for (const dl of leaders) {
        orgs.push({
          id: makeId(borough, "district_leader", dl.name),
          borough,
          role: "district_leader",
          name: dl.name,
          assemblyDistrict: dl.ad,
          electionDistrict: null,
          details: {
            gender: dl.gender,
            source: `${baseUrl}${path}`,
          },
          scrapedAt: now,
        });
      }

      if (leaders.length > 0) break;
    } catch {
      // Try next path
    }
  }

  if (orgs.length === 0) {
    errors.push(`${borough}: could not find district leaders on ${baseUrl}`);
  }

  return orgs;
}

/**
 * Scrape county committee members where available.
 *
 * Most borough sites do not publish full county committee rosters online,
 * so this is best-effort.
 */
async function scrapeCountyCommittee(
  page: Page,
  baseUrl: string,
  borough: string,
  errors: string[],
): Promise<PartyOrg[]> {
  const orgs: PartyOrg[] = [];
  const now = Date.now();

  const paths = [
    "/county-committee",
    "/county-committee-members",
    "/committee-members",
    "/members",
  ];

  for (const path of paths) {
    try {
      const resp = await page.goto(`${baseUrl}${path}`, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      if (!resp || resp.status() >= 400) continue;

      await page.waitForTimeout(2_000);

      const members = await page.evaluate(() => {
        const results: Array<{ name: string; ad: number | null; ed: number | null }> = [];

        const tables = document.querySelectorAll("table");
        for (const table of tables) {
          const rows = table.querySelectorAll("tr");
          for (const row of rows) {
            const cells = row.querySelectorAll("td");
            const texts = Array.from(cells).map((c) => (c.textContent ?? "").trim());
            if (texts.length < 1) continue;

            const joined = texts.join(" ");
            const adMatch = joined.match(/(?:AD|Assembly)\s*(\d{1,3})/i);
            const edMatch = joined.match(/(?:ED|Election\s*District)\s*(\d{1,3})/i);

            // Heuristic: the longest non-numeric cell is likely the name
            const nameCandidates = texts.filter(
              (t) => t.length > 2 && !/^\d+$/.test(t) && !/^(AD|ED|Name)/i.test(t),
            );
            const name = nameCandidates.sort((a, b) => b.length - a.length)[0];
            if (name) {
              results.push({
                name,
                ad: adMatch ? parseInt(adMatch[1], 10) : null,
                ed: edMatch ? parseInt(edMatch[1], 10) : null,
              });
            }
          }
        }

        return results;
      });

      for (const m of members) {
        orgs.push({
          id: makeId(borough, "county_committee", m.name),
          borough,
          role: "county_committee",
          name: m.name,
          assemblyDistrict: m.ad,
          electionDistrict: m.ed,
          details: { source: `${baseUrl}${path}` },
          scrapedAt: now,
        });
      }

      if (members.length > 0) break;
    } catch {
      // Try next path
    }
  }

  // Not all boroughs publish county committee online — this is just a warning
  if (orgs.length === 0) {
    errors.push(`${borough}: county committee data not found on ${baseUrl}`);
  }

  return orgs;
}

/**
 * Scrape events / upcoming meetings from the site.
 */
async function scrapeEvents(
  page: Page,
  baseUrl: string,
  borough: string,
  errors: string[],
): Promise<Array<{ date: string; description: string; location?: string }>> {
  const events: Array<{ date: string; description: string; location?: string }> = [];

  const paths = ["/events", "/calendar", "/meetings", "/upcoming-events", "/news-events", "/"];

  for (const path of paths) {
    try {
      const resp = await page.goto(`${baseUrl}${path}`, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      if (!resp || resp.status() >= 400) continue;

      await page.waitForTimeout(2_000);

      const scraped = await page.evaluate(() => {
        const results: Array<{ date: string; description: string; location?: string }> = [];

        // Common event selectors (WordPress, Squarespace, custom sites)
        const eventSelectors = [
          ".event",
          ".tribe-events-calendar .tribe-event-url",
          ".eventlist-event",
          "[class*='event']",
          "article",
          ".post",
        ];

        for (const sel of eventSelectors) {
          const elems = document.querySelectorAll(sel);
          for (const elem of elems) {
            const text = (elem.textContent ?? "").trim();
            // Try to find a date pattern
            const dateMatch = text.match(
              /(\d{1,2}\/\d{1,2}\/\d{2,4})|(\w+\s+\d{1,2},?\s+\d{4})|(\d{4}-\d{2}-\d{2})/,
            );
            if (!dateMatch) continue;

            const title =
              elem.querySelector("h1, h2, h3, h4, .event-title, .summary, a")?.textContent?.trim() ??
              text.slice(0, 120);
            const location =
              elem.querySelector(".event-location, .location, address")?.textContent?.trim();

            results.push({
              date: dateMatch[0],
              description: title,
              ...(location ? { location } : {}),
            });
          }
          if (results.length > 0) break;
        }

        return results;
      });

      events.push(...scraped);
      if (scraped.length > 0) break;
    } catch {
      // Try next path
    }
  }

  if (events.length === 0) {
    errors.push(`${borough}: no events found on ${baseUrl}`);
  }

  return events;
}

/**
 * Scrape volunteer / get-involved links from the site.
 */
async function scrapeInvolveLinks(
  page: Page,
  baseUrl: string,
  borough: string,
  errors: string[],
): Promise<string[]> {
  const links: string[] = [];

  const paths = ["/get-involved", "/volunteer", "/join", "/clubs", "/democratic-clubs", "/"];

  for (const path of paths) {
    try {
      const resp = await page.goto(`${baseUrl}${path}`, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      if (!resp || resp.status() >= 400) continue;

      await page.waitForTimeout(1_500);

      const found = await page.evaluate((base: string) => {
        const results: string[] = [];
        const anchors = document.querySelectorAll("a[href]");
        for (const a of anchors) {
          const href = a.getAttribute("href") ?? "";
          const text = (a.textContent ?? "").toLowerCase();
          if (
            /volunteer|get.involved|join|sign.up|club|become.a.member|action/i.test(text) ||
            /volunteer|get-involved|join|signup|clubs/i.test(href)
          ) {
            let url = href;
            if (url.startsWith("/")) url = `${base}${url}`;
            if (url.startsWith("http")) results.push(url);
          }
        }
        return [...new Set(results)];
      }, baseUrl);

      links.push(...found);
      if (found.length > 0) break;
    } catch {
      // Try next path
    }
  }

  if (links.length === 0) {
    errors.push(`${borough}: no involvement links found on ${baseUrl}`);
  }

  return links;
}

// ---------------------------------------------------------------------------
// Role categorization
// ---------------------------------------------------------------------------

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
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrape all Democratic Party data for a single borough.
 *
 * Launches a headless browser, tries each section independently, and
 * returns partial results if some sections fail.
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
  let events: Array<{ date: string; description: string; location?: string }> = [];
  let involveLinks: string[] = [];

  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    // 1. Leadership
    try {
      const leadership = await scrapeLeadership(page, site.url, key, errors);
      orgs.push(...leadership);
    } catch (e) {
      errors.push(`${key}: leadership scrape failed — ${e instanceof Error ? e.message : String(e)}`);
    }

    // 2. District Leaders
    try {
      const districtLeaders = await scrapeDistrictLeaders(page, site.url, key, errors);
      orgs.push(...districtLeaders);
    } catch (e) {
      errors.push(`${key}: district leaders scrape failed — ${e instanceof Error ? e.message : String(e)}`);
    }

    // 3. County Committee
    try {
      const cc = await scrapeCountyCommittee(page, site.url, key, errors);
      orgs.push(...cc);
    } catch (e) {
      errors.push(`${key}: county committee scrape failed — ${e instanceof Error ? e.message : String(e)}`);
    }

    // 4. Events
    try {
      events = await scrapeEvents(page, site.url, key, errors);
    } catch (e) {
      errors.push(`${key}: events scrape failed — ${e instanceof Error ? e.message : String(e)}`);
    }

    // 5. Get Involved links
    try {
      involveLinks = await scrapeInvolveLinks(page, site.url, key, errors);
    } catch (e) {
      errors.push(`${key}: involve links scrape failed — ${e instanceof Error ? e.message : String(e)}`);
    }
  } catch (e) {
    errors.push(`${key}: browser launch failed — ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore close errors
      }
    }
  }

  return { orgs, events, involveLinks, errors };
}

/**
 * Scrape all 5 NYC borough Democratic Party organizations.
 *
 * Each borough is scraped independently — a failure in one does not
 * block the others.
 */
export async function scrapeAllBoroughParties(): Promise<{
  orgs: PartyOrg[];
  errors: string[];
}> {
  const allOrgs: PartyOrg[] = [];
  const allErrors: string[] = [];

  const boroughs = Object.keys(BOROUGH_SITES);

  // Scrape sequentially to avoid overwhelming sites / running too many browsers
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
 * Get party information relevant to a specific assembly district (and
 * optionally election district) within a borough.
 *
 * Returns the borough-level leadership plus any district leaders and
 * county committee members matching the given district(s).
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

  // Further filter by election district if provided
  if (electionDistrict != null) {
    const edFiltered = countyCommittee.filter(
      (o) => o.electionDistrict === electionDistrict || o.electionDistrict === null,
    );
    // Only narrow if we actually have ED-level data
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
