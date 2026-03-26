#!/usr/bin/env node
console.log("Starting NYC Civic MCP App server...");

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import cors from "cors";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";

// Import existing tool logic
import { getDb, persistDb } from "./src/db.js";
import { resolveAddress } from "./src/geocoder.js";
import { loadConfig } from "./src/config.js";
import { getCongressMembers, getNYSenators, searchBills as searchCongressBills, getBillDetails as getCongressBillDetails, getMemberVotes as getCongressMemberVotes } from "./src/apis/congress.js";
import { getCommunityBoard as fetchCommunityBoard } from "./src/apis/socrata.js";
import { scrapeCouncilMembers, scrapeCouncilLegislation, scrapeCouncilVotes, scrapeCouncilMemberVotes } from "./src/scrapers/council.js";
import { scrapeStateSenator, searchSenateBills, scrapeSenateBillVotes, scrapeSenatorVotes } from "./src/scrapers/state-senate.js";
import { scrapeAssemblyMember, searchAssemblyBills, scrapeAssemblyMemberVotes } from "./src/scrapers/state-assembly.js";
import { getPartyForDistrict, scrapeAllBoroughParties } from "./src/scrapers/dem-party.js";
import { lookupElectionDistrict } from "./src/scrapers/boe.js";
import type { Rep, Bill, Vote } from "./src/types.js";

const resourceUri = "ui://civic-dashboard/mcp-app.html";

function createServer(): McpServer {
const server = new McpServer({
  name: "nyc-civic",
  version: "2.0.0",
  description: "Interactive NYC civic tracker — reps, votes, bills, Democratic Party org",
});

// ─── Primary App Tool ────────────────────────────────────────────────────────

registerAppTool(
  server,
  "civic_dashboard",
  {
    title: "NYC Civic Dashboard",
    description: "Show an interactive dashboard of NYC elected representatives, voting records, legislation, and Democratic Party organization for a given address.",
    inputSchema: {
      address: z.string().default("").describe("NYC street address"),
    },
    _meta: { ui: { resourceUri } },
  },
  async ({ address }: { address: string }) => {
    if (!address) {
      return {
        content: [{ type: "text", text: JSON.stringify({ address: null, districts: null, message: "Enter an NYC address to get started" }) }],
      };
    }
    const districts = await resolveAddress(address);
    // Try election district
    if (!districts.electionDistrict) {
      try {
        const boe = await lookupElectionDistrict(address);
        if (boe.electionDistrict) districts.electionDistrict = boe.electionDistrict;
      } catch { /* non-critical */ }
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ address, districts }) }],
    };
  },
);

// ─── UI Resource ─────────────────────────────────────────────────────────────

registerAppResource(
  server,
  resourceUri,
  resourceUri,
  { mimeType: RESOURCE_MIME_TYPE },
  async () => {
    const html = await fs.readFile(
      path.join(import.meta.dirname, "dist", "mcp-app.html"),
      "utf-8",
    );
    return {
      contents: [{ uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: html }],
    };
  },
);

// ─── Data Tools (called by the UI via app.callServerTool) ────────────────────

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
    const reps: Rep[] = [];
    const errors: string[] = [];

    if ((level === "all" || level === "city") && districts.council) {
      try {
        const result = await scrapeCouncilMembers();
        const member = result.reps.find(r => r.district === String(districts.council));
        if (member) reps.push(member);
        errors.push(...result.errors);
      } catch (e: any) { errors.push(`Council: ${e.message}`); }
    }

    if ((level === "all" || level === "state") && districts.stateSenate) {
      try {
        const result = await scrapeStateSenator(districts.stateSenate);
        if (result.rep) reps.push(result.rep);
        errors.push(...result.errors);
      } catch (e: any) { errors.push(`Senate: ${e.message}`); }
    }

    if ((level === "all" || level === "state") && districts.stateAssembly) {
      try {
        const result = await scrapeAssemblyMember(districts.stateAssembly);
        if (result.rep) reps.push(result.rep);
        errors.push(...result.errors);
      } catch (e: any) { errors.push(`Assembly: ${e.message}`); }
    }

    if (level === "all" || level === "federal") {
      if (districts.congressional) {
        try { reps.push(...await getCongressMembers("NY", districts.congressional)); } catch (e: any) { errors.push(`Congress: ${e.message}`); }
      }
      try { reps.push(...await getNYSenators()); } catch (e: any) { errors.push(`Senators: ${e.message}`); }
    }

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
        const leg = await scrapeCouncilLegislation();
        const bill = leg.bills.find(b => b.id === bill_id);
        if (bill) {
          const votes = await scrapeCouncilVotes(bill_id);
          return { content: [{ type: "text" as const, text: JSON.stringify({ ...bill, votes: votes.votes }) }] };
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
  { level: z.enum(["city", "state", "federal", "party", "community_board", "all"]) },
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

return server;
} // end createServer

// ─── HTTP Server ─────────────────────────────────────────────────────────────

await getDb(); // Initialize database

const expressApp = express();
expressApp.use(cors());
expressApp.use(express.json());

expressApp.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => transport.close());
  const sessionServer = createServer();
  await sessionServer.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const PORT = parseInt(process.env.PORT || "3001", 10);
expressApp.listen(PORT, () => {
  console.log(`NYC Civic MCP App server listening on http://localhost:${PORT}/mcp`);
});
