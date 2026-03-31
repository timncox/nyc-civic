# NYC Civic MCP Server

MCP server for NYC civic data — representatives, legislation, voting records, neighborhood data, Democratic Party organization, and district group chats.

**Live at [nyc.mmp.chat](https://nyc.mmp.chat)**

## Connect

```bash
# Claude Code
claude mcp add --transport http nyc-civic https://nyc.mmp.chat/mcp

# Claude Desktop
# Settings → MCP Servers → Add Remote → https://nyc.mmp.chat/mcp
```

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
- **District group chats** — join neighborhood groups via @nyc_civic bot on MMP

## Architecture

```
server.ts          → HTTP shell (Express + StreamableHTTP, MCP App UI)
src/tools.ts       → All 22 MCP tool registrations
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
  components/      → Reps, Votes, Bills, Neighborhood, Party, CB, Chat tabs
public/
  index.html       → Landing page at nyc.mmp.chat
```

**Transport**: StreamableHTTP on port 3001
**Deployed**: Railway at nyc.mmp.chat
**UI**: React dashboard with 7 tabs, bundled as single HTML (MCP App)
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

## MCP Tools (22)

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

### District Chat
| Tool | Description |
|------|-------------|
| `join_district_chat` | Join your neighborhood district groups via @nyc_civic bot |
| `get_district_chat` | Read messages from a district group |
| `post_to_district_chat` | Send a message to a district group |

### Admin
| Tool | Description |
|------|-------------|
| `sync_data` | Trigger a fresh data scrape |

## District Chat Bot

The `@nyc_civic` bot on [MMP](https://mmp.chat) creates district-scoped group chats and broadcasts civic updates.

- **DM the bot** with an NYC address to join your council, assembly, and borough groups
- **Automated broadcasts**: 311 digests (Mon), attendance (Wed), legislation (Fri)
- **Bot service**: [nyc-civic-bot](../nyc-civic-bot/) — standalone Express app on Railway

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
| MMP (mmp.chat) | District group chats, bot messaging | Bot token |
