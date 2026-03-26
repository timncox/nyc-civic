import type { CommunityBoard } from "../types.js";

const BASE_URL = "https://data.cityofnewyork.us/resource";

// ---------------------------------------------------------------------------
// Known SODA dataset identifiers for NYC community boards
// ---------------------------------------------------------------------------

/** Community Board application/appointment dataset */
const CB_MEMBERS_DATASET = "bj99-s4bq";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function sodaFetch(dataset: string, params: Record<string, string> = {}): Promise<any[]> {
  const url = new URL(`${BASE_URL}/${dataset}.json`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`SODA API ${response.status}: ${response.statusText} (${dataset})`);
  }

  return response.json() as Promise<any[]>;
}

/**
 * Parse a district string like "105" into borough number (1) and board number (05).
 * Borough codes: 1=Manhattan, 2=Bronx, 3=Brooklyn, 4=Queens, 5=Staten Island.
 */
function parseDistrict(district: string): { borough: number; board: number; boroughName: string } {
  const boroughMap: Record<number, string> = {
    1: "Manhattan",
    2: "Bronx",
    3: "Brooklyn",
    4: "Queens",
    5: "Staten Island",
  };

  const num = parseInt(district, 10);
  const borough = Math.floor(num / 100);
  const board = num % 100;

  return {
    borough,
    board,
    boroughName: boroughMap[borough] ?? `Borough ${borough}`,
  };
}

function buildCommunityBoard(
  district: string,
  members: Array<{ name: string; title?: string }>,
): CommunityBoard {
  const { boroughName, board } = parseDistrict(district);

  return {
    id: `cb-${district}`,
    district,
    members,
    meetings: [], // Meetings would come from a separate dataset or scrape
    contact: {
      website: `https://www.nyc.gov/site/${boroughName.toLowerCase().replace(/ /g, "")}cb${board}/index.page`,
    },
    scrapedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get community board details for a given district.
 *
 * District format: "105" = Manhattan CB5, "301" = Brooklyn CB1, etc.
 * The first digit is the borough code, the remaining digits are the board number.
 */
export async function getCommunityBoard(district: string): Promise<CommunityBoard> {
  const { boroughName, board } = parseDistrict(district);

  // Query the CB members dataset, filtering by borough and board number
  const rows = await sodaFetch(CB_MEMBERS_DATASET, {
    $where: `borough='${boroughName}' AND board_number='${board}'`,
    $limit: "200",
  });

  const members = rows.map((r: any) => ({
    name: [r.first_name, r.last_name].filter(Boolean).join(" ") || r.name || "Unknown",
    title: r.title ?? r.office ?? undefined,
  }));

  return buildCommunityBoard(district, members);
}

/**
 * List all 59 NYC community boards.
 */
export async function listCommunityBoards(): Promise<CommunityBoard[]> {
  // Fetch a large batch and group by borough + board
  const rows = await sodaFetch(CB_MEMBERS_DATASET, {
    $select: "borough, board_number, first_name, last_name, title",
    $limit: "5000",
  });

  const boroughToCode: Record<string, number> = {
    Manhattan: 1,
    Bronx: 2,
    Brooklyn: 3,
    Queens: 4,
    "Staten Island": 5,
  };

  // Group rows by district
  const grouped = new Map<string, Array<{ name: string; title?: string }>>();

  for (const r of rows) {
    const bCode = boroughToCode[r.borough];
    if (!bCode) continue;
    const boardNum = parseInt(r.board_number, 10);
    if (isNaN(boardNum)) continue;

    const district = `${bCode}${String(boardNum).padStart(2, "0")}`;
    if (!grouped.has(district)) grouped.set(district, []);

    grouped.get(district)!.push({
      name: [r.first_name, r.last_name].filter(Boolean).join(" ") || "Unknown",
      title: r.title ?? undefined,
    });
  }

  return Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([district, members]) => buildCommunityBoard(district, members));
}
