import { chromium, type Browser, type Page } from "playwright";
import type { Rep, Bill, Vote } from "../types.js";

const BASE_URL = "https://nyassembly.gov";
const TIMEOUT = 15_000;

async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

/**
 * Scrape all NY State Assembly members from the member listing page.
 */
export async function scrapeAssemblyMembers(): Promise<{ reps: Rep[]; errors: string[] }> {
  const reps: Rep[] = [];
  const errors: string[] = [];
  let browser: Browser | null = null;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.goto(`${BASE_URL}/mem/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("a[href*='/mem/']", { timeout: TIMEOUT });

    // The member listing page shows all 150 assembly members.
    const memberLinks = await page.$$eval(
      "a[href*='/mem/']",
      (anchors) => {
        const base = window.location.origin;
        return anchors
          .map((a) => ({
            href: new URL((a as HTMLAnchorElement).href, base).href,
            text: a.textContent?.trim() ?? "",
          }))
          .filter((l) => {
            // Filter out non-member links (navigation, etc.)
            const path = new URL(l.href).pathname;
            return (
              l.text.length > 0 &&
              path.startsWith("/mem/") &&
              path !== "/mem/" &&
              path !== "/mem" &&
              !path.includes("/search") &&
              !path.includes("/email")
            );
          });
      }
    );

    // Deduplicate by pathname
    const seen = new Set<string>();
    const uniqueLinks: { href: string; text: string }[] = [];
    for (const link of memberLinks) {
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

        const rep = await scrapeAssemblyMemberDetail(detailPage, link.text);
        if (rep) {
          reps.push(rep);
        }

        await detailPage.close();
      } catch (err) {
        errors.push(`Failed to scrape member at ${link.href}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    errors.push(`Failed to load assembly member listing: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (browser) await browser.close();
  }

  return { reps, errors };
}

/**
 * Scrape a single NY State Assembly member by district number.
 */
export async function scrapeAssemblyMember(district: number): Promise<{ rep: Rep | null; errors: string[] }> {
  const errors: string[] = [];
  let browser: Browser | null = null;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    // Navigate to member listing and find the member for this district
    await page.goto(`${BASE_URL}/mem/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("a[href*='/mem/']", { timeout: TIMEOUT });

    // Try to find a district selector or filter on the page
    const districtSelect = await page.$(
      "select[name*='district'], select#district, select[name*='dist']"
    );
    if (districtSelect) {
      await districtSelect.selectOption(String(district));
      await page.waitForTimeout(2000);
    }

    // Search for the member by district number in the page content
    const memberUrl = await page.evaluate((dist: number) => {
      const allElements = Array.from(document.querySelectorAll("*"));
      for (const el of allElements) {
        const text = el.textContent ?? "";
        const distPattern = new RegExp(`\\bdistrict\\s*${dist}\\b`, "i");
        if (distPattern.test(text)) {
          const anchor = el.querySelector("a[href*='/mem/']") ?? el.closest("a[href*='/mem/']");
          if (anchor) {
            const href = (anchor as HTMLAnchorElement).href;
            const path = new URL(href).pathname;
            if (path !== "/mem/" && path !== "/mem") return href;
          }
        }
      }

      // Alternate approach: look at all member links and check adjacent text
      const links = Array.from(document.querySelectorAll("a[href*='/mem/']"));
      for (const link of links) {
        const parent = link.closest("tr, li, div, .member-item");
        if (parent) {
          const parentText = parent.textContent ?? "";
          if (new RegExp(`\\b${dist}\\b`).test(parentText)) {
            const path = new URL((link as HTMLAnchorElement).href).pathname;
            if (path !== "/mem/" && path !== "/mem") return (link as HTMLAnchorElement).href;
          }
        }
      }

      return null;
    }, district);

    if (!memberUrl) {
      errors.push(`Could not find assembly member for district ${district}`);
      return { rep: null, errors };
    }

    await page.goto(memberUrl, { waitUntil: "domcontentloaded" });
    const rep = await scrapeAssemblyMemberDetail(page, "");
    if (rep) {
      rep.district = String(district);
      rep.id = `state-assembly-${district}`;
    }
    return { rep, errors };
  } catch (err) {
    errors.push(`Failed to scrape assembly member for district ${district}: ${err instanceof Error ? err.message : String(err)}`);
    return { rep: null, errors };
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Extract assembly member details from a detail page.
 */
async function scrapeAssemblyMemberDetail(page: Page, fallbackName: string): Promise<Rep | null> {
  const data = await page.evaluate((fbName: string) => {
    const name =
      document.querySelector("h1, h2.mem-name, .member-name")?.textContent?.trim() ?? fbName;

    // District number
    const districtMatch = document.body.textContent?.match(/District\s+(\d+)/i)
      ?? document.body.textContent?.match(/(\d+)\s*(?:th|st|nd|rd)?\s+(?:Assembly\s+)?District/i);
    const district = districtMatch ? districtMatch[1] : null;

    // Party affiliation
    let party: string | null = null;
    const partyMatch = document.body.textContent?.match(
      /\b(Democrat|Republican|Independent|Conservative|Working Families)\b/i
    );
    if (partyMatch) {
      party = partyMatch[1];
    } else {
      // Look for party abbreviations in parentheses
      const abbrMatch = document.body.textContent?.match(/\(([DRI])\)/);
      if (abbrMatch) {
        const abbr = abbrMatch[1];
        party = abbr === "D" ? "Democrat" : abbr === "R" ? "Republican" : "Independent";
      }
    }

    // Photo
    const photoEl = document.querySelector<HTMLImageElement>(
      "img[alt*='member'], img[alt*='Member'], img[src*='mem'], .member-photo img, .mem-pic img"
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
    const officeEl = document.querySelector(
      ".mem-address, .office-address, .district-office, address"
    );
    const office = officeEl?.textContent?.trim().replace(/\s+/g, " ") ?? undefined;

    // Website — current page URL
    const website = window.location.href;

    // Committees
    const committeeEls = document.querySelectorAll(
      ".mem-committee a, a[href*='comm'], .committee-list a, .committees a"
    );
    const committees = Array.from(committeeEls)
      .map((el) => el.textContent?.trim() ?? "")
      .filter((t) => t.length > 0 && !t.toLowerCase().includes("committee list"));

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
    id: `state-assembly-${district}`,
    level: "state_assembly",
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
 * Search assembly bills by query string.
 */
export async function searchAssemblyBills(query: string): Promise<{ bills: Bill[]; errors: string[] }> {
  const bills: Bill[] = [];
  const errors: string[] = [];
  let browser: Browser | null = null;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    // The assembly website has a legislation search interface
    await page.goto(`${BASE_URL}/leg/`, { waitUntil: "domcontentloaded" });

    // Try to find and fill the search input
    const searchInput = await page.$(
      "input[name*='search'], input[name*='term'], input[name='Q'], input#search, input[type='search']"
    );

    if (searchInput) {
      await searchInput.fill(query);
      await page.keyboard.press("Enter");

      try {
        await page.waitForSelector(
          "a[href*='/leg/?bn='], a[href*='/Bill/'], .bill-result, table tr a",
          { timeout: TIMEOUT }
        );
      } catch {
        errors.push("No legislation results found for query");
        return { bills, errors };
      }
    } else {
      // Try alternate URL patterns for legislation search
      await page.goto(
        `${BASE_URL}/leg/?default_fld=&leg_video=&bn=${encodeURIComponent(query)}&term=0&Summary=Y&Actions=Y`,
        { waitUntil: "domcontentloaded" }
      );

      try {
        await page.waitForSelector("a[href*='/leg/?bn='], a[href*='/Bill/'], table", { timeout: TIMEOUT });
      } catch {
        errors.push("No legislation results found for query");
        return { bills, errors };
      }
    }

    // Parse bill results
    const billData = await page.evaluate(() => {
      const results: Array<{
        id: string;
        title: string;
        status: string | null;
        sponsors: string[];
        href: string;
      }> = [];

      // Look for bill links in search results
      const links = document.querySelectorAll(
        "a[href*='/leg/?bn='], a[href*='/Bill/'], .bill-result a"
      );

      for (const link of links) {
        const href = (link as HTMLAnchorElement).href;
        const text = link.textContent?.trim() ?? "";
        if (!text) continue;

        // Extract bill ID — e.g., A5678-2025 or A05678
        const billMatch = text.match(/([A]\d+[A-Z]?(?:-\d{4})?)/i)
          ?? href.match(/bn=([A]\d+)/i);
        const id = billMatch ? billMatch[1].toUpperCase() : "";
        if (!id) continue;

        // Get surrounding context for title
        const parent = link.closest("tr, li, div, .bill-result");
        const title = parent?.textContent?.trim().replace(/\s+/g, " ") ?? text;

        results.push({
          id: id.includes("-") ? id : id,
          title,
          status: null,
          sponsors: [],
          href,
        });
      }

      // Also try parsing from table rows
      if (results.length === 0) {
        const rows = document.querySelectorAll("table tr");
        for (const row of rows) {
          const cells = row.querySelectorAll("td");
          if (cells.length >= 2) {
            const firstCellText = cells[0]?.textContent?.trim() ?? "";
            const billMatch = firstCellText.match(/([A]\d+[A-Z]?)/i);
            if (billMatch) {
              results.push({
                id: billMatch[1].toUpperCase(),
                title: cells[1]?.textContent?.trim() ?? firstCellText,
                status: cells.length > 2 ? cells[2]?.textContent?.trim() ?? null : null,
                sponsors: [],
                href: "",
              });
            }
          }
        }
      }

      return results;
    });

    // Deduplicate and build Bill objects
    const seen = new Set<string>();
    for (const b of billData) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);

      // If the bill ID doesn't include a session year, try to determine it
      const id = b.id.includes("-") ? b.id : b.id;

      bills.push({
        id,
        level: "state",
        title: b.title,
        summary: null,
        status: b.status,
        sponsors: b.sponsors,
        scrapedAt: Date.now(),
      });
    }

    // If we got links, try visiting a few to enrich details
    if (bills.length > 0 && billData.some((b) => b.href)) {
      for (let i = 0; i < Math.min(bills.length, 5); i++) {
        const href = billData[i]?.href;
        if (!href) continue;

        try {
          const detailPage = await browser.newPage();
          await detailPage.goto(href, { waitUntil: "domcontentloaded" });

          const details = await detailPage.evaluate(() => {
            const summaryEl = document.querySelector(
              ".bill-summary, .bill-memo, #TextHolder"
            );
            const summary = summaryEl?.textContent?.trim() ?? null;

            const statusEl = document.querySelector(
              ".bill-status, .last-action"
            );
            const status = statusEl?.textContent?.trim() ?? null;

            const sponsorEls = document.querySelectorAll(
              ".bill-sponsor a, a[href*='/mem/']"
            );
            const sponsors = Array.from(sponsorEls)
              .map((el) => el.textContent?.trim() ?? "")
              .filter(Boolean);

            return { summary, status, sponsors };
          });

          if (details.summary) bills[i]!.summary = details.summary;
          if (details.status) bills[i]!.status = details.status;
          if (details.sponsors.length > 0) bills[i]!.sponsors = details.sponsors;

          await detailPage.close();
        } catch (err) {
          errors.push(`Failed to enrich bill ${bills[i]!.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } catch (err) {
    errors.push(`Failed to search assembly legislation: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (browser) await browser.close();
  }

  return { bills, errors };
}

/**
 * Scrape votes cast by a specific assembly member (by district).
 */
export async function scrapeAssemblyMemberVotes(district: number): Promise<{ votes: Vote[]; errors: string[] }> {
  const votes: Vote[] = [];
  const errors: string[] = [];
  let browser: Browser | null = null;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    // Find the assembly member's page first
    await page.goto(`${BASE_URL}/mem/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("a[href*='/mem/']", { timeout: TIMEOUT });

    const memberUrl = await page.evaluate((dist: number) => {
      const allElements = Array.from(document.querySelectorAll("*"));
      for (const el of allElements) {
        const text = el.textContent ?? "";
        const distPattern = new RegExp(`\\bdistrict\\s*${dist}\\b`, "i");
        if (distPattern.test(text)) {
          const anchor = el.querySelector("a[href*='/mem/']") ?? el.closest("a[href*='/mem/']");
          if (anchor) {
            const href = (anchor as HTMLAnchorElement).href;
            const path = new URL(href).pathname;
            if (path !== "/mem/" && path !== "/mem") return href;
          }
        }
      }

      // Alternate: check table rows/list items
      const links = Array.from(document.querySelectorAll("a[href*='/mem/']"));
      for (const link of links) {
        const parent = link.closest("tr, li, div, .member-item");
        if (parent) {
          const parentText = parent.textContent ?? "";
          if (new RegExp(`\\b${dist}\\b`).test(parentText)) {
            const path = new URL((link as HTMLAnchorElement).href).pathname;
            if (path !== "/mem/" && path !== "/mem") return (link as HTMLAnchorElement).href;
          }
        }
      }

      return null;
    }, district);

    if (!memberUrl) {
      errors.push(`Could not find assembly member for district ${district}`);
      return { votes, errors };
    }

    // Navigate to the member's page and look for votes/legislation tab
    await page.goto(memberUrl, { waitUntil: "domcontentloaded" });

    // Try to navigate to a votes section
    const votesLink = await page.$eval(
      "a[href*='vote'], a[href*='legislation'], a:has-text('Votes'), a:has-text('Legislation')",
      (a) => (a as HTMLAnchorElement).href
    ).catch(() => null);

    if (votesLink) {
      await page.goto(votesLink, { waitUntil: "domcontentloaded" });
    }

    // Scrape vote records from the page
    const voteData = await page.evaluate(() => {
      const results: Array<{
        billId: string;
        vote: string;
        date: string;
      }> = [];

      // Look for vote tables
      const rows = document.querySelectorAll("table tr");
      for (const row of rows) {
        const cells = row.querySelectorAll("td");
        if (cells.length < 2) continue;

        const billLink = row.querySelector("a[href*='/leg/'], a[href*='/Bill/']");
        const billText = billLink?.textContent?.trim() ?? cells[0]?.textContent?.trim() ?? "";
        const voteText = cells[1]?.textContent?.trim().toLowerCase() ?? "";
        const dateText = cells.length > 2 ? cells[cells.length - 1]?.textContent?.trim() ?? "" : "";

        // Extract bill ID
        const billMatch = billText.match(/([A]\d+[A-Z]?(?:-\d{4})?)/i);
        if (billMatch && voteText) {
          results.push({
            billId: billMatch[1].toUpperCase(),
            vote: voteText,
            date: dateText,
          });
        }
      }

      // Also check for non-table vote listings
      const voteBlocks = document.querySelectorAll(
        ".vote-record, .vote-item, [class*='vote']"
      );
      for (const block of voteBlocks) {
        const billLink = block.querySelector("a[href*='/leg/'], a[href*='/Bill/']");
        const billText = billLink?.textContent?.trim() ?? "";
        const billMatch = billText.match(/([A]\d+[A-Z]?(?:-\d{4})?)/i);

        const voteEl = block.querySelector(".vote, .vote-value");
        const voteText = voteEl?.textContent?.trim().toLowerCase() ?? "";

        const dateEl = block.querySelector(".date, time");
        const dateText = dateEl?.textContent?.trim() ?? "";

        if (billMatch && voteText) {
          results.push({
            billId: billMatch[1].toUpperCase(),
            vote: voteText,
            date: dateText,
          });
        }
      }

      return results;
    });

    const repId = `state-assembly-${district}`;
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
      errors.push(`No vote records found for assembly member in district ${district}`);
    }
  } catch (err) {
    errors.push(`Failed to scrape votes for assembly district ${district}: ${err instanceof Error ? err.message : String(err)}`);
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
