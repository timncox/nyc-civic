import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveAddress } from "./geocoder.js";
import { lookupAllReps } from "./reps-lookup.js";
import { lookupElectionDistrict } from "./scrapers/boe.js";
import { getCongressMembers, getNYSenators, searchBills as searchCongressBills, getBillDetails as getCongressBillDetails, getMemberVotes as getCongressMemberVotes } from "./apis/congress.js";
import { getCommunityBoard as fetchCommunityBoard } from "./apis/socrata.js";
import { scrapeCouncilMembers, scrapeCouncilLegislation, scrapeCouncilMemberVotes, getCouncilBill } from "./scrapers/council.js";
import { searchSenateBills, scrapeSenatorVotes } from "./scrapers/state-senate.js";
import { searchAssemblyBills, scrapeAssemblyMemberVotes } from "./scrapers/state-assembly.js";
import { getPartyForDistrict, scrapeAllBoroughParties } from "./scrapers/dem-party.js";
import { get311Complaints, getCrimeData, getRestaurantInspections, getHousingViolations, getBuildingPermits, getBuildingComplaints, getPropertyInfo, getCouncilFunding, getEvictions, getStreetTrees } from "./apis/nyc-opendata.js";
import { getCouncilAttendance } from "./apis/attendance.js";
import type { Rep, Bill, Vote } from "./types.js";

export function registerTools(server: McpServer): void {

server.tool(
  "lookup_address",
  "Resolve a street address to all political districts",
  { address: z.string() },
  async ({ address }) => {
    const districts = await resolveAddress(address);
    return { content: [{ type: "text" as const, text: JSON.stringify(districts) }] };
  }
);

server.tool(
  "get_reps",
  "Get all elected representatives for an NYC address",
  {
    address: z.string(),
    level: z.enum(["city", "state", "federal", "all"]).default("all"),
  },
  async ({ address, level }) => {
    const districts = await resolveAddress(address);

    // Use the lightweight fetch-based lookup (no Playwright)
    const { reps, errors } = await lookupAllReps({
      council: (level === "all" || level === "city") ? districts.council : null,
      stateAssembly: (level === "all" || level === "state") ? districts.stateAssembly : null,
      stateSenate: (level === "all" || level === "state") ? districts.stateSenate : null,
      congressional: (level === "all" || level === "federal") ? districts.congressional : null,
    });

    return { content: [{ type: "text" as const, text: JSON.stringify({ reps, errors: errors.length ? errors : undefined }) }] };
  }
);

server.tool(
  "get_votes",
  "Get voting record for a representative",
  {
    district: z.number(),
    level: z.enum(["city", "state_senate", "state_assembly", "federal"]),
  },
  async ({ district, level }) => {
    const votes: Vote[] = [];
    const errors: string[] = [];
    try {
      if (level === "city") {
        const r = await scrapeCouncilMemberVotes(district);
        votes.push(...r.votes); errors.push(...r.errors);
      } else if (level === "state_senate") {
        const r = await scrapeSenatorVotes(district);
        votes.push(...r.votes); errors.push(...r.errors);
      } else if (level === "state_assembly") {
        const r = await scrapeAssemblyMemberVotes(district);
        votes.push(...r.votes); errors.push(...r.errors);
      } else if (level === "federal") {
        // Look up congress members for this district to get bioguideIds
        const members = await getCongressMembers("NY", district);
        const senators = await getNYSenators();
        const allFederal = [...members, ...senators];
        const nameMap: Record<string, string> = {};
        for (const rep of allFederal) nameMap[rep.id] = rep.name;
        for (const rep of allFederal) {
          try {
            const memberVotes = await getCongressMemberVotes(rep.id);
            // Enrich votes with rep name for the UI
            for (const v of memberVotes) {
              (v as any).repName = nameMap[v.repId] || v.repId;
            }
            votes.push(...memberVotes);
          } catch (e: any) { errors.push(`${rep.name}: ${e.message}`); }
        }
      }
    } catch (e: any) { errors.push(e.message); }
    return { content: [{ type: "text" as const, text: JSON.stringify({ votes, errors: errors.length ? errors : undefined }) }] };
  }
);

server.tool(
  "search_legislation",
  "Search bills by keyword across all levels",
  {
    query: z.string(),
    level: z.enum(["city", "state", "federal", "all"]).default("all"),
  },
  async ({ query, level }) => {
    const bills: Bill[] = [];
    const errors: string[] = [];
    if (level === "all" || level === "city") {
      try {
        const r = await scrapeCouncilLegislation();
        bills.push(...r.bills.filter(b => b.title.toLowerCase().includes(query.toLowerCase())));
        errors.push(...r.errors);
      } catch (e: any) { errors.push(e.message); }
    }
    if (level === "all" || level === "state") {
      try { const r = await searchSenateBills(query); bills.push(...r.bills); errors.push(...r.errors); } catch (e: any) { errors.push(e.message); }
      try { const r = await searchAssemblyBills(query); bills.push(...r.bills); errors.push(...r.errors); } catch (e: any) { errors.push(e.message); }
    }
    if (level === "all" || level === "federal") {
      try { bills.push(...await searchCongressBills(query)); } catch (e: any) { errors.push(e.message); }
    }
    return { content: [{ type: "text" as const, text: JSON.stringify({ bills, total: bills.length, errors: errors.length ? errors : undefined }) }] };
  }
);

server.tool(
  "get_bill",
  "Get bill details with vote breakdown",
  { bill_id: z.string(), level: z.enum(["city", "state", "federal"]) },
  async ({ bill_id, level }) => {
    try {
      if (level === "city") {
        const result = await getCouncilBill(bill_id);
        if (result) {
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        }
      } else if (level === "federal") {
        const match = bill_id.match(/^([a-z]+)(\d+)-(\d+)$/i);
        if (match) {
          const result = await getCongressBillDetails(Number(match[3]), match[1], Number(match[2]));
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        }
      }
      return { content: [{ type: "text" as const, text: `Bill ${bill_id} not found` }], isError: true };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: e.message }], isError: true };
    }
  }
);

server.tool(
  "get_community_board",
  "Get community board details",
  { district: z.string() },
  async ({ district }) => {
    try {
      const cb = await fetchCommunityBoard(district);
      return { content: [{ type: "text" as const, text: JSON.stringify(cb) }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: e.message }], isError: true };
    }
  }
);

server.tool(
  "get_dem_party",
  "Get Democratic Party organization for an area",
  {
    borough: z.string(),
    assembly_district: z.number().optional(),
    election_district: z.number().optional(),
  },
  async ({ borough, assembly_district, election_district }) => {
    try {
      const result = await getPartyForDistrict(borough, assembly_district || 0, election_district || undefined);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: e.message }], isError: true };
    }
  }
);

server.tool(
  "sync_data",
  "Trigger a fresh data scrape",
  { level: z.enum(["city", "state", "federal", "party", "community_board", "all"]).default("all") },
  async ({ level }) => {
    const reports: any[] = [];
    if (level === "all" || level === "city") {
      const start = Date.now();
      const r = await scrapeCouncilMembers();
      reports.push({ level: "city", records: r.reps.length, errors: r.errors, ms: Date.now() - start });
    }
    if (level === "all" || level === "party") {
      const start = Date.now();
      const r = await scrapeAllBoroughParties();
      reports.push({ level: "party", records: r.orgs.length, errors: r.errors, ms: Date.now() - start });
    }
    return { content: [{ type: "text" as const, text: JSON.stringify({ synced: reports }) }] };
  }
);

// ─── NYC Open Data Tools ──────────────────────────────────────────────────────

server.tool(
  "get_311",
  "Get 311 complaints near an address (noise, trash, potholes, etc.)",
  {
    lat: z.number(),
    lng: z.number(),
    radius_meters: z.number().default(500),
    days_back: z.number().default(90),
    limit: z.number().default(50),
  },
  async ({ lat, lng, radius_meters, days_back, limit }) => {
    try {
      const data = await get311Complaints(lat, lng, { radiusMeters: radius_meters, daysBack: days_back, limit });
      return { content: [{ type: "text" as const, text: JSON.stringify({ complaints: data, total: data.length }) }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: e.message }], isError: true };
    }
  }
);

server.tool(
  "get_crime",
  "Get recent crime incidents near an address",
  {
    lat: z.number(),
    lng: z.number(),
    radius_meters: z.number().default(500),
    days_back: z.number().default(180),
    limit: z.number().default(50),
  },
  async ({ lat, lng, radius_meters, days_back, limit }) => {
    try {
      const data = await getCrimeData(lat, lng, { radiusMeters: radius_meters, daysBack: days_back, limit });
      return { content: [{ type: "text" as const, text: JSON.stringify({ incidents: data, total: data.length }) }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: e.message }], isError: true };
    }
  }
);

server.tool(
  "get_restaurants",
  "Get restaurant health inspection grades near an address",
  {
    lat: z.number(),
    lng: z.number(),
    radius_meters: z.number().default(300),
    limit: z.number().default(30),
  },
  async ({ lat, lng, radius_meters, limit }) => {
    try {
      const data = await getRestaurantInspections(lat, lng, { radiusMeters: radius_meters, limit });
      return { content: [{ type: "text" as const, text: JSON.stringify({ restaurants: data, total: data.length }) }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: e.message }], isError: true };
    }
  }
);

server.tool(
  "get_housing_violations",
  "Get HPD housing code violations for a building",
  {
    boro_id: z.string().describe("Borough code: 1=Manhattan, 2=Bronx, 3=Brooklyn, 4=Queens, 5=Staten Island"),
    house_number: z.string(),
    street_name: z.string(),
    limit: z.number().default(50),
  },
  async ({ boro_id, house_number, street_name, limit }) => {
    try {
      const data = await getHousingViolations(boro_id, house_number, street_name, { limit });
      return { content: [{ type: "text" as const, text: JSON.stringify({ violations: data, total: data.length }) }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: e.message }], isError: true };
    }
  }
);

server.tool(
  "get_building_permits",
  "Get DOB building permits for an address",
  {
    boro_code: z.string().describe("MANHATTAN, BRONX, BROOKLYN, QUEENS, or STATEN ISLAND"),
    house_number: z.string(),
    street_name: z.string(),
    limit: z.number().default(30),
  },
  async ({ boro_code, house_number, street_name, limit }) => {
    try {
      const data = await getBuildingPermits(boro_code, house_number, street_name, { limit });
      return { content: [{ type: "text" as const, text: JSON.stringify({ permits: data, total: data.length }) }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: e.message }], isError: true };
    }
  }
);

server.tool(
  "get_building_complaints",
  "Get DOB building complaints for an address",
  {
    house_number: z.string(),
    street_name: z.string(),
    limit: z.number().default(30),
  },
  async ({ house_number, street_name, limit }) => {
    try {
      const data = await getBuildingComplaints(house_number, street_name, { limit });
      return { content: [{ type: "text" as const, text: JSON.stringify({ complaints: data, total: data.length }) }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: e.message }], isError: true };
    }
  }
);

server.tool(
  "get_property",
  "Get property info — zoning, owner, building details, assessed value",
  {
    lat: z.number(),
    lng: z.number(),
  },
  async ({ lat, lng }) => {
    try {
      const data = await getPropertyInfo(lat, lng);
      return { content: [{ type: "text" as const, text: JSON.stringify({ properties: data, total: data.length }) }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: e.message }], isError: true };
    }
  }
);

server.tool(
  "get_council_funding",
  "Get City Council discretionary funding for a district",
  {
    council_district: z.number(),
    fiscal_year: z.string().optional(),
    limit: z.number().default(50),
  },
  async ({ council_district, fiscal_year, limit }) => {
    try {
      const data = await getCouncilFunding(council_district, { limit, fiscalYear: fiscal_year });
      const total$ = data.reduce((sum, d) => sum + d.amount, 0);
      return { content: [{ type: "text" as const, text: JSON.stringify({ funding: data, total: data.length, totalAmount: total$ }) }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: e.message }], isError: true };
    }
  }
);

server.tool(
  "get_evictions",
  "Get eviction filings near an address",
  {
    lat: z.number(),
    lng: z.number(),
    radius_meters: z.number().default(500),
    days_back: z.number().default(365),
    limit: z.number().default(30),
  },
  async ({ lat, lng, radius_meters, days_back, limit }) => {
    try {
      const data = await getEvictions(lat, lng, { radiusMeters: radius_meters, daysBack: days_back, limit });
      return { content: [{ type: "text" as const, text: JSON.stringify({ evictions: data, total: data.length }) }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: e.message }], isError: true };
    }
  }
);

server.tool(
  "get_street_trees",
  "Get street trees near an address",
  {
    lat: z.number(),
    lng: z.number(),
    radius_meters: z.number().default(200),
  },
  async ({ lat, lng, radius_meters }) => {
    try {
      const data = await getStreetTrees(lat, lng, { radiusMeters: radius_meters });
      return { content: [{ type: "text" as const, text: JSON.stringify({ trees: data, total: data.length }) }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: e.message }], isError: true };
    }
  }
);

// ─── Attendance Tool ──────────────────────────────────────────────────────────

server.tool(
  "get_attendance",
  "Get City Council meeting attendance records",
  {
    member_name: z.string().optional().describe("Filter by council member name"),
    meetings: z.number().default(10).describe("Number of recent meetings to check"),
  },
  async ({ member_name, meetings }) => {
    try {
      const data = await getCouncilAttendance({ limit: meetings, personName: member_name || undefined });
      const memberStats: Record<string, { present: number; absent: number }> = {};
      for (const meeting of data.meetings) {
        for (const r of meeting.records) {
          if (!memberStats[r.personName]) memberStats[r.personName] = { present: 0, absent: 0 };
          if (r.value === "Present") memberStats[r.personName].present++;
          else memberStats[r.personName].absent++;
        }
      }
      const summary = Object.entries(memberStats).map(([name, stats]) => ({
        name,
        present: stats.present,
        absent: stats.absent,
        rate: `${Math.round((stats.present / (stats.present + stats.absent)) * 100)}%`,
      })).sort((a, b) => b.absent - a.absent);

      return { content: [{ type: "text" as const, text: JSON.stringify({
        meetings: data.meetings.length,
        summary,
        details: data.meetings,
        errors: data.errors.length ? data.errors : undefined,
      }) }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: e.message }], isError: true };
    }
  }
);

} // end registerTools
