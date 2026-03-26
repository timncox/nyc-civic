# NYC Civic MCP App — Interactive Dashboard Design

## Overview

Convert the existing nyc-civic MCP server from a stdio tool-only server to an MCP App with an interactive React dashboard that renders inline in Claude's chat. Users enter an address and get a tabbed civic dashboard showing reps, voting records, legislation, Democratic Party org, and community board info.

## Architecture

### Transport Change

stdio → StreamableHTTP (Express on localhost:3001). Required for MCP App hosts to fetch UI resources over HTTP.

### Tool Registration

One primary tool registered via `registerAppTool`:
- `civic_dashboard` — takes an address, returns district info, triggers the interactive UI

All 10 existing tools remain as regular `server.tool()` calls. The React UI calls them via `app.callServerTool()` as the user navigates tabs.

### Project Structure

```
nyc-civic/
  src/                        # Existing server code (unchanged)
    index.ts                  # Tool handler logic (refactored to export handlers)
    types.ts, db.ts, etc.     # Unchanged
    apis/                     # Unchanged
    scrapers/                 # Unchanged
  ui/                         # NEW — React dashboard
    mcp-app.tsx               # Main app component
    components/
      AddressBar.tsx          # Address input + district summary
      RepsTab.tsx             # Rep cards grouped by level
      VotesTab.tsx            # Filterable vote table
      BillsTab.tsx            # Legislation search + detail view
      PartyTab.tsx            # Dem party org, meetings, involvement
      CommunityBoardTab.tsx   # Board members, meetings, contact
  server.ts                   # NEW — Express + StreamableHTTP entry
  mcp-app.html                # NEW — HTML shell for Vite
  vite.config.ts              # NEW — Bundles React to single HTML
```

## Dashboard UI

### Layout

Address bar at top, district summary below it, tabbed content area.

### Tabs

1. **Reps** (default) — Cards for each rep: photo, name, party, district, committees, contact. Grouped by level (City → State → Federal).
2. **Votes** — Table with columns: bill, rep, vote (color-coded badge), date. Filters: level dropdown, topic keyword, date range.
3. **Bills** — Search bar + results. Click bill → detail panel with summary, sponsors, status, vote breakdown bar.
4. **Party** — Borough leadership, district leaders (by AD), county committee (by ED), upcoming meetings, "Get Involved" links.
5. **Community Board** — Members list, meeting schedule, contact info.

### Data Flow

1. Address entered → `civic_dashboard` tool called → returns district info
2. Districts populate summary bar
3. Reps tab auto-loads via `app.callServerTool({ name: "get_reps", ... })`
4. Other tabs load on click via their respective tools

### Styling

Dark theme, inline CSS (bundled into single file). Clean sans-serif typography. Color-coded vote badges (green=yes, red=no, gray=absent).

## Dependencies (New)

- `@modelcontextprotocol/ext-apps` — registerAppTool, registerAppResource, App class, useApp hook
- `express` + `cors` — HTTP server
- `react` + `react-dom` — UI framework
- `vite` + `vite-plugin-singlefile` + `@vitejs/plugin-react` — build

## Build Pipeline

- `npm run build:ui` — Vite bundles mcp-app.html → dist/mcp-app.html
- `npm run build:server` — tsc compiles server → dist/
- `npm run build` — both
- `npm run serve` — npx tsx server.ts

## Server Entry (server.ts)

- Imports tool handler logic from src/
- Registers `civic_dashboard` via registerAppTool with `_meta.ui.resourceUri: "ui://civic-dashboard/mcp-app.html"`
- Registers all 10 original tools as regular server.tool() (callable by UI)
- Registers UI resource via registerAppResource serving Vite-bundled HTML
- Express on port 3001 with StreamableHTTP transport + CORS

## Testing

- Local: basic-host from ext-apps repo
- Claude.ai: cloudflared tunnel to localhost:3001
- Claude Desktop: direct localhost connection
