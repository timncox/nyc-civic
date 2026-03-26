import type { CommunityBoard } from "../types.js";

const BASE_URL = "https://data.cityofnewyork.us/resource";

/** All 59 NYC Community Boards — ruf7-3wgc */
const CB_DATASET = "ruf7-3wgc";

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

function mapCommunityBoard(r: any): CommunityBoard {
  const districtCode = r.community_board_1 || "";
  const boardNum = r.community_board?.replace(/^Community Board\s*/i, "") || "";

  return {
    id: `cb-${districtCode}`,
    district: districtCode,
    members: [
      ...(r.cb_chair ? [{ name: r.cb_chair, title: "Chair" }] : []),
      ...(r.cb_district_manager ? [{ name: r.cb_district_manager, title: "District Manager" }] : []),
    ],
    meetings: [
      ...(r.cb_board_meeting ? [{ date: r.cb_board_meeting, description: "Board Meeting" }] : []),
      ...(r.cb_cabinet_meeting ? [{ date: r.cb_cabinet_meeting, description: "Cabinet Meeting" }] : []),
    ],
    contact: {
      phone: r.cb_office_phone || undefined,
      email: r.cb_office_email || undefined,
      address: [r.cb_office_address, r.cb_address_line_2].filter(Boolean).join(", ") || undefined,
      website: r.cb_website?.url || undefined,
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
 * District format: "303" = Brooklyn CB3, "105" = Manhattan CB5, etc.
 * The first digit is the borough code, the remaining digits are the board number.
 */
export async function getCommunityBoard(district: string): Promise<CommunityBoard> {
  const rows = await sodaFetch(CB_DATASET, {
    $where: `community_board_1='${district}'`,
    $limit: "1",
  });

  if (rows.length > 0) {
    return mapCommunityBoard(rows[0]);
  }

  // Fallback: return empty board
  return {
    id: `cb-${district}`,
    district,
    members: [],
    meetings: [],
    contact: {},
    scrapedAt: Date.now(),
  };
}

/**
 * List all 59 NYC community boards.
 */
export async function listCommunityBoards(): Promise<CommunityBoard[]> {
  const rows = await sodaFetch(CB_DATASET, { $limit: "100" });
  return rows.map(mapCommunityBoard);
}
