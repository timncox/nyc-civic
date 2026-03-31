# NYC Civic MCP Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate two diverged entry points into a single HTTP server with shared tool registrations, extract Legistar into its own API module, and add real attendance tracking.

**Architecture:** Extract all 19 MCP tool handlers into `src/tools.ts` which takes an `McpServer` and registers tools on it. `server.ts` becomes a thin HTTP shell that creates the server, calls `registerTools()`, adds MCP App resources, and starts Express. Delete `src/index.ts` (stdio). Extract `legistarFetch` from `council.ts` into `src/apis/legistar.ts` so both council and attendance code can use it. Add `get_attendance` tool powered by Legistar rollcalls API.

**Tech Stack:** TypeScript, MCP SDK (StreamableHTTP), Express, Legistar OData API, NYC Open Data (Socrata), Congress.gov API, senate.gov XML

---

### Task 1: Extract Legistar API client into its own module

**Files:**
- Create: `src/apis/legistar.ts`
- Modify: `src/scrapers/council.ts` (remove `legistarFetch`, import from new module)

- [ ] **Step 1: Create `src/apis/legistar.ts`**

Extract `legistarFetch` from `council.ts` and make it the shared Legistar client:

```typescript
// src/apis/legistar.ts
import { getLegistarToken } from "../config.js";

const LEGISTAR_API = "https://webapi.legistar.com/v1/nyc";
const FETCH_TIMEOUT = 15_000;

export async function legistarFetch(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const token = getLegistarToken();
  if (!token) throw new Error("Legistar API token not configured — set legistar_token in ~/.nyc-civic/config.json");

  const url = new URL(`${LEGISTAR_API}${path}`);
  url.searchParams.set("token", token);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(`$${k}`, v);
  }

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) throw new Error(`Legistar API ${res.status}: ${path}`);
  return res.json();
}
```

- [ ] **Step 2: Update `src/scrapers/council.ts`**

Remove the local `legistarFetch` function and `getLegistarToken` import. Replace with:

```typescript
import { legistarFetch } from "../apis/legistar.js";
```

Remove these lines from council.ts:
- The `import { getLegistarToken } from "../config.js";` line
- The `const LEGISTAR_API = ...` constant
- The entire `legistarFetch` function (lines ~37-50)
- References to `getLegistarToken()` in functions that check token availability — replace with a try/catch around `legistarFetch` calls

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add src/apis/legistar.ts src/scrapers/council.ts
git commit -m "Extract Legistar API client into src/apis/legistar.ts"
```

---

### Task 2: Add attendance data via Legistar rollcalls API

**Files:**
- Create: `src/apis/attendance.ts`

- [ ] **Step 1: Create `src/apis/attendance.ts`**

```typescript
// src/apis/attendance.ts
import { legistarFetch } from "./legistar.js";
import type { AttendanceRecord } from "../types.js";

interface RollCallEntry {
  personId: number;
  personName: string;
  value: string; // "Present", "Absent", "Excused", etc.
}

interface MeetingAttendance {
  eventId: number;
  date: string;
  body: string;
  records: RollCallEntry[];
}

/**
 * Get attendance records for City Council stated meetings.
 * Fetches roll call data from the Legistar API.
 */
export async function getCouncilAttendance(
  opts?: { limit?: number; personName?: string },
): Promise<{ meetings: MeetingAttendance[]; errors: string[] }> {
  const meetings: MeetingAttendance[] = [];
  const errors: string[] = [];
  const limit = opts?.limit ?? 10;

  try {
    // Get recent City Council stated meetings
    const events = (await legistarFetch("/events", {
      filter: `EventBodyName eq 'City Council' and EventDate lt datetime'${new Date().toISOString().slice(0, 10)}'`,
      orderby: "EventDate desc",
      top: String(limit),
    })) as any[];

    for (const event of events) {
      try {
        // Find the roll call event item
        const items = (await legistarFetch(`/events/${event.EventId}/eventitems`, {
          filter: "EventItemRollCallFlag eq 1",
        })) as any[];

        if (items.length === 0) continue;

        // Get roll call records
        const rollcalls = (await legistarFetch(
          `/eventitems/${items[0].EventItemId}/rollcalls`,
        )) as any[];

        const records: RollCallEntry[] = rollcalls.map((rc: any) => ({
          personId: rc.RollCallPersonId,
          personName: rc.RollCallPersonName ?? "",
          value: rc.RollCallValueName ?? "Unknown",
        }));

        // Filter by person name if specified
        const filtered = opts?.personName
          ? records.filter(r =>
              r.personName.toLowerCase().includes(opts.personName!.toLowerCase()),
            )
          : records;

        meetings.push({
          eventId: event.EventId,
          date: event.EventDate?.slice(0, 10) ?? "",
          body: event.EventBodyName ?? "City Council",
          records: filtered,
        });
      } catch (e) {
        errors.push(`Event ${event.EventId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    errors.push(`Attendance fetch: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { meetings, errors };
}
```

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add src/apis/attendance.ts
git commit -m "Add attendance data via Legistar rollcalls API"
```

---

### Task 3: Extract tool registrations into `src/tools.ts`

This is the main refactor. Move all 19 tool handlers out of `server.ts` into a shared module.

**Files:**
- Create: `src/tools.ts`
- Modify: `server.ts` (gut tool definitions, call `registerTools()`)

- [ ] **Step 1: Create `src/tools.ts`**

This file exports one function: `registerTools(server: McpServer)`. It imports all data sources and registers every tool. Take tool handlers from `server.ts` (the up-to-date versions). Add the new `get_attendance` tool.

The file structure:

```typescript
// src/tools.ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Data sources
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
  // ... all 19 tool registrations from server.ts, plus get_attendance
}
```

Copy every `server.tool(...)` block from `server.ts` lines 98-460 (the data tools section — everything after the MCP App tool/resource and before `return server`). Paste into `registerTools()`.

Add the new `get_attendance` tool:

```typescript
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
      // Build summary
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
```

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add src/tools.ts
git commit -m "Extract all tool registrations into src/tools.ts"
```

---

### Task 4: Slim down `server.ts` to HTTP shell

**Files:**
- Modify: `server.ts` (remove all tool handlers, import `registerTools`)

- [ ] **Step 1: Rewrite `server.ts`**

Replace the entire `createServer()` function body. Keep: MCP App tool (`civic_dashboard`), MCP App resource, and the call to `registerTools(server)`. Remove: all `server.tool(...)` blocks (they're now in `src/tools.ts`). Remove: unused imports.

The new `createServer()` should be ~40 lines:

```typescript
import { registerTools } from "./src/tools.js";

function createServer(): McpServer {
  const server = new McpServer({
    name: "nyc-civic",
    version: "2.0.0",
    description: "Interactive NYC civic tracker — reps, votes, bills, Democratic Party org",
  });

  // MCP App tool (dashboard entry point)
  registerAppTool(server, "civic_dashboard", { ... }, async ({ address }) => { ... });

  // MCP App resource (embedded UI)
  registerAppResource(server, resourceUri, resourceUri, { ... }, async () => { ... });

  // All data tools
  registerTools(server);

  return server;
}
```

Keep the Express HTTP server section unchanged (lines ~280-end).

- [ ] **Step 2: Clean up imports**

Remove imports that are now only used in `src/tools.ts`:
- All scraper imports
- All API imports except what `civic_dashboard` needs (just `resolveAddress`, `lookupElectionDistrict`)
- `type { Rep, Bill, Vote }`

Keep:
- MCP SDK imports
- `registerAppTool`, `registerAppResource`, `RESOURCE_MIME_TYPE`
- `cors`, `express`, `fs`, `path`, `crypto`, `z`
- `getDb`
- `resolveAddress` (used by civic_dashboard)
- `lookupElectionDistrict` (used by civic_dashboard)
- `registerTools` from `./src/tools.js`

- [ ] **Step 3: Type check and build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add server.ts
git commit -m "Slim server.ts to HTTP shell — tools now in src/tools.ts"
```

---

### Task 5: Delete `src/index.ts` and update config

**Files:**
- Delete: `src/index.ts`
- Modify: `package.json` (remove `start` script pointing to dist/index.js)
- Modify: `~/Library/Application Support/Claude/claude_desktop_config.json` (update nyc-civic to use server.ts)

- [ ] **Step 1: Delete `src/index.ts`**

```bash
rm src/index.ts
```

- [ ] **Step 2: Update `package.json`**

Change the `start` and `main` fields:

```json
{
  "main": "dist/server.js",
  "scripts": {
    "build:server": "tsc",
    "build:ui": "INPUT=mcp-app.html vite build",
    "build": "npm run build:server && npm run build:ui",
    "serve": "npx tsx server.ts",
    "start": "node dist/server.js",
    "dev": "tsc --watch"
  }
}
```

- [ ] **Step 3: Update `tsconfig.json`** (if needed)

Check that `server.ts` is included in the compilation. It's at the project root, so it should already be picked up. Verify the output goes to `dist/server.js`.

- [ ] **Step 4: Update Claude Desktop config**

Change the nyc-civic entry to run the HTTP server instead of stdio:

```json
"nyc-civic": {
  "command": "node",
  "args": ["/Users/timcox/tim-os/nyc-civic/dist/server.js"]
}
```

Note: Claude Desktop may not support HTTP transport natively. If not, the MCP is accessible via the MCP App on Claude.ai. The Desktop config entry may need to be removed entirely.

- [ ] **Step 5: Build and verify**

```bash
npm run build
```

Expected: clean build, `dist/server.js` exists, `dist/index.js` no longer generated

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Remove stdio entry point — HTTP-only via server.ts"
```

---

### Task 6: Clean up unused code

**Files:**
- Modify: `src/cache.ts` (check if still used)
- Modify: `src/scrapers/council.ts` (remove `getLegistarToken` check patterns now that legistar.ts handles it)

- [ ] **Step 1: Check for dead code**

```bash
# Find unused exports
for file in src/cache.ts src/db.ts src/config.ts; do
  echo "=== $file ==="
  grep -r "$(basename $file .ts)" server.ts src/ --include='*.ts' -l
done
```

`src/cache.ts` exports `isStale` — check if anything still uses it. If only `src/index.ts` used it (now deleted), remove the file.

- [ ] **Step 2: Remove dead files/exports**

Delete `src/cache.ts` if unused. Remove any unused exports from other files.

- [ ] **Step 3: Remove `scrapeCouncilVotes` import from server.ts**

The `scrapeCouncilVotes` function is imported in the old server.ts but the new `get_bill` tool uses `getCouncilBill` instead. Clean up any leftover unused imports in `src/tools.ts`.

- [ ] **Step 4: Type check and build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Remove dead code and unused imports"
```

---

### Task 7: End-to-end test

**Files:** none (testing only)

- [ ] **Step 1: Start server**

```bash
npx tsx server.ts &
sleep 3
```

- [ ] **Step 2: Initialize MCP session**

```bash
curl -s http://localhost:3001/mcp -X POST \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}},"id":1}'
```

Expected: 200 with server info, session ID in response headers

- [ ] **Step 3: Test each tool category**

Test one tool from each category:
- `lookup_address` — "250 Broadway, New York, NY"
- `get_reps` — address + level=all
- `get_votes` — district=10, level=federal
- `get_attendance` — meetings=3 (**new tool**)
- `search_legislation` — query="housing", level=city
- `get_bill` — bill_id="Int 0510-2026", level=city
- `get_311` — lat/lng for 250 Broadway
- `get_crime` — same lat/lng
- `get_restaurants` — same lat/lng
- `get_property` — same lat/lng
- `get_community_board` — district="101"
- `get_dem_party` — borough="Manhattan"

All should return valid JSON with data.

- [ ] **Step 4: Kill server**

```bash
lsof -ti:3001 | xargs kill
```

- [ ] **Step 5: Final commit and push**

```bash
git add -A
git commit -m "Refactor complete: single HTTP entry point, shared tools, attendance tracking"
git push origin main
```
