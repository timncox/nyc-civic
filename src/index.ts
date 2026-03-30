#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getDb, persistDb } from "./db.js";
import { resolveAddress } from "./geocoder.js";
import { loadConfig, saveConfig } from "./config.js";
import { isStale } from "./cache.js";
import { getCongressMembers, getNYSenators, searchBills as searchCongressBills, getBillDetails as getCongressBillDetails, getMemberVotes as getCongressMemberVotes } from "./apis/congress.js";
import { getCommunityBoard as fetchCommunityBoard } from "./apis/socrata.js";
import { scrapeCouncilMembers, scrapeCouncilLegislation, scrapeCouncilVotes, scrapeCouncilMemberVotes, getCouncilBill } from "./scrapers/council.js";
import { scrapeStateSenator, searchSenateBills, scrapeSenateBillVotes, scrapeSenatorVotes } from "./scrapers/state-senate.js";
import { scrapeAssemblyMember, searchAssemblyBills, scrapeAssemblyMemberVotes } from "./scrapers/state-assembly.js";
import { getPartyForDistrict, scrapeAllBoroughParties } from "./scrapers/dem-party.js";
import { lookupElectionDistrict } from "./scrapers/boe.js";
import {
  get311Complaints, getCrimeData, getRestaurantInspections,
  getHousingViolations, getBuildingPermits, getBuildingComplaints,
  getPropertyInfo, getCouncilFunding, getEvictions, getStreetTrees,
} from "./apis/nyc-opendata.js";
import type { DistrictInfo, Rep, Bill, Vote } from "./types.js";

const server = new McpServer({
  name: "nyc-civic",
  version: "1.0.0",
  description: "Track NYC elected representatives, voting records, attendance, and Democratic Party organization across city, state, and federal levels",
});

// Tool 1: lookup_address
server.tool(
  "lookup_address",
  "Resolve a street address to all political districts: city council, community board, state senate, state assembly, congressional district, and election district",
  {
    address: z.string().describe("NYC street address, e.g. '350 5th Ave, New York, NY'"),
  },
  async ({ address }) => {
    try {
      const districts = await resolveAddress(address);

      // Try to get election district too
      let ed: number | null = districts.electionDistrict;
      if (!ed) {
        const boe = await lookupElectionDistrict(address);
        if (boe.electionDistrict) {
          ed = boe.electionDistrict;
          districts.electionDistrict = ed;
        }
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(districts, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// Tool 2: get_reps
server.tool(
  "get_reps",
  "Get all elected representatives for an NYC address — city council member, state senator, state assembly member, US representative, and US senators",
  {
    address: z.string().describe("NYC street address"),
    level: z.enum(["city", "state", "federal", "all"]).default("all").describe("Government level to query"),
  },
  async ({ address, level }) => {
    try {
      const districts = await resolveAddress(address);
      const reps: Rep[] = [];
      const errors: string[] = [];

      if (level === "all" || level === "city") {
        if (districts.council) {
          const db = await getDb();
          const cached = db.exec("SELECT * FROM reps WHERE level = 'city' AND district = ?", [String(districts.council)]);
          if (cached.length > 0 && cached[0].values.length > 0) {
            const row = cached[0].values[0];
            reps.push({ id: row[0] as string, level: "city", district: row[2] as string, name: row[3] as string, party: row[4] as string | null, profile: JSON.parse(row[5] as string || "{}"), scrapedAt: row[6] as number });
          } else {
            const result = await scrapeCouncilMembers();
            errors.push(...result.errors);
            const member = result.reps.find(r => r.district === String(districts.council));
            if (member) reps.push(member);
            // Cache all scraped members
            for (const rep of result.reps) {
              db.run("INSERT OR REPLACE INTO reps (id, level, district, name, party, profile_json, scraped_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [rep.id, rep.level, rep.district, rep.name, rep.party, JSON.stringify(rep.profile), rep.scrapedAt]);
            }
            persistDb();
          }
        }
      }

      if (level === "all" || level === "state") {
        if (districts.stateSenate) {
          const result = await scrapeStateSenator(districts.stateSenate);
          if (result.rep) reps.push(result.rep);
          errors.push(...result.errors);
        }
        if (districts.stateAssembly) {
          const result = await scrapeAssemblyMember(districts.stateAssembly);
          if (result.rep) reps.push(result.rep);
          errors.push(...result.errors);
        }
      }

      if (level === "all" || level === "federal") {
        if (districts.congressional) {
          try {
            const members = await getCongressMembers("NY", districts.congressional);
            reps.push(...members);
          } catch (e: any) { errors.push(`Congress API: ${e.message}`); }
        }
        try {
          const senators = await getNYSenators();
          reps.push(...senators);
        } catch (e: any) { errors.push(`Senate API: ${e.message}`); }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ reps, errors: errors.length > 0 ? errors : undefined }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// Tool 3: get_council_member
server.tool(
  "get_council_member",
  "Get detailed profile of an NYC City Council member by district number or name",
  {
    district: z.number().optional().describe("Council district number (1-51)"),
    name: z.string().optional().describe("Council member name (partial match)"),
  },
  async ({ district, name }) => {
    try {
      if (!district && !name) {
        return { content: [{ type: "text" as const, text: "Provide either district number or name" }], isError: true };
      }
      const result = await scrapeCouncilMembers();
      let member: Rep | undefined;
      if (district) {
        member = result.reps.find(r => r.district === String(district));
      } else if (name) {
        const lower = name.toLowerCase();
        member = result.reps.find(r => r.name.toLowerCase().includes(lower));
      }
      if (!member) {
        return { content: [{ type: "text" as const, text: `Council member not found` }], isError: true };
      }

      // Cache
      const db = await getDb();
      db.run("INSERT OR REPLACE INTO reps (id, level, district, name, party, profile_json, scraped_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [member.id, member.level, member.district, member.name, member.party, JSON.stringify(member.profile), member.scrapedAt]);
      persistDb();

      return { content: [{ type: "text" as const, text: JSON.stringify(member, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// Tool 4: get_votes
server.tool(
  "get_votes",
  "Get voting record for a representative. Filter by topic keyword, date range, and government level",
  {
    rep_name: z.string().optional().describe("Representative name"),
    district: z.number().optional().describe("District number"),
    level: z.enum(["city", "state_senate", "state_assembly", "federal", "all"]).describe("Government level"),
    topic: z.string().optional().describe("Filter votes by topic keyword"),
    date_from: z.string().optional().describe("Start date (YYYY-MM-DD)"),
    date_to: z.string().optional().describe("End date (YYYY-MM-DD)"),
  },
  async ({ rep_name, district, level, topic, date_from, date_to }) => {
    try {
      const allVotes: Vote[] = [];
      const allBills: Bill[] = [];
      const errors: string[] = [];

      if (level === "city" || level === "all") {
        if (district) {
          const result = await scrapeCouncilMemberVotes(district);
          allVotes.push(...result.votes);
          errors.push(...result.errors);
        }
      }

      if (level === "state_senate" || level === "all") {
        if (district) {
          const result = await scrapeSenatorVotes(district);
          allVotes.push(...result.votes);
          errors.push(...result.errors);
        }
      }

      if (level === "state_assembly" || level === "all") {
        if (district) {
          const result = await scrapeAssemblyMemberVotes(district);
          allVotes.push(...result.votes);
          errors.push(...result.errors);
        }
      }

      if (level === "federal" || level === "all") {
        // Need bioguide ID — look up from cache or API
        const db = await getDb();
        const cached = db.exec("SELECT id, profile_json FROM reps WHERE level IN ('federal_house', 'federal_senate') AND (name LIKE ? OR district = ?)",
          [`%${rep_name || ""}%`, String(district || "")]);
        if (cached.length > 0 && cached[0].values.length > 0) {
          for (const row of cached[0].values) {
            const profile = JSON.parse(row[1] as string || "{}");
            if (profile.bioguideId) {
              const result = await getCongressMemberVotes(profile.bioguideId);
              allVotes.push(...result);
            }
          }
        }
      }

      // Filter by topic if provided
      let filteredVotes = allVotes;
      if (topic) {
        const lower = topic.toLowerCase();
        filteredVotes = allVotes.filter(v => {
          const bill = allBills.find(b => b.id === v.billId);
          return bill?.title.toLowerCase().includes(lower) || bill?.summary?.toLowerCase().includes(lower);
        });
      }

      // Filter by date range
      if (date_from) filteredVotes = filteredVotes.filter(v => v.date >= date_from);
      if (date_to) filteredVotes = filteredVotes.filter(v => v.date <= date_to);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ votes: filteredVotes, total: filteredVotes.length, errors: errors.length > 0 ? errors : undefined }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// Tool 5: get_bill
server.tool(
  "get_bill",
  "Get bill details including summary, sponsors, status, and full vote breakdown",
  {
    bill_id: z.string().describe("Bill ID (e.g. 'Int 0247-2024' for city, 'S1234-2025' for state, 'hr1234-119' for federal)"),
    level: z.enum(["city", "state", "federal"]).describe("Government level"),
  },
  async ({ bill_id, level }) => {
    try {
      let bill: (Bill & { votes?: Vote[] }) | null = null;
      const errors: string[] = [];

      if (level === "city") {
        const result = await getCouncilBill(bill_id);
        if (result) {
          bill = result;
        }
      } else if (level === "state") {
        const senateResult = await searchSenateBills(bill_id);
        bill = senateResult.bills.find(b => b.id === bill_id) || null;
        if (bill) {
          const voteResult = await scrapeSenateBillVotes(bill_id);
          bill = { ...bill, votes: voteResult.votes };
          errors.push(...voteResult.errors);
        }
        errors.push(...senateResult.errors);
      } else if (level === "federal") {
        // Parse bill ID: "hr1234-119" → type=hr, number=1234, congress=119
        const match = bill_id.match(/^([a-z]+)(\d+)-(\d+)$/i);
        if (match) {
          const result = await getCongressBillDetails(Number(match[3]), match[1].toLowerCase(), Number(match[2]));
          bill = result;
        }
      }

      if (!bill) {
        return { content: [{ type: "text" as const, text: `Bill ${bill_id} not found at ${level} level` }], isError: true };
      }

      // Cache bill
      const db = await getDb();
      db.run("INSERT OR REPLACE INTO bills (id, level, title, summary, status, sponsors_json, scraped_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [bill.id, bill.level, bill.title, bill.summary, bill.status, JSON.stringify(bill.sponsors), bill.scrapedAt]);
      persistDb();

      return { content: [{ type: "text" as const, text: JSON.stringify({ bill, errors: errors.length > 0 ? errors : undefined }, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// Tool 6: search_legislation
server.tool(
  "search_legislation",
  "Search bills by keyword across city council, state legislature, and Congress",
  {
    query: z.string().describe("Search query"),
    level: z.enum(["city", "state", "federal", "all"]).default("all").describe("Government level"),
    status: z.enum(["introduced", "passed", "signed", "vetoed"]).optional().describe("Filter by status"),
  },
  async ({ query, level, status }) => {
    try {
      const allBills: Bill[] = [];
      const errors: string[] = [];

      if (level === "all" || level === "city") {
        const result = await scrapeCouncilLegislation();
        const filtered = result.bills.filter(b => b.title.toLowerCase().includes(query.toLowerCase()));
        allBills.push(...filtered);
        errors.push(...result.errors);
      }

      if (level === "all" || level === "state") {
        const senateResult = await searchSenateBills(query);
        allBills.push(...senateResult.bills);
        errors.push(...senateResult.errors);

        const assemblyResult = await searchAssemblyBills(query);
        allBills.push(...assemblyResult.bills);
        errors.push(...assemblyResult.errors);
      }

      if (level === "all" || level === "federal") {
        const result = await searchCongressBills(query);
        allBills.push(...result);
      }

      let filtered = allBills;
      if (status) {
        filtered = allBills.filter(b => b.status?.toLowerCase().includes(status));
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ bills: filtered, total: filtered.length, errors: errors.length > 0 ? errors : undefined }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// Tool 7: get_attendance
server.tool(
  "get_attendance",
  "Get meeting/session attendance record for a representative",
  {
    rep_name: z.string().optional().describe("Representative name"),
    district: z.number().optional().describe("District number"),
    level: z.enum(["city", "state_senate", "state_assembly", "federal"]).describe("Government level"),
  },
  async ({ rep_name, district, level }) => {
    try {
      // Attendance data comes from the same scraping sources as votes
      // For now, return what we can from cached data
      const db = await getDb();
      let query = "SELECT * FROM attendance WHERE rep_id LIKE ?";
      let param = "";

      if (level === "city") param = `city-council-${district || "%"}`;
      else if (level === "state_senate") param = `state-senate-${district || "%"}`;
      else if (level === "state_assembly") param = `state-assembly-${district || "%"}`;
      else param = `%${rep_name || ""}%`;

      const result = db.exec(query, [param]);
      if (result.length > 0 && result[0].values.length > 0) {
        const records = result[0].values.map((row: any[]) => ({
          sessionName: row[2],
          present: Boolean(row[3]),
          date: row[4],
        }));
        const total = records.length;
        const present = records.filter(r => r.present).length;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ summary: { attended: present, total, rate: `${Math.round(present / total * 100)}%` }, records }, null, 2),
          }],
        };
      }

      return { content: [{ type: "text" as const, text: "No attendance data cached. Run sync_data first." }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// Tool 8: get_community_board
server.tool(
  "get_community_board",
  "Get community board details: members, meeting schedule, contact info",
  {
    district: z.string().optional().describe("Community board district code (e.g. '105' for Manhattan CB5)"),
    address: z.string().optional().describe("NYC street address (resolves to community board)"),
  },
  async ({ district, address }) => {
    try {
      let cbDistrict = district;
      if (!cbDistrict && address) {
        const districts = await resolveAddress(address);
        cbDistrict = districts.communityBoard || undefined;
      }
      if (!cbDistrict) {
        return { content: [{ type: "text" as const, text: "Provide either district code or address" }], isError: true };
      }

      const cb = await fetchCommunityBoard(cbDistrict);

      // Cache
      const db = await getDb();
      db.run("INSERT OR REPLACE INTO community_boards (id, district, members_json, meetings_json, contact_json, scraped_at) VALUES (?, ?, ?, ?, ?, ?)",
        [`cb-${cbDistrict}`, cbDistrict, JSON.stringify(cb.members), JSON.stringify(cb.meetings), JSON.stringify(cb.contact), cb.scrapedAt]);
      persistDb();

      return { content: [{ type: "text" as const, text: JSON.stringify(cb, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// Tool 9: get_dem_party
server.tool(
  "get_dem_party",
  "Get Democratic Party organization for your area: county committee, district leaders, borough leadership, meetings, and how to get involved",
  {
    address: z.string().optional().describe("NYC street address"),
    borough: z.string().optional().describe("Borough name (Manhattan, Brooklyn, Queens, Bronx, Staten Island)"),
    assembly_district: z.number().optional().describe("State Assembly district number"),
    election_district: z.number().optional().describe("Election district number"),
  },
  async ({ address, borough, assembly_district, election_district }) => {
    try {
      let boro = borough;
      let ad = assembly_district;
      let ed = election_district;

      if (address) {
        const districts = await resolveAddress(address);
        boro = boro || districts.borough || undefined;
        ad = ad || districts.stateAssembly || undefined;
        if (!ed) {
          const boe = await lookupElectionDistrict(address);
          ed = boe.electionDistrict || undefined;
        }
      }

      if (!boro) {
        return { content: [{ type: "text" as const, text: "Provide address or borough" }], isError: true };
      }

      const result = await getPartyForDistrict(boro, ad || 0, ed || undefined);

      // Cache party orgs
      const db = await getDb();
      for (const org of [...result.leadership, ...result.districtLeaders, ...result.countyCommittee]) {
        db.run("INSERT OR REPLACE INTO party_orgs (id, borough, role, name, assembly_district, election_district, details_json, scraped_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [org.id, org.borough, org.role, org.name, org.assemblyDistrict, org.electionDistrict, JSON.stringify(org.details), org.scrapedAt]);
      }
      persistDb();

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// Tool 10: sync_data
server.tool(
  "sync_data",
  "Trigger a fresh data scrape for a specific level or all data. Reports what changed.",
  {
    level: z.enum(["city", "state", "federal", "party", "community_board", "all"]).describe("What to sync"),
    force: z.boolean().default(false).describe("Force refresh even if cache is fresh"),
  },
  async ({ level, force }) => {
    try {
      const reports: Array<{ level: string; records: number; errors: string[]; ms: number }> = [];
      const db = await getDb();

      if (level === "all" || level === "city") {
        const start = Date.now();
        const result = await scrapeCouncilMembers();
        for (const rep of result.reps) {
          db.run("INSERT OR REPLACE INTO reps (id, level, district, name, party, profile_json, scraped_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [rep.id, rep.level, rep.district, rep.name, rep.party, JSON.stringify(rep.profile), rep.scrapedAt]);
        }
        const legResult = await scrapeCouncilLegislation();
        for (const bill of legResult.bills) {
          db.run("INSERT OR REPLACE INTO bills (id, level, title, summary, status, sponsors_json, scraped_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [bill.id, bill.level, bill.title, bill.summary, bill.status, JSON.stringify(bill.sponsors), bill.scrapedAt]);
        }
        reports.push({ level: "city", records: result.reps.length + legResult.bills.length, errors: [...result.errors, ...legResult.errors], ms: Date.now() - start });
      }

      if (level === "all" || level === "state") {
        const start = Date.now();
        const errors: string[] = [];
        // Senate and assembly scraping would go here
        reports.push({ level: "state", records: 0, errors, ms: Date.now() - start });
      }

      if (level === "all" || level === "federal") {
        const start = Date.now();
        // Congress API data refresh
        reports.push({ level: "federal", records: 0, errors: [], ms: Date.now() - start });
      }

      if (level === "all" || level === "party") {
        const start = Date.now();
        const result = await scrapeAllBoroughParties();
        for (const org of result.orgs) {
          db.run("INSERT OR REPLACE INTO party_orgs (id, borough, role, name, assembly_district, election_district, details_json, scraped_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [org.id, org.borough, org.role, org.name, org.assemblyDistrict, org.electionDistrict, JSON.stringify(org.details), org.scrapedAt]);
        }
        reports.push({ level: "party", records: result.orgs.length, errors: result.errors, ms: Date.now() - start });
      }

      persistDb();
      return { content: [{ type: "text" as const, text: JSON.stringify({ synced: reports }, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ─── NYC Open Data Tools ──────────────────────────────────────────────────────

server.tool(
  "get_311",
  "Get 311 complaints near an address (noise, trash, potholes, etc.)",
  { lat: z.number(), lng: z.number(), radius_meters: z.number().default(500), days_back: z.number().default(90), limit: z.number().default(50) },
  async ({ lat, lng, radius_meters, days_back, limit }) => {
    try {
      const data = await get311Complaints(lat, lng, { radiusMeters: radius_meters, daysBack: days_back, limit });
      return { content: [{ type: "text" as const, text: JSON.stringify({ complaints: data, total: data.length }) }] };
    } catch (e: any) { return { content: [{ type: "text" as const, text: e.message }], isError: true }; }
  }
);

server.tool(
  "get_crime",
  "Get recent crime incidents near an address",
  { lat: z.number(), lng: z.number(), radius_meters: z.number().default(500), days_back: z.number().default(180), limit: z.number().default(50) },
  async ({ lat, lng, radius_meters, days_back, limit }) => {
    try {
      const data = await getCrimeData(lat, lng, { radiusMeters: radius_meters, daysBack: days_back, limit });
      return { content: [{ type: "text" as const, text: JSON.stringify({ incidents: data, total: data.length }) }] };
    } catch (e: any) { return { content: [{ type: "text" as const, text: e.message }], isError: true }; }
  }
);

server.tool(
  "get_restaurants",
  "Get restaurant health inspection grades near an address",
  { lat: z.number(), lng: z.number(), radius_meters: z.number().default(300), limit: z.number().default(30) },
  async ({ lat, lng, radius_meters, limit }) => {
    try {
      const data = await getRestaurantInspections(lat, lng, { radiusMeters: radius_meters, limit });
      return { content: [{ type: "text" as const, text: JSON.stringify({ restaurants: data, total: data.length }) }] };
    } catch (e: any) { return { content: [{ type: "text" as const, text: e.message }], isError: true }; }
  }
);

server.tool(
  "get_housing_violations",
  "Get HPD housing code violations for a building",
  { boro_id: z.string().describe("1=Manhattan, 2=Bronx, 3=Brooklyn, 4=Queens, 5=SI"), house_number: z.string(), street_name: z.string(), limit: z.number().default(50) },
  async ({ boro_id, house_number, street_name, limit }) => {
    try {
      const data = await getHousingViolations(boro_id, house_number, street_name, { limit });
      return { content: [{ type: "text" as const, text: JSON.stringify({ violations: data, total: data.length }) }] };
    } catch (e: any) { return { content: [{ type: "text" as const, text: e.message }], isError: true }; }
  }
);

server.tool(
  "get_building_permits",
  "Get DOB building permits for an address",
  { boro_code: z.string().describe("MANHATTAN, BRONX, BROOKLYN, QUEENS, or STATEN ISLAND"), house_number: z.string(), street_name: z.string(), limit: z.number().default(30) },
  async ({ boro_code, house_number, street_name, limit }) => {
    try {
      const data = await getBuildingPermits(boro_code, house_number, street_name, { limit });
      return { content: [{ type: "text" as const, text: JSON.stringify({ permits: data, total: data.length }) }] };
    } catch (e: any) { return { content: [{ type: "text" as const, text: e.message }], isError: true }; }
  }
);

server.tool(
  "get_building_complaints",
  "Get DOB building complaints for an address",
  { house_number: z.string(), street_name: z.string(), limit: z.number().default(30) },
  async ({ house_number, street_name, limit }) => {
    try {
      const data = await getBuildingComplaints(house_number, street_name, { limit });
      return { content: [{ type: "text" as const, text: JSON.stringify({ complaints: data, total: data.length }) }] };
    } catch (e: any) { return { content: [{ type: "text" as const, text: e.message }], isError: true }; }
  }
);

server.tool(
  "get_property",
  "Get property info — zoning, owner, building details, assessed value",
  { lat: z.number(), lng: z.number() },
  async ({ lat, lng }) => {
    try {
      const data = await getPropertyInfo(lat, lng);
      return { content: [{ type: "text" as const, text: JSON.stringify({ properties: data, total: data.length }) }] };
    } catch (e: any) { return { content: [{ type: "text" as const, text: e.message }], isError: true }; }
  }
);

server.tool(
  "get_council_funding",
  "Get City Council discretionary funding for a district",
  { council_district: z.number(), fiscal_year: z.string().optional(), limit: z.number().default(50) },
  async ({ council_district, fiscal_year, limit }) => {
    try {
      const data = await getCouncilFunding(council_district, { limit, fiscalYear: fiscal_year });
      const total$ = data.reduce((sum, d) => sum + d.amount, 0);
      return { content: [{ type: "text" as const, text: JSON.stringify({ funding: data, total: data.length, totalAmount: total$ }) }] };
    } catch (e: any) { return { content: [{ type: "text" as const, text: e.message }], isError: true }; }
  }
);

server.tool(
  "get_evictions",
  "Get eviction filings near an address",
  { lat: z.number(), lng: z.number(), radius_meters: z.number().default(500), days_back: z.number().default(365), limit: z.number().default(30) },
  async ({ lat, lng, radius_meters, days_back, limit }) => {
    try {
      const data = await getEvictions(lat, lng, { radiusMeters: radius_meters, daysBack: days_back, limit });
      return { content: [{ type: "text" as const, text: JSON.stringify({ evictions: data, total: data.length }) }] };
    } catch (e: any) { return { content: [{ type: "text" as const, text: e.message }], isError: true }; }
  }
);

server.tool(
  "get_street_trees",
  "Get street trees near an address",
  { lat: z.number(), lng: z.number(), radius_meters: z.number().default(200) },
  async ({ lat, lng, radius_meters }) => {
    try {
      const data = await getStreetTrees(lat, lng, { radiusMeters: radius_meters });
      return { content: [{ type: "text" as const, text: JSON.stringify({ trees: data, total: data.length }) }] };
    } catch (e: any) { return { content: [{ type: "text" as const, text: e.message }], isError: true }; }
  }
);

async function main() {
  await getDb(); // Initialize database
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
