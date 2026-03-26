import { chromium, type Browser, type Page } from "playwright";
import type { Rep, Bill, Vote } from "../types.js";

const BASE_URL = "https://www.nysenate.gov";
const TIMEOUT = 15_000;

async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

/**
 * Scrape all NY State Senators from the senators listing page.
 */
export async function scrapeStateSenators(): Promise<{ reps: Rep[]; errors: string[] }> {
  const reps: Rep[] = [];
  const errors: string[] = [];
  let browser: Browser | null = null;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.goto(`${BASE_URL}/senators`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".c-senator-block, .view-senators .views-row, .nys-senator", { timeout: TIMEOUT });

    // The senators page lists all 63 senators with links to detail pages.
    // Try multiple selector strategies since the site may restructure.
    const senatorLinks = await page.$$eval(
      "a[href*='/senators/']",
      (anchors) =>
        anchors
          .map((a) => ({
            href: (a as HTMLAnchorElement).href,
            text: a.textContent?.trim() ?? "",
          }))
          .filter((l) => l.href && l.text && !l.href.endsWith("/senators/") && !l.href.endsWith("/senators"))
    );

    // Deduplicate by href
    const seen = new Set<string>();
    const uniqueLinks: { href: string; text: string }[] = [];
    for (const link of senatorLinks) {
      const path = new URL(link.href).pathname;
      if (!seen.has(path)) {
        seen.add(path);
        uniqueLinks.push(link);
      }
    }

    for (const link of uniqueLinks) {
      try {
        const detailPage = await browser.newPage();
        await detailPage.goto(link.href, { waitUntil: "domcontentloaded" });

        const rep = await scrapeSenatorDetailPage(detailPage, link.text);
        if (rep) {
          reps.push(rep);
        }

        await detailPage.close();
      } catch (err) {
        errors.push(`Failed to scrape senator at ${link.href}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    errors.push(`Failed to load senators listing: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (browser) await browser.close();
  }

  return { reps, errors };
}

/**
 * Scrape a single NY State Senator by district number.
 */
export async function scrapeStateSenator(district: number): Promise<{ rep: Rep | null; errors: string[] }> {
  const errors: string[] = [];
  let browser: Browser | null = null;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    // Navigate to the senators list and find the senator for this district
    await page.goto(`${BASE_URL}/senators`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("a[href*='/senators/']", { timeout: TIMEOUT });

    // Find senator link by district number — look for text mentioning the district
    const senatorUrl = await page.evaluate((dist: number) => {
      const links = Array.from(document.querySelectorAll("a[href*='/senators/']"));
      // Look for district indicators near senator entries
      const allElements = Array.from(document.querySelectorAll("*"));
      for (const el of allElements) {
        const text = el.textContent ?? "";
        const distPattern = new RegExp(`district\\s*${dist}\\b`, "i");
        if (distPattern.test(text)) {
          const anchor = el.querySelector("a[href*='/senators/']") ?? el.closest("a[href*='/senators/']");
          if (anchor) return (anchor as HTMLAnchorElement).href;
        }
      }
      // Fallback: senators may be numbered in order on the page
      return null;
    }, district);

    if (!senatorUrl) {
      errors.push(`Could not find senator for district ${district}`);
      return { rep: null, errors };
    }

    await page.goto(senatorUrl, { waitUntil: "domcontentloaded" });
    const rep = await scrapeSenatorDetailPage(page, "");
    if (rep) {
      // Ensure district matches
      rep.district = String(district);
      rep.id = `state-senate-${district}`;
    }
    return { rep, errors };
  } catch (err) {
    errors.push(`Failed to scrape senator for district ${district}: ${err instanceof Error ? err.message : String(err)}`);
    return { rep: null, errors };
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Extract senator details from a senator detail page.
 */
async function scrapeSenatorDetailPage(page: Page, fallbackName: string): Promise<Rep | null> {
  const data = await page.evaluate((fbName: string) => {
    const name =
      document.querySelector("h1.nys-title, h1")?.textContent?.trim() ?? fbName;

    // Try to extract district number from the page
    const districtMatch = document.body.textContent?.match(/District\s+(\d+)/i);
    const district = districtMatch ? districtMatch[1] : null;

    // Party
    const partyEl = document.querySelector(".c-senator--party, .senator-party");
    let party = partyEl?.textContent?.trim() ?? null;
    if (!party) {
      const partyMatch = document.body.textContent?.match(/\b(Democrat|Republican|Independent|Conservative|Working Families)\b/i);
      party = partyMatch ? partyMatch[1] : null;
    }

    // Photo
    const photoEl = document.querySelector<HTMLImageElement>(
      ".c-senator--photo img, .nys-senator--photo img, img[alt*='Senator'], .field--name-field-image img"
    );
    const photoUrl = photoEl?.src ?? undefined;

    // Email
    const emailLink = document.querySelector<HTMLAnchorElement>("a[href^='mailto:']");
    const email = emailLink?.href?.replace("mailto:", "") ?? undefined;

    // Phone
    const phoneLink = document.querySelector<HTMLAnchorElement>("a[href^='tel:']");
    let phone = phoneLink?.href?.replace("tel:", "") ?? undefined;
    if (!phone) {
      const phoneMatch = document.body.textContent?.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
      phone = phoneMatch ? phoneMatch[0] : undefined;
    }

    // Office address
    const officeEl = document.querySelector(".c-senator--district-office, .field--name-field-address, .adr");
    const office = officeEl?.textContent?.trim().replace(/\s+/g, " ") ?? undefined;

    // Website — current page URL
    const website = window.location.href;

    // Committees
    const committeeEls = document.querySelectorAll(
      ".c-senator--committees a, .pane-node-field-committees a, [class*='committee'] a"
    );
    const committees = Array.from(committeeEls).map((el) => el.textContent?.trim() ?? "").filter(Boolean);

    // Social media
    const twitterLink = document.querySelector<HTMLAnchorElement>("a[href*='twitter.com'], a[href*='x.com']");
    const facebookLink = document.querySelector<HTMLAnchorElement>("a[href*='facebook.com']");
    const instagramLink = document.querySelector<HTMLAnchorElement>("a[href*='instagram.com']");

    return {
      name,
      district,
      party,
      photoUrl,
      email,
      phone,
      office,
      website,
      committees,
      twitter: twitterLink?.href ?? undefined,
      facebook: facebookLink?.href ?? undefined,
      instagram: instagramLink?.href ?? undefined,
    };
  }, fallbackName);

  if (!data.name) return null;

  const district = data.district ?? "unknown";
  const rep: Rep = {
    id: `state-senate-${district}`,
    level: "state_senate",
    district,
    name: data.name,
    party: data.party,
    profile: {
      photoUrl: data.photoUrl,
      email: data.email,
      phone: data.phone,
      office: data.office,
      website: data.website,
      committees: data.committees.length > 0 ? data.committees : undefined,
      socialMedia: {
        twitter: data.twitter,
        facebook: data.facebook,
        instagram: data.instagram,
      },
    },
    scrapedAt: Date.now(),
  };

  return rep;
}

/**
 * Search senate bills by query string.
 */
export async function searchSenateBills(query: string): Promise<{ bills: Bill[]; errors: string[] }> {
  const bills: Bill[] = [];
  const errors: string[] = [];
  let browser: Browser | null = null;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    const searchUrl = `${BASE_URL}/search/legislation?search=${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { waitUntil: "domcontentloaded" });

    // Wait for results to appear
    try {
      await page.waitForSelector(
        ".c-bill--title, .c-bill-listing, .view-legislation .views-row, .nys-bill-search-result",
        { timeout: TIMEOUT }
      );
    } catch {
      // If no results selector found, try the main legislation page with search
      await page.goto(`${BASE_URL}/legislation`, { waitUntil: "domcontentloaded" });

      // Try to fill in a search form if available
      const searchInput = await page.$("input[name='search'], input[type='search'], #edit-search");
      if (searchInput) {
        await searchInput.fill(query);
        await page.keyboard.press("Enter");
        try {
          await page.waitForSelector(".c-bill--title, .view-legislation .views-row", { timeout: TIMEOUT });
        } catch {
          errors.push("No legislation results found for query");
          return { bills, errors };
        }
      } else {
        errors.push("Could not locate legislation search interface");
        return { bills, errors };
      }
    }

    const billData = await page.$$eval(
      ".c-bill--title a, .c-bill-listing a, .view-legislation .views-row a, .nys-bill-search-result a",
      (anchors) =>
        anchors.map((a) => ({
          href: (a as HTMLAnchorElement).href,
          text: a.textContent?.trim() ?? "",
        }))
    );

    // Deduplicate
    const seen = new Set<string>();
    for (const item of billData) {
      if (seen.has(item.href)) continue;
      seen.add(item.href);

      try {
        const bill = parseBillFromListing(item.href, item.text);
        if (bill) bills.push(bill);
      } catch (err) {
        errors.push(`Failed to parse bill from listing: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // If we got links but no parsed bills, try visiting detail pages
    if (bills.length === 0 && billData.length > 0) {
      for (const item of billData.slice(0, 10)) {
        try {
          const detailPage = await browser.newPage();
          await detailPage.goto(item.href, { waitUntil: "domcontentloaded" });
          const bill = await scrapeBillDetailPage(detailPage);
          if (bill) bills.push(bill);
          await detailPage.close();
        } catch (err) {
          errors.push(`Failed to scrape bill at ${item.href}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } catch (err) {
    errors.push(`Failed to search legislation: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (browser) await browser.close();
  }

  return { bills, errors };
}

/**
 * Parse a bill from listing text and URL.
 */
function parseBillFromListing(href: string, text: string): Bill | null {
  // Try to extract bill ID from the URL or text (e.g., S1234-2025)
  const billIdMatch = text.match(/([SA]\d+[A-Z]?-\d{4})/i) ?? href.match(/\/legislation\/bills\/(\d{4})\/([SA]\d+[A-Z]?)/i);

  let id: string;
  if (billIdMatch) {
    // From text: "S1234-2025"
    id = billIdMatch[1] ?? `${billIdMatch[2]}-${billIdMatch[1]}`;
  } else {
    // Fallback: extract from URL path
    const urlParts = href.match(/\/bills?\/(\d{4})\/([SA]\d+)/i);
    if (urlParts) {
      id = `${urlParts[2].toUpperCase()}-${urlParts[1]}`;
    } else {
      return null;
    }
  }

  return {
    id,
    level: "state",
    title: text,
    summary: null,
    status: null,
    sponsors: [],
    scrapedAt: Date.now(),
  };
}

/**
 * Scrape bill details from a bill detail page.
 */
async function scrapeBillDetailPage(page: Page): Promise<Bill | null> {
  const data = await page.evaluate(() => {
    const titleEl = document.querySelector(
      ".c-bill--title, h2.nys-title, h1"
    );
    const title = titleEl?.textContent?.trim() ?? "";

    // Bill ID from the page
    const billIdEl = document.querySelector(
      ".c-bill--name, .c-bill--number, .nys-bill-number"
    );
    let billId = billIdEl?.textContent?.trim() ?? "";
    if (!billId) {
      const match = document.body.textContent?.match(/([SA]\d+[A-Z]?-\d{4})/i);
      billId = match ? match[1] : "";
    }
    if (!billId) {
      // Try extracting from URL
      const urlMatch = window.location.pathname.match(/\/bills?\/(\d{4})\/([SA]\d+)/i);
      if (urlMatch) billId = `${urlMatch[2].toUpperCase()}-${urlMatch[1]}`;
    }

    // Summary
    const summaryEl = document.querySelector(
      ".c-bill--summary, .field--name-field-ol-summary, .c-bill-body"
    );
    const summary = summaryEl?.textContent?.trim() ?? null;

    // Status
    const statusEl = document.querySelector(
      ".c-bill--status, .c-bill-status, .field--name-field-ol-last-status"
    );
    const status = statusEl?.textContent?.trim() ?? null;

    // Sponsors
    const sponsorEls = document.querySelectorAll(
      ".c-bill--sponsor a, .c-bill-sponsors a, .field--name-field-ol-sponsor a"
    );
    const sponsors = Array.from(sponsorEls)
      .map((el) => el.textContent?.trim() ?? "")
      .filter(Boolean);

    return { billId, title, summary, status, sponsors };
  });

  if (!data.billId && !data.title) return null;

  return {
    id: data.billId || `unknown-${Date.now()}`,
    level: "state",
    title: data.title,
    summary: data.summary,
    status: data.status,
    sponsors: data.sponsors,
    scrapedAt: Date.now(),
  };
}

/**
 * Scrape vote records for a specific senate bill.
 */
export async function scrapeSenateBillVotes(billId: string): Promise<{ votes: Vote[]; errors: string[] }> {
  const votes: Vote[] = [];
  const errors: string[] = [];
  let browser: Browser | null = null;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    // Parse bill ID — expect format like S1234-2025
    const match = billId.match(/^([SA])(\d+[A-Z]?)-(\d{4})$/i);
    if (!match) {
      errors.push(`Invalid bill ID format: ${billId}. Expected format: S1234-2025`);
      return { votes, errors };
    }

    const billPath = `${BASE_URL}/legislation/bills/${match[3]}/${match[1].toUpperCase()}${match[2]}`;
    await page.goto(billPath, { waitUntil: "domcontentloaded" });

    // Look for a votes tab or section
    const votesLink = await page.$("a[href*='vote'], a:has-text('Votes'), a:has-text('Floor Vote')");
    if (votesLink) {
      await votesLink.click();
      await page.waitForTimeout(2000);
    }

    // Try to find vote records on the page
    try {
      await page.waitForSelector(
        ".c-bill--vote, .c-bill-votes, .nys-bill-vote, table[class*='vote']",
        { timeout: TIMEOUT }
      );
    } catch {
      // Votes section might be directly on the bill page
    }

    const voteData = await page.evaluate((bId: string) => {
      const results: Array<{
        senatorName: string;
        vote: string;
        date: string;
      }> = [];

      // Look for vote tables
      const tables = document.querySelectorAll("table");
      for (const table of tables) {
        const headerText = table.textContent?.toLowerCase() ?? "";
        if (!headerText.includes("aye") && !headerText.includes("nay") && !headerText.includes("vote")) {
          continue;
        }

        const rows = table.querySelectorAll("tr");
        for (const row of rows) {
          const cells = row.querySelectorAll("td");
          if (cells.length >= 2) {
            const name = cells[0]?.textContent?.trim() ?? "";
            const voteText = cells[1]?.textContent?.trim().toLowerCase() ?? "";
            if (name && voteText) {
              results.push({
                senatorName: name,
                vote: voteText,
                date: "",
              });
            }
          }
        }
      }

      // Also look for vote listings that aren't in tables
      const voteBlocks = document.querySelectorAll(
        ".c-bill--vote-item, .c-bill-vote-detail, [class*='vote-record']"
      );
      for (const block of voteBlocks) {
        const name = block.querySelector(".name, .senator-name")?.textContent?.trim() ?? "";
        const voteText = block.querySelector(".vote, .vote-value")?.textContent?.trim().toLowerCase() ?? "";
        if (name && voteText) {
          results.push({ senatorName: name, vote: voteText, date: "" });
        }
      }

      // Try to find the vote date
      const dateEl = document.querySelector(
        ".c-bill--vote-date, .vote-date, .field--name-field-ol-vote-date"
      );
      const dateText = dateEl?.textContent?.trim() ?? "";
      if (dateText) {
        for (const r of results) {
          r.date = dateText;
        }
      }

      return results;
    }, billId);

    for (const v of voteData) {
      const voteValue = normalizeVote(v.vote);
      votes.push({
        id: `${billId}-${v.senatorName.replace(/\s+/g, "-").toLowerCase()}`,
        billId,
        repId: `state-senate-unknown`, // District unknown from vote table
        vote: voteValue,
        date: v.date || new Date().toISOString().slice(0, 10),
        scrapedAt: Date.now(),
      });
    }
  } catch (err) {
    errors.push(`Failed to scrape votes for bill ${billId}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (browser) await browser.close();
  }

  return { votes, errors };
}

/**
 * Scrape votes cast by a specific senator (by district).
 */
export async function scrapeSenatorVotes(district: number): Promise<{ votes: Vote[]; errors: string[] }> {
  const votes: Vote[] = [];
  const errors: string[] = [];
  let browser: Browser | null = null;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    // First find the senator's page
    await page.goto(`${BASE_URL}/senators`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("a[href*='/senators/']", { timeout: TIMEOUT });

    const senatorUrl = await page.evaluate((dist: number) => {
      const allElements = Array.from(document.querySelectorAll("*"));
      for (const el of allElements) {
        const text = el.textContent ?? "";
        const distPattern = new RegExp(`district\\s*${dist}\\b`, "i");
        if (distPattern.test(text)) {
          const anchor = el.querySelector("a[href*='/senators/']") ?? el.closest("a[href*='/senators/']");
          if (anchor) return (anchor as HTMLAnchorElement).href;
        }
      }
      return null;
    }, district);

    if (!senatorUrl) {
      errors.push(`Could not find senator for district ${district}`);
      return { votes, errors };
    }

    // Navigate to the senator's page and look for a votes/legislation tab
    await page.goto(senatorUrl, { waitUntil: "domcontentloaded" });

    // Look for a link to the senator's voting record or legislation page
    const votesPageLink = await page.$eval(
      "a[href*='vote'], a[href*='legislation']",
      (a) => (a as HTMLAnchorElement).href
    ).catch(() => null);

    if (votesPageLink) {
      await page.goto(votesPageLink, { waitUntil: "domcontentloaded" });
    }

    // Scrape vote listings from the senator's page
    const voteData = await page.evaluate(() => {
      const results: Array<{
        billId: string;
        billTitle: string;
        vote: string;
        date: string;
      }> = [];

      // Look for vote records in tables
      const rows = document.querySelectorAll("table tr, .c-bill--vote-item, [class*='vote-record']");
      for (const row of rows) {
        const billLink = row.querySelector("a[href*='/bills/']");
        const billText = billLink?.textContent?.trim() ?? "";
        const voteEl = row.querySelector(".vote, .vote-value, td:nth-child(2)");
        const voteText = voteEl?.textContent?.trim().toLowerCase() ?? "";
        const dateEl = row.querySelector(".date, td:last-child");
        const dateText = dateEl?.textContent?.trim() ?? "";

        if (billText && voteText) {
          // Extract bill ID
          const href = (billLink as HTMLAnchorElement | null)?.href ?? "";
          const urlMatch = href.match(/\/bills?\/(\d{4})\/([SA]\d+)/i);
          const billId = urlMatch ? `${urlMatch[2].toUpperCase()}-${urlMatch[1]}` : billText;

          results.push({
            billId,
            billTitle: billText,
            vote: voteText,
            date: dateText,
          });
        }
      }

      return results;
    });

    const repId = `state-senate-${district}`;
    for (const v of voteData) {
      const voteValue = normalizeVote(v.vote);
      votes.push({
        id: `${repId}-${v.billId}`,
        billId: v.billId,
        repId,
        vote: voteValue,
        date: v.date || new Date().toISOString().slice(0, 10),
        scrapedAt: Date.now(),
      });
    }

    if (votes.length === 0) {
      errors.push(`No vote records found for senator in district ${district}`);
    }
  } catch (err) {
    errors.push(`Failed to scrape votes for district ${district}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (browser) await browser.close();
  }

  return { votes, errors };
}

/**
 * Normalize raw vote text to one of the standard vote values.
 */
function normalizeVote(raw: string): Vote["vote"] {
  const lower = raw.toLowerCase().trim();
  if (lower === "aye" || lower === "yea" || lower === "yes" || lower === "y") return "yes";
  if (lower === "nay" || lower === "no" || lower === "n") return "no";
  if (lower.includes("abstain") || lower === "excused") return "abstain";
  if (lower.includes("absent")) return "absent";
  return "not_voting";
}
