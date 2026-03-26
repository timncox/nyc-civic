import type { Rep, Bill, Vote } from "../types.js";
import { getCongressApiKey } from "../config.js";

const BASE_URL = "https://api.congress.gov/v3";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function congressFetch(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set("api_key", getCongressApiKey());
  url.searchParams.set("format", "json");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  let response = await fetch(url.toString());

  // Simple retry on 429 rate-limit
  if (response.status === 429) {
    await sleep(1000);
    response = await fetch(url.toString());
  }

  if (!response.ok) {
    throw new Error(`Congress API ${response.status}: ${response.statusText} (${path})`);
  }

  return response.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Response → domain type mappers
// ---------------------------------------------------------------------------

function mapMember(m: Record<string, any>, level: Rep["level"]): Rep {
  const terms = m.terms?.item ?? m.terms ?? [];
  const latestTerm = Array.isArray(terms) ? terms[terms.length - 1] : undefined;

  return {
    id: m.bioguideId ?? m.member?.bioguideId ?? "",
    level,
    district: latestTerm?.district ? String(latestTerm.district) : (m.district ? String(m.district) : m.state ?? ""),
    name: m.name ?? m.directOrderName ?? [m.firstName, m.lastName].filter(Boolean).join(" "),
    party: m.partyName ?? m.party ?? null,
    profile: {
      title: latestTerm?.memberType ?? m.memberType ?? undefined,
      photoUrl: m.depiction?.imageUrl ?? undefined,
      website: m.officialWebsiteUrl ?? m.url ?? undefined,
      phone: m.directPhone ?? undefined,
      office: m.addressInformation?.officeAddress ?? undefined,
      termStart: latestTerm?.startYear ? String(latestTerm.startYear) : undefined,
      termEnd: latestTerm?.endYear ? String(latestTerm.endYear) : undefined,
    },
    scrapedAt: Date.now(),
  };
}

function levelForChamber(chamber?: string): Rep["level"] {
  if (!chamber) return "federal_house";
  const lower = chamber.toLowerCase();
  if (lower === "senate") return "federal_senate";
  return "federal_house";
}

function mapBill(b: Record<string, any>): Bill {
  return {
    id: b.number ? `${b.type ?? ""}${b.number}` : (b.billNumber ?? ""),
    level: "federal",
    title: b.title ?? b.shortTitle ?? "",
    summary: b.summary?.text ?? b.latestAction?.text ?? null,
    status: b.latestAction?.text ?? null,
    sponsors: (b.sponsors ?? []).map((s: any) =>
      s.fullName ?? s.name ?? [s.firstName, s.lastName].filter(Boolean).join(" ")
    ),
    scrapedAt: Date.now(),
  };
}

function mapVote(v: Record<string, any>, repId?: string): Vote {
  const position = (v.memberVotes?.vote ?? v.vote ?? v.position ?? "").toLowerCase();
  let mapped: Vote["vote"] = "not_voting";
  if (position.startsWith("yea") || position === "yes" || position === "aye") mapped = "yes";
  else if (position.startsWith("nay") || position === "no") mapped = "no";
  else if (position === "abstain") mapped = "abstain";
  else if (position === "absent" || position === "not voting") mapped = "absent";
  else if (position === "present") mapped = "abstain";

  return {
    id: v.rollNumber ? String(v.rollNumber) : (v.url ?? ""),
    billId: v.bill?.number ? `${v.bill.type ?? ""}${v.bill.number}` : (v.description ?? ""),
    repId: repId ?? "",
    vote: mapped,
    date: v.date ?? "",
    scrapedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Paginated fetch helper
// ---------------------------------------------------------------------------

async function fetchAllPages<T>(
  path: string,
  params: Record<string, string>,
  extractItems: (body: any) => T[],
  maxPages = 10,
): Promise<T[]> {
  const results: T[] = [];
  let offset = 0;
  const limit = parseInt(params.limit ?? "20", 10);

  for (let page = 0; page < maxPages; page++) {
    const body = (await congressFetch(path, { ...params, offset: String(offset), limit: String(limit) })) as any;
    const items = extractItems(body);
    results.push(...items);

    // Stop if we got fewer than requested (last page) or no pagination info
    if (items.length < limit || !body.pagination?.next) break;
    offset += limit;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get current congress members for a state + congressional district.
 */
export async function getCongressMembers(state: string, district: number): Promise<Rep[]> {
  const body = (await congressFetch("/member", {
    stateCode: state.toUpperCase(),
    district: String(district),
    currentMember: "true",
    limit: "20",
  })) as any;

  const members = body.members ?? [];
  return members.map((m: any) => mapMember(m, levelForChamber(m.terms?.item?.[m.terms.item.length - 1]?.chamber)));
}

/**
 * Get a single member by bioguide ID.
 */
export async function getCongressMember(bioguideId: string): Promise<Rep> {
  const body = (await congressFetch(`/member/${encodeURIComponent(bioguideId)}`)) as any;
  const m = body.member ?? body;
  return mapMember(m, levelForChamber(m.terms?.item?.[m.terms.item.length - 1]?.chamber));
}

/**
 * Search bills by keyword query.
 */
export async function searchBills(
  query: string,
  opts?: { congress?: number; limit?: number },
): Promise<Bill[]> {
  const params: Record<string, string> = {
    query,
    limit: String(opts?.limit ?? 20),
  };

  const path = opts?.congress ? `/bill/${opts.congress}` : "/bill";

  const body = (await congressFetch(path, params)) as any;
  const bills = body.bills ?? [];
  return bills.map(mapBill);
}

/**
 * Get bill details including actions and vote information.
 */
export async function getBillDetails(
  congress: number,
  billType: string,
  billNumber: number,
): Promise<Bill & { votes: Vote[] }> {
  const billPath = `/bill/${congress}/${billType.toLowerCase()}/${billNumber}`;

  const [billBody, actionsBody] = await Promise.all([
    congressFetch(billPath) as Promise<any>,
    congressFetch(`${billPath}/actions`) as Promise<any>,
  ]);

  const b = billBody.bill ?? billBody;
  const bill = mapBill(b);

  // Extract roll-call vote references from actions
  const actions = actionsBody.actions ?? [];
  const votes: Vote[] = actions
    .filter((a: any) => a.recordedVotes && a.recordedVotes.length > 0)
    .flatMap((a: any) =>
      a.recordedVotes.map((rv: any) => ({
        id: rv.rollNumber ? String(rv.rollNumber) : (rv.url ?? ""),
        billId: bill.id,
        repId: "",
        vote: "not_voting" as Vote["vote"],
        date: rv.date ?? a.actionDate ?? "",
        scrapedAt: Date.now(),
      })),
    );

  return { ...bill, votes };
}

/**
 * Get a member's voting record.
 */
export async function getMemberVotes(
  bioguideId: string,
  opts?: { offset?: number; limit?: number },
): Promise<Vote[]> {
  const body = (await congressFetch(`/member/${encodeURIComponent(bioguideId)}/votes`, {
    offset: String(opts?.offset ?? 0),
    limit: String(opts?.limit ?? 20),
  })) as any;

  const votes = body.votes ?? [];
  return votes.map((v: any) => mapVote(v, bioguideId));
}

/**
 * Get both current NY senators.
 */
export async function getNYSenators(): Promise<Rep[]> {
  const body = (await congressFetch("/member", {
    stateCode: "NY",
    chamber: "senate",
    currentMember: "true",
    limit: "10",
  })) as any;

  const members = body.members ?? [];
  return members.map((m: any) => mapMember(m, "federal_senate"));
}
