# NYC Civic MCP Server

MCP server for tracking NYC elected representatives, voting records, legislation, neighborhood data, and Democratic Party organization across city, state, and federal levels.

## What it does

Enter any NYC address and get:
- **All 6 elected representatives** — City Council, State Assembly, State Senate, U.S. House, 2 U.S. Senators
- **Federal voting records** — House roll calls (clerk.house.gov XML), Senate roll calls (senate.gov XML)
- **City Council legislation** — search, bill details, sponsors, full legislative history (Legistar OData API)
- **Council attendance** — per-member meeting attendance records with rates
- **Neighborhood data** — 311 complaints, crime, restaurant grades, building permits/violations, property info, evictions, street trees
- **Democratic Party organization** — borough leadership via Wikipedia + known-leaders dataset
- **Community board** — members and contact info
- **Council discretionary funding** — where your council member spends money
- **District lookup** — all political districts including election district

## Architecture

```
server.ts          → HTTP shell (Express + StreamableHTTP, MCP App UI)
src/tools.ts       → All 19 MCP tool registrations
src/apis/
  congress.ts      → Congress.gov API + House/Senate vote XML
  legistar.ts      → Legistar OData API client (shared)
  attendance.ts    → Council meeting attendance via Legistar rollcalls
  nyc-opendata.ts  → 10 NYC Open Data (Socrata) endpoints
  socrata.ts       → Community board data
src/scrapers/
  council.ts       → Council legislation via Legistar API
  dem-party.ts     → Dem party leadership (Wikipedia + known-leaders)
  state-senate.ts  → State senate bills (fetch-based)
  state-assembly.ts → State assembly bills (fetch-based)
  boe.ts           → Board of Elections (election district lookup)
src/
  geocoder.ts      → Address → district resolution (Election Street API)
  reps-lookup.ts   → Rep lookup via direct fetch (no Playwright)
  config.ts        → API keys from ~/.nyc-civic/config.json
  db.ts            → sql.js SQLite cache
  types.ts         → Shared TypeScript types
ui/
  mcp-app.tsx      → React dashboard (bundled to single HTML via Vite)
  components/      → Reps, Votes, Bills, Neighborhood, Party, CB tabs
```

**Transport**: StreamableHTTP on port 3001
**UI**: React dashboard with 6 tabs, bundled as single HTML (MCP App)
**No Playwright dependency** — all scrapers use direct fetch or REST APIs

## Setup

```bash
npm install
```

### API Keys

Configure in `~/.nyc-civic/config.json`:

```json
{
  "congress_api_key": "YOUR_KEY",
  "legistar_token": "YOUR_TOKEN"
}
```

- **Congress.gov API key**: https://api.congress.gov/sign-up/
- **Legistar token**: https://council.nyc.gov/legislation/api/ (submit name + email)

## Running

```bash
# Development
npm run serve

# Production
npm run build
npm start
```

Server starts on `http://localhost:3001/mcp`.

## MCP Tools (19)

### Representatives & Governance
| Tool | Description |
|------|-------------|
| `civic_dashboard` | Interactive dashboard (MCP App with embedded UI) |
| `lookup_address` | Resolve address to all political districts |
| `get_reps` | All elected representatives for an address |
| `get_votes` | Voting records (city, state, federal) |
| `get_attendance` | City Council meeting attendance records |
| `get_community_board` | Community board members and contact info |
| `get_dem_party` | Democratic Party organization for a borough |
| `get_council_funding` | Council member discretionary funding |

### Legislation
| Tool | Description |
|------|-------------|
| `search_legislation` | Search bills by keyword (city, state, federal) |
| `get_bill` | Bill details with sponsors, history, vote breakdown |

### Neighborhood (NYC Open Data)
| Tool | Description |
|------|-------------|
| `get_311` | 311 complaints near an address (noise, trash, potholes) |
| `get_crime` | NYPD crime incidents with geo radius search |
| `get_restaurants` | DOH restaurant inspection grades and violations |
| `get_housing_violations` | HPD housing code violations for a building |
| `get_building_permits` | DOB building permit issuance |
| `get_building_complaints` | DOB building complaints |
| `get_property` | PLUTO zoning, owner, building details, assessed value |
| `get_evictions` | Eviction filings near an address |
| `get_street_trees` | Street tree census (species, health, diameter) |

### Admin
| Tool | Description |
|------|-------------|
| `sync_data` | Trigger a fresh data scrape |

## Data Sources

| Source | What it provides | Auth |
|--------|-----------------|------|
| Congress.gov API | Federal reps, bill search, bill details | API key |
| clerk.house.gov XML | House per-member roll call votes | None |
| senate.gov XML | Senate per-member roll call votes | None |
| Legistar OData API | NYC Council legislation, sponsors, histories, attendance | Token |
| NYC Open Data (Socrata) | 311, crime, restaurants, buildings, property, trees, evictions | None |
| council.nyc.gov | Council member profiles | None |
| nyassembly.gov | Assembly member profiles, bill search | None |
| Wikipedia API | State senator info, Dem party leadership | None |
| Election Street API | Address geocoding, all political districts | None |

## Status

**Working:**
- Address lookup (all districts including election district)
- All 6 reps for any NYC address
- Federal votes: House + Senate (per-member roll calls)
- City Council legislation search, bill details, sponsors, full legislative history
- Council meeting attendance tracking with per-member rates
- All 10 NYC Open Data neighborhood tools
- Dem party leadership for all 5 boroughs
- Community board info
- Interactive dashboard with Neighborhood tab

**Needs NY Open Legislation API key** (register at legislation.nysenate.gov):
- State senate individual voting records
- State assembly floor votes

**Not available via any API:**
- Per-member city council roll call votes (NYC doesn't populate the Legistar votes table)
