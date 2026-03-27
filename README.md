# NYC Civic MCP Server

MCP server for tracking NYC elected representatives, voting records, legislation, and Democratic Party organization across city, state, and federal levels.

## What it does

Enter any NYC address and get:
- **All 6 elected representatives** (City Council, State Assembly, State Senate, U.S. House, 2 U.S. Senators)
- **Federal voting records** (House roll calls via clerk.house.gov XML, Senate roll calls via senate.gov XML)
- **City Council legislation** search, bill details, and legislative histories (via Legistar OData API)
- **Democratic Party organization** (borough leadership via Wikipedia + known-leaders dataset)
- **Community board** members and contact info (via NYC Open Data)
- **District lookup** for all political districts including election district

## Architecture

- **Transport**: StreamableHTTP on port 3001
- **UI**: React dashboard bundled as single HTML via Vite (MCP App)
- **Data sources**:
  - Congress.gov API (federal reps, bill search)
  - clerk.house.gov XML (House roll call votes)
  - senate.gov XML (Senate roll call votes)
  - Legistar OData API (NYC Council legislation, sponsors, histories)
  - council.nyc.gov (council member info via fetch)
  - nyassembly.gov (assembly member info via fetch)
  - Wikipedia API (state senator info, Dem party leadership)
  - Election Street API (geocoding, district lookup)
  - NYC Open Data / Socrata (community boards)

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

- **Congress.gov API key**: Get one at https://api.congress.gov/sign-up/
- **Legistar token**: Request at https://council.nyc.gov/legislation/api/ (submit name + email)

## Running

```bash
# Development (TypeScript directly)
npm run serve

# Production (compile first)
npm run build
npm start
```

The server starts on `http://localhost:3001/mcp`.

## MCP Tools

| Tool | Description |
|------|-------------|
| `civic_dashboard` | Interactive dashboard (MCP App with embedded UI) |
| `lookup_address` | Resolve address to all political districts |
| `get_reps` | Get all elected representatives for an address |
| `get_votes` | Get voting records (city, state_senate, state_assembly, federal) |
| `search_legislation` | Search bills by keyword across all levels |
| `get_bill` | Get bill details with vote breakdown and history |
| `get_community_board` | Get community board members and contact info |
| `get_dem_party` | Get Democratic Party organization for a borough |
| `sync_data` | Trigger a fresh data scrape |

## What works / what doesn't

**Working:**
- Address lookup (all districts including election district)
- All 6 reps for any NYC address
- Federal votes: House (clerk.house.gov XML) + Senate (senate.gov XML)
- City Council legislation search, bill details, sponsors, full legislative history (Legistar API)
- Dem party leadership for all 5 boroughs
- Community board info
- Interactive dashboard via MCP App

**Needs NY Open Legislation API key** (register at legislation.nysenate.gov):
- State senate individual voting records
- State assembly floor votes

**Not available via any API:**
- Per-member city council roll call votes (NYC doesn't populate the Legistar votes table; data only exists in the JS-rendered web interface)
