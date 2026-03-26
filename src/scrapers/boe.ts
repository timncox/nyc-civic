import { chromium, type Browser } from "playwright";

// ---------------------------------------------------------------------------
// Board of Elections — Election District lookup via vote.nyc
// ---------------------------------------------------------------------------

/**
 * Look up a voter's election district, assembly district, and poll site
 * by entering an address into the vote.nyc "Find your poll site" tool.
 *
 * Uses Playwright to drive the search form since vote.nyc relies on
 * client-side JavaScript to render results.
 *
 * Never throws — returns an errors array instead.
 */
export async function lookupElectionDistrict(address: string): Promise<{
  electionDistrict: number | null;
  assemblyDistrict: number | null;
  pollSite: string | null;
  errors: string[];
}> {
  const result: {
    electionDistrict: number | null;
    assemblyDistrict: number | null;
    pollSite: string | null;
    errors: string[];
  } = {
    electionDistrict: null,
    assemblyDistrict: null,
    pollSite: null,
    errors: [],
  };

  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    // Navigate to the poll site finder
    await page.goto("https://findmypollsite.vote.nyc/", {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });

    // Wait for the search input to appear
    const inputSelector = 'input[type="text"], input[type="search"], input[name*="address"], input[placeholder*="address" i], #address-input, .address-input input';
    await page.waitForSelector(inputSelector, { timeout: 15_000 });

    // Find and fill the address input
    const input = await page.$(inputSelector);
    if (!input) {
      result.errors.push("Could not find address input on vote.nyc");
      return result;
    }

    await input.fill(address);

    // Try to submit — look for a search/submit button, or press Enter
    const buttonSelector =
      'button[type="submit"], input[type="submit"], button:has-text("Search"), button:has-text("Find"), button:has-text("Look"), button:has-text("Submit"), .search-btn, #search-button';
    const button = await page.$(buttonSelector);
    if (button) {
      await button.click();
    } else {
      await input.press("Enter");
    }

    // Wait for results to load — look for common result containers
    try {
      await page.waitForSelector(
        '.results, .poll-site, .voter-info, [class*="result"], [class*="district"], table, #results',
        { timeout: 15_000 },
      );
    } catch {
      // Results container might have a different shape — continue and try to parse anyway
      await page.waitForTimeout(5_000);
    }

    // Extract district information from the results page
    const extracted = await page.evaluate(() => {
      const text = document.body.innerText;

      // Look for Election District
      let ed: number | null = null;
      const edPatterns = [
        /Election\s+District\s*[:#]?\s*(\d+)/i,
        /\bED\s*[:#]?\s*(\d+)/i,
        /E\.?D\.?\s*(\d+)/i,
      ];
      for (const pattern of edPatterns) {
        const match = text.match(pattern);
        if (match) {
          ed = parseInt(match[1], 10);
          break;
        }
      }

      // Look for Assembly District
      let ad: number | null = null;
      const adPatterns = [
        /Assembly\s+District\s*[:#]?\s*(\d+)/i,
        /\bAD\s*[:#]?\s*(\d+)/i,
        /A\.?D\.?\s*(\d+)/i,
      ];
      for (const pattern of adPatterns) {
        const match = text.match(pattern);
        if (match) {
          ad = parseInt(match[1], 10);
          break;
        }
      }

      // Look for Poll Site
      let pollSite: string | null = null;
      const pollPatterns = [
        /Poll\s*Site\s*[:#]?\s*(.+?)(?:\n|Election|Assembly|Congressional|Senate|$)/i,
        /Polling?\s*(?:Place|Location)\s*[:#]?\s*(.+?)(?:\n|Election|Assembly|$)/i,
      ];
      for (const pattern of pollPatterns) {
        const match = text.match(pattern);
        if (match) {
          pollSite = match[1].trim();
          break;
        }
      }

      // Fallback: try to find poll site from structured elements
      if (!pollSite) {
        const siteEl = document.querySelector(
          '.poll-site-name, .poll-site-address, [class*="pollsite"], [class*="poll-site"]',
        );
        if (siteEl) {
          pollSite = (siteEl.textContent ?? "").trim() || null;
        }
      }

      return { ed, ad, pollSite };
    });

    result.electionDistrict = extracted.ed;
    result.assemblyDistrict = extracted.ad;
    result.pollSite = extracted.pollSite;

    if (extracted.ed === null && extracted.ad === null) {
      result.errors.push(
        `No district information found for address: "${address}". The address may not be recognized by vote.nyc.`,
      );
    }
  } catch (e) {
    result.errors.push(
      `BOE lookup failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore close errors
      }
    }
  }

  return result;
}
