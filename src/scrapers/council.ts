/**
 * Playwright-based scraper for NYC City Council data.
 *
 * Sources:
 *   - Council members: https://council.nyc.gov/districts/
 *   - Legislation/bills: https://legistar.council.nyc.gov/Legislation.aspx
 *   - Votes: individual Legistar legislation pages
 *   - Committee assignments: member detail pages
 */

import { chromium, type Browser, type Page } from "playwright";
import type { Rep, Bill, Vote } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DISTRICTS_URL = "https://council.nyc.gov/districts/";
const MEMBER_DETAIL_URL = (n: number) => `https://council.nyc.gov/district-${n}/`;
const LEGISTAR_LEGISLATION_URL = "https://legistar.council.nyc.gov/Legislation.aspx";
const LEGISTAR_BASE = "https://legistar.council.nyc.gov";

const SELECTOR_TIMEOUT = 15_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

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

// ---------------------------------------------------------------------------
// scrapeCouncilMembers
// ---------------------------------------------------------------------------

/**
 * Scrape all 51 NYC City Council members from council.nyc.gov.
 *
 * Strategy:
 *   1. Visit the districts index page to discover which districts exist.
 *   2. For each district 1-51 visit the detail page to collect name, party,
 *      photo, contact info, and committee assignments.
 */
export async function scrapeCouncilMembers(): Promise<{ reps: Rep[]; errors: string[] }> {
  const reps: Rep[] = [];
  const errors: string[] = [];
  let browser: Browser | undefined;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    for (let district = 1; district <= 51; district++) {
      try {
        const rep = await scrapeMemberDetailPage(page, district);
        reps.push(rep);
      } catch (err) {
        errors.push(`District ${district}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    errors.push(`Browser launch failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await browser?.close();
  }

  return { reps, errors };
}

async function scrapeMemberDetailPage(page: Page, district: number): Promise<Rep> {
  const url = MEMBER_DETAIL_URL(district);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: SELECTOR_TIMEOUT });

  // The detail page has the member name in an h1 or a large heading element.
  // council.nyc.gov uses various heading structures; try the most common ones.
  let name = "";
  try {
    await page.waitForSelector("h1, h2.member-name, .member-head h2", { timeout: SELECTOR_TIMEOUT });
    name = await page.$eval(
      "h1, h2.member-name, .member-head h2",
      (el) => el.textContent?.trim() ?? ""
    );
  } catch {
    // Fallback: grab the page title
    const title = await page.title();
    name = title.replace(/\s*[-–|].*$/, "").trim();
  }

  // Party — often listed near the name or in a metadata section
  let party: string | null = null;
  try {
    const partyText = await page.$eval(
      ".member-info-party, .member-head .party, .council-member-party",
      (el) => el.textContent?.trim() ?? ""
    );
    if (partyText) party = partyText;
  } catch {
    // Party may appear in the broader text
    try {
      const bodyText = await page.evaluate(() => document.body.innerText);
      const partyMatch = bodyText.match(/\b(Democrat|Republican|Independent|Working Families)\b/i);
      if (partyMatch) party = partyMatch[1];
    } catch {
      // ignore
    }
  }

  // Photo URL
  let photoUrl: string | undefined;
  try {
    photoUrl = await page.$eval(
      ".member-head img, .entry-content img, .member-photo img, .wp-post-image",
      (el) => (el as HTMLImageElement).src
    );
  } catch {
    // no photo found
  }

  // Email
  let email: string | undefined;
  try {
    email = await page.$eval(
      'a[href^="mailto:"]',
      (el) => (el as HTMLAnchorElement).href.replace("mailto:", "")
    );
  } catch {
    // no email found
  }

  // Phone
  let phone: string | undefined;
  try {
    phone = await page.$eval(
      'a[href^="tel:"]',
      (el) => el.textContent?.trim() ?? (el as HTMLAnchorElement).href.replace("tel:", "")
    );
  } catch {
    // no phone found
  }

  // Office address — usually in a .member-info or .district-office block
  let office: string | undefined;
  try {
    office = await page.$eval(
      ".district-office, .member-office, .office-address",
      (el) => el.textContent?.trim() ?? ""
    );
  } catch {
    // ignore
  }

  // Social media links
  const socialMedia: { twitter?: string; facebook?: string; instagram?: string } = {};
  try {
    const links = await page.$$eval("a[href]", (els) =>
      els.map((el) => (el as HTMLAnchorElement).href)
    );
    for (const link of links) {
      if (link.includes("twitter.com") || link.includes("x.com")) {
        socialMedia.twitter = link;
      } else if (link.includes("facebook.com")) {
        socialMedia.facebook = link;
      } else if (link.includes("instagram.com")) {
        socialMedia.instagram = link;
      }
    }
  } catch {
    // ignore
  }

  // Committee assignments
  const committees: string[] = [];
  try {
    const committeeSections = await page.$$eval(
      ".committee-list li, .committees li, .member-committees li, .member-info-committee a",
      (els) => els.map((el) => el.textContent?.trim() ?? "").filter(Boolean)
    );
    committees.push(...committeeSections);
  } catch {
    // Fallback: search for a "Committees" heading and grab the next list
    try {
      const found = await page.evaluate(() => {
        const headings = Array.from(document.querySelectorAll("h2, h3, h4, strong"));
        for (const h of headings) {
          if (/committee/i.test(h.textContent ?? "")) {
            const next = h.nextElementSibling;
            if (next?.tagName === "UL" || next?.tagName === "OL") {
              return Array.from(next.querySelectorAll("li")).map(
                (li) => li.textContent?.trim() ?? ""
              );
            }
          }
        }
        return [];
      });
      committees.push(...found.filter(Boolean));
    } catch {
      // ignore
    }
  }

  return {
    id: repId(district),
    level: "city",
    district: String(district),
    name,
    party,
    profile: {
      title: "Council Member",
      photoUrl,
      email,
      phone,
      office,
      website: url,
      socialMedia: Object.keys(socialMedia).length > 0 ? socialMedia : undefined,
      committees: committees.length > 0 ? committees : undefined,
    },
    scrapedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// scrapeCouncilLegislation
// ---------------------------------------------------------------------------

/**
 * Scrape recent legislation from the Legistar-powered NYC Council site.
 *
 * The Legistar web interface uses ASP.NET web forms with postback-driven
 * pagination and date filtering. We fill in the date range and read rows
 * from the results table.
 */
export async function scrapeCouncilLegislation(days: number = 90): Promise<{ bills: Bill[]; errors: string[] }> {
  const bills: Bill[] = [];
  const errors: string[] = [];
  let browser: Browser | undefined;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.goto(LEGISTAR_LEGISLATION_URL, { waitUntil: "networkidle", timeout: 30_000 });

    // Calculate date range
    const now = new Date();
    const fromDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const fromStr = `${fromDate.getMonth() + 1}/${fromDate.getDate()}/${fromDate.getFullYear()}`;
    const toStr = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;

    // Legistar has "Introduction Date" range fields
    // Try to set date range filters
    try {
      // The Legistar page typically has dropdowns/date inputs for filtering
      // Look for the "Advanced search" or date fields
      const advancedLink = await page.$('a:has-text("Advanced"), #ctl00_ContentPlaceHolder1_btnSwitch');
      if (advancedLink) {
        await advancedLink.click();
        await page.waitForTimeout(1000);
      }

      // Try to fill from-date input
      const fromInput = await page.$(
        '#ctl00_ContentPlaceHolder1_txtFileCreated1_dateInput, ' +
        'input[id*="txtFileCreated1"], ' +
        'input[id*="radFileCreated1"]'
      );
      if (fromInput) {
        await fromInput.fill(fromStr);
      }

      // Try to fill to-date input
      const toInput = await page.$(
        '#ctl00_ContentPlaceHolder1_txtFileCreated2_dateInput, ' +
        'input[id*="txtFileCreated2"], ' +
        'input[id*="radFileCreated2"]'
      );
      if (toInput) {
        await toInput.fill(toStr);
      }

      // Click search button
      const searchBtn = await page.$(
        '#ctl00_ContentPlaceHolder1_btnSearch, ' +
        'input[id*="btnSearch"], ' +
        'input[value="Search Legislation"]'
      );
      if (searchBtn) {
        await searchBtn.click();
        await page.waitForLoadState("networkidle", { timeout: 30_000 });
      }
    } catch (filterErr) {
      errors.push(`Date filter failed, scraping default view: ${filterErr instanceof Error ? filterErr.message : String(filterErr)}`);
    }

    // Scrape the results table, page by page
    let hasNextPage = true;
    let pageNum = 1;
    const maxPages = 10; // Safety limit

    while (hasNextPage && pageNum <= maxPages) {
      try {
        await page.waitForSelector(
          '#ctl00_ContentPlaceHolder1_gridMain, table.rgMasterTable, table[id*="gridMain"]',
          { timeout: SELECTOR_TIMEOUT }
        );

        const rows = await page.$$eval(
          '#ctl00_ContentPlaceHolder1_gridMain tr.rgRow, ' +
          '#ctl00_ContentPlaceHolder1_gridMain tr.rgAltRow, ' +
          'table.rgMasterTable tr.rgRow, ' +
          'table.rgMasterTable tr.rgAltRow',
          (trs) => {
            return trs.map((tr) => {
              const cells = Array.from(tr.querySelectorAll("td"));
              const getText = (i: number) => cells[i]?.textContent?.trim() ?? "";
              const getLink = (i: number) => {
                const a = cells[i]?.querySelector("a");
                return a ? (a as HTMLAnchorElement).href : "";
              };
              // Legistar table columns (typical order):
              // File #, Name (title), Type, Status, File Created, Final Action Date
              return {
                fileNumber: getText(0),
                title: getText(1),
                type: getText(2),
                status: getText(3),
                introduced: getText(4),
                link: getLink(0) || getLink(1),
              };
            });
          }
        );

        for (const row of rows) {
          if (!row.fileNumber) continue;

          const bill: Bill = {
            id: row.fileNumber,
            level: "city",
            title: row.title || row.fileNumber,
            summary: null,
            status: row.status || null,
            sponsors: [],
            scrapedAt: Date.now(),
          };

          bills.push(bill);
        }

        // Try to advance to the next page
        hasNextPage = false;
        try {
          const nextPageLink = await page.$(
            'a.rgPageNext:not(.rgDisabled), ' +
            'input[title="Next Page"]:not([disabled]), ' +
            'a[title="Next Page"]'
          );
          if (nextPageLink) {
            await nextPageLink.click();
            await page.waitForLoadState("networkidle", { timeout: 15_000 });
            hasNextPage = true;
            pageNum++;
          }
        } catch {
          // no more pages
        }
      } catch (tableErr) {
        errors.push(`Page ${pageNum} table parse failed: ${tableErr instanceof Error ? tableErr.message : String(tableErr)}`);
        hasNextPage = false;
      }
    }

    // Attempt to collect sponsors for each bill by visiting its detail page
    // (only for the first batch to avoid hammering the server)
    const sponsorLimit = Math.min(bills.length, 20);
    for (let i = 0; i < sponsorLimit; i++) {
      try {
        await enrichBillSponsors(page, bills[i]);
      } catch (err) {
        errors.push(`Sponsor fetch for ${bills[i].id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    errors.push(`Legislation scrape failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await browser?.close();
  }

  return { bills, errors };
}

/**
 * Visit a Legistar legislation detail page to collect sponsor information.
 */
async function enrichBillSponsors(page: Page, bill: Bill): Promise<void> {
  // Search for the bill on Legistar
  const searchUrl = `${LEGISTAR_BASE}/LegislationDetail.aspx?ID=0&GUID=0&Search=${encodeURIComponent(bill.id)}`;

  // Try a direct search — Legistar supports text search in the file number
  await page.goto(
    `${LEGISTAR_BASE}/Legislation.aspx`,
    { waitUntil: "networkidle", timeout: 15_000 }
  );

  // Type the bill ID into search
  try {
    const searchInput = await page.$(
      '#ctl00_ContentPlaceHolder1_txtSearch, ' +
      'input[id*="txtSearch"]'
    );
    if (searchInput) {
      await searchInput.fill(bill.id);
      const searchBtn = await page.$(
        '#ctl00_ContentPlaceHolder1_btnSearch, input[id*="btnSearch"]'
      );
      if (searchBtn) {
        await searchBtn.click();
        await page.waitForLoadState("networkidle", { timeout: 15_000 });
      }
    }

    // Click the first result link
    const firstLink = await page.$(
      '#ctl00_ContentPlaceHolder1_gridMain tr.rgRow td:first-child a, ' +
      'table.rgMasterTable tr.rgRow td:first-child a'
    );
    if (firstLink) {
      await firstLink.click();
      await page.waitForLoadState("networkidle", { timeout: 15_000 });

      // On the detail page, look for sponsors
      const sponsors = await page.$$eval(
        '#ctl00_ContentPlaceHolder1_lblSponsors a, ' +
        'span[id*="lblSponsors"] a, ' +
        '#ctl00_ContentPlaceHolder1_hypPrimeSponsor',
        (els) => els.map((el) => el.textContent?.trim() ?? "").filter(Boolean)
      );
      if (sponsors.length > 0) {
        bill.sponsors = sponsors;
      }

      // Also grab summary if available
      const summary = await page
        .$eval(
          '#ctl00_ContentPlaceHolder1_lblTitle2, span[id*="lblTitle2"]',
          (el) => el.textContent?.trim() ?? ""
        )
        .catch(() => "");
      if (summary) {
        bill.summary = summary;
      }
    }
  } catch {
    // Non-fatal — bill already has basic info
  }
}

// ---------------------------------------------------------------------------
// scrapeCouncilVotes
// ---------------------------------------------------------------------------

/**
 * Scrape roll call votes for a specific bill from its Legistar page.
 *
 * @param billId – The intro / file number (e.g. "Int 0247-2024")
 */
export async function scrapeCouncilVotes(billId: string): Promise<{ votes: Vote[]; errors: string[] }> {
  const votes: Vote[] = [];
  const errors: string[] = [];
  let browser: Browser | undefined;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    // Navigate to legislation search and find the bill
    await page.goto(LEGISTAR_LEGISLATION_URL, { waitUntil: "networkidle", timeout: 30_000 });

    // Search for the bill
    try {
      const searchInput = await page.$(
        '#ctl00_ContentPlaceHolder1_txtSearch, input[id*="txtSearch"]'
      );
      if (searchInput) {
        await searchInput.fill(billId);
        const searchBtn = await page.$(
          '#ctl00_ContentPlaceHolder1_btnSearch, input[id*="btnSearch"]'
        );
        if (searchBtn) {
          await searchBtn.click();
          await page.waitForLoadState("networkidle", { timeout: 15_000 });
        }
      }
    } catch (searchErr) {
      errors.push(`Search failed: ${searchErr instanceof Error ? searchErr.message : String(searchErr)}`);
      return { votes, errors };
    }

    // Click through to the legislation detail page
    try {
      const resultLink = await page.$(
        '#ctl00_ContentPlaceHolder1_gridMain tr.rgRow td:first-child a, ' +
        'table.rgMasterTable tr.rgRow td:first-child a'
      );
      if (!resultLink) {
        errors.push(`No results found for bill ${billId}`);
        return { votes, errors };
      }
      await resultLink.click();
      await page.waitForLoadState("networkidle", { timeout: 15_000 });
    } catch (navErr) {
      errors.push(`Navigation to bill detail failed: ${navErr instanceof Error ? navErr.message : String(navErr)}`);
      return { votes, errors };
    }

    // The detail page has a "History" / "Actions" section with vote links.
    // Each row with a vote result links to a roll call page.
    const voteLinks = await page.$$eval(
      'table[id*="gridLegislation"] a[href*="VoteDetail"], ' +
      'a[href*="VoteDetail.aspx"], ' +
      '#ctl00_ContentPlaceHolder1_gridLegislation a[onclick*="Vote"]',
      (els) => els.map((el) => ({
        href: (el as HTMLAnchorElement).href,
        text: el.textContent?.trim() ?? "",
      }))
    );

    if (voteLinks.length === 0) {
      // Try alternative: look for rows in the history table that mention "Pass" or "vote"
      const historyRows = await page.$$eval(
        'table[id*="gridLegislation"] tr, #ctl00_ContentPlaceHolder1_gridLegislation tr',
        (trs) => {
          return trs.map((tr) => {
            const cells = Array.from(tr.querySelectorAll("td"));
            return {
              date: cells[0]?.textContent?.trim() ?? "",
              action: cells[2]?.textContent?.trim() ?? "",
              result: cells[3]?.textContent?.trim() ?? "",
              link: (cells[3]?.querySelector("a") as HTMLAnchorElement | null)?.href ?? "",
            };
          }).filter((r) => r.link || /pass|vote/i.test(r.result));
        }
      );

      for (const row of historyRows) {
        if (row.link) {
          try {
            const rowVotes = await scrapeVoteDetailPage(page, row.link, billId, row.date);
            votes.push(...rowVotes);
          } catch (err) {
            errors.push(`Vote detail page error: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } else {
      // Visit each vote detail link
      for (const vl of voteLinks) {
        if (vl.href) {
          try {
            const vlVotes = await scrapeVoteDetailPage(page, vl.href, billId, "");
            votes.push(...vlVotes);
          } catch (err) {
            errors.push(`Vote detail page error: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }
  } catch (err) {
    errors.push(`Vote scrape failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await browser?.close();
  }

  return { votes, errors };
}

/**
 * Scrape a single Legistar VoteDetail page for roll call data.
 */
async function scrapeVoteDetailPage(
  page: Page,
  url: string,
  billId: string,
  fallbackDate: string
): Promise<Vote[]> {
  await page.goto(url, { waitUntil: "networkidle", timeout: 15_000 });
  const votes: Vote[] = [];

  // Get the vote date from the page, or use fallback
  let date = fallbackDate;
  try {
    const dateText = await page.$eval(
      '#ctl00_ContentPlaceHolder1_lblDate, span[id*="lblDate"]',
      (el) => el.textContent?.trim() ?? ""
    );
    if (dateText) date = toISODate(dateText);
  } catch {
    if (date) date = toISODate(date);
  }

  // Parse the roll call table
  const rows = await page.$$eval(
    '#ctl00_ContentPlaceHolder1_gridVote tr.rgRow, ' +
    '#ctl00_ContentPlaceHolder1_gridVote tr.rgAltRow, ' +
    'table[id*="gridVote"] tr.rgRow, ' +
    'table[id*="gridVote"] tr.rgAltRow',
    (trs) => {
      return trs.map((tr) => {
        const cells = Array.from(tr.querySelectorAll("td"));
        return {
          person: cells[0]?.textContent?.trim() ?? "",
          voteValue: cells[1]?.textContent?.trim() ?? "",
        };
      });
    }
  );

  for (const row of rows) {
    if (!row.person) continue;

    // We need to map the person name to a repId. Since Legistar uses names
    // not district numbers, we store the name-based info and the caller can
    // cross-reference with the reps table. We use a sanitized name as a
    // temporary repId placeholder — the consumer should match against council
    // members by name.
    const sanitizedName = row.person.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const rId = `city-council-name-${sanitizedName}`;

    votes.push({
      id: voteId(billId, rId, date),
      billId,
      repId: rId,
      vote: normalizeVote(row.voteValue),
      date,
      scrapedAt: Date.now(),
    });
  }

  return votes;
}

// ---------------------------------------------------------------------------
// scrapeCouncilMemberVotes
// ---------------------------------------------------------------------------

/**
 * Scrape recent votes for a specific council member by district number.
 *
 * Strategy: visit the member's page on the Council website which may link to
 * their Legistar profile, then scrape their vote history. If no direct
 * Legistar profile link exists, search Legistar by the member name.
 */
export async function scrapeCouncilMemberVotes(district: number): Promise<{ votes: Vote[]; errors: string[] }> {
  const votes: Vote[] = [];
  const errors: string[] = [];
  let browser: Browser | undefined;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    // First, get the member's name from their council page
    const memberUrl = MEMBER_DETAIL_URL(district);
    await page.goto(memberUrl, { waitUntil: "domcontentloaded", timeout: SELECTOR_TIMEOUT });

    let memberName = "";
    try {
      await page.waitForSelector("h1, h2.member-name, .member-head h2", { timeout: SELECTOR_TIMEOUT });
      memberName = await page.$eval(
        "h1, h2.member-name, .member-head h2",
        (el) => el.textContent?.trim() ?? ""
      );
    } catch {
      const title = await page.title();
      memberName = title.replace(/\s*[-–|].*$/, "").trim();
    }

    if (!memberName) {
      errors.push(`Could not determine member name for district ${district}`);
      return { votes, errors };
    }

    // Search Legistar for this person's voting history
    // Legistar has a "Person" page: PersonDetail.aspx
    // We can search for them via the main search
    const personSearchUrl = `${LEGISTAR_BASE}/People.aspx`;

    try {
      await page.goto(personSearchUrl, { waitUntil: "networkidle", timeout: 30_000 });

      // The People page lists all council members. Find the one matching our district member.
      const personLink = await page.$$eval(
        'table[id*="gridPeople"] a, table.rgMasterTable a',
        (els, name) => {
          // Find the closest match by checking if the link text contains the last name
          const nameParts = name.split(/\s+/);
          const lastName = nameParts[nameParts.length - 1]?.toLowerCase() ?? "";
          for (const el of els) {
            const text = el.textContent?.trim().toLowerCase() ?? "";
            if (text && lastName && text.includes(lastName)) {
              return (el as HTMLAnchorElement).href;
            }
          }
          return null;
        },
        memberName
      );

      if (!personLink) {
        errors.push(`Could not find Legistar profile for ${memberName}`);
        return { votes, errors };
      }

      // Visit the person's detail page
      await page.goto(personLink, { waitUntil: "networkidle", timeout: 15_000 });

      // Look for a "Legislation" or "Voting Record" tab/link
      const votingLink = await page.$(
        'a:has-text("Voting Record"), a:has-text("Legislation"), a[href*="PersonDetail"]'
      );
      if (votingLink) {
        await votingLink.click();
        await page.waitForLoadState("networkidle", { timeout: 15_000 });
      }

      // Parse the legislation table on this person's page
      // This table shows bills they sponsored/voted on, with vote column
      const rows = await page.$$eval(
        'table[id*="gridLegislation"] tr.rgRow, ' +
        'table[id*="gridLegislation"] tr.rgAltRow, ' +
        'table.rgMasterTable tr.rgRow, ' +
        'table.rgMasterTable tr.rgAltRow',
        (trs) => {
          return trs.map((tr) => {
            const cells = Array.from(tr.querySelectorAll("td"));
            return {
              fileNumber: cells[0]?.textContent?.trim() ?? "",
              title: cells[1]?.textContent?.trim() ?? "",
              date: cells[2]?.textContent?.trim() ?? "",
              action: cells[3]?.textContent?.trim() ?? "",
              result: cells[4]?.textContent?.trim() ?? "",
              voteValue: cells[5]?.textContent?.trim() ?? "",
            };
          });
        }
      );

      const rId = repId(district);
      for (const row of rows) {
        if (!row.fileNumber || !row.voteValue) continue;
        const date = row.date ? toISODate(row.date) : "";
        votes.push({
          id: voteId(row.fileNumber, rId, date),
          billId: row.fileNumber,
          repId: rId,
          vote: normalizeVote(row.voteValue),
          date,
          scrapedAt: Date.now(),
        });
      }

      // Paginate if there are more results
      let hasNextPage = true;
      let pNum = 1;
      const maxPages = 5;

      while (hasNextPage && pNum < maxPages) {
        hasNextPage = false;
        try {
          const nextLink = await page.$(
            'a.rgPageNext:not(.rgDisabled), input[title="Next Page"]:not([disabled])'
          );
          if (nextLink) {
            await nextLink.click();
            await page.waitForLoadState("networkidle", { timeout: 15_000 });

            const moreRows = await page.$$eval(
              'table[id*="gridLegislation"] tr.rgRow, ' +
              'table[id*="gridLegislation"] tr.rgAltRow, ' +
              'table.rgMasterTable tr.rgRow, ' +
              'table.rgMasterTable tr.rgAltRow',
              (trs) => {
                return trs.map((tr) => {
                  const cells = Array.from(tr.querySelectorAll("td"));
                  return {
                    fileNumber: cells[0]?.textContent?.trim() ?? "",
                    title: cells[1]?.textContent?.trim() ?? "",
                    date: cells[2]?.textContent?.trim() ?? "",
                    action: cells[3]?.textContent?.trim() ?? "",
                    result: cells[4]?.textContent?.trim() ?? "",
                    voteValue: cells[5]?.textContent?.trim() ?? "",
                  };
                });
              }
            );

            for (const row of moreRows) {
              if (!row.fileNumber || !row.voteValue) continue;
              const date = row.date ? toISODate(row.date) : "";
              votes.push({
                id: voteId(row.fileNumber, rId, date),
                billId: row.fileNumber,
                repId: rId,
                vote: normalizeVote(row.voteValue),
                date,
                scrapedAt: Date.now(),
              });
            }

            hasNextPage = true;
            pNum++;
          }
        } catch {
          // no more pages
        }
      }
    } catch (legistarErr) {
      errors.push(`Legistar search for ${memberName}: ${legistarErr instanceof Error ? legistarErr.message : String(legistarErr)}`);
    }
  } catch (err) {
    errors.push(`Member votes scrape failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await browser?.close();
  }

  return { votes, errors };
}
