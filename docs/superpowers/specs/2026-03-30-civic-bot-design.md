# @nyc-civic MMP Bot — Design Spec

## Overview

A webhook-based MMP bot (`@nyc-civic`) that creates district-scoped group chats for NYC residents, broadcasts civic updates, and integrates with the NYC Civic dashboard UI.

**Three deliverables:**
1. **Bot service** — standalone Node app, receives MMP webhooks, manages groups, broadcasts updates
2. **Chat tools in nyc-civic** — `get_district_chat`, `post_to_district_chat`, `join_district_chat` tools that proxy to MMP
3. **Chat tab in dashboard UI** — shows district group messages inline in the MCP App

## Bot Service (`nyc-civic-bot`)

### Infrastructure

- Standalone Express server in `/Users/timcox/tim-os/nyc-civic-bot/`
- Registers as `@nyc-civic` on mmp.chat
- MMP webhook delivers DMs and group @mentions to `POST /webhook`
- Bot calls MMP HTTP API (mmp.chat/mcp) to send messages, create groups, manage members
- Bot calls nyc-civic HTTP API (localhost:3001/mcp) for civic data
- Deploys on Railway (separate service, same project)
- SQLite database for user↔district mappings and broadcast state

### MMP Account

- Handle: `@nyc-civic`
- Profile: "NYC Civic Bot — your neighborhood civic hub"
- Webhook URL: `https://nyc-civic-bot.up.railway.app/webhook` (or similar)
- Auth: bot has its own MMP token stored in env var `MMP_BOT_TOKEN`

### Group Structure (3 tiers)

| Level | Name Format | Example | Scope | Content Focus |
|-------|-------------|---------|-------|---------------|
| Council District | `NYC CD-{N}` | `NYC CD-1` | ~170K people | Legislation, votes, attendance, funding |
| Assembly District | `NYC AD-{N}` | `NYC AD-65` | ~130K people | 311 trends, crime alerts, meeting reminders |
| Election District | `NYC ED-{AD}-{ED}` | `NYC ED-65-042` | ~1K people | Hyperlocal neighbors |

51 CD groups + ~150 AD groups + ~6000 ED groups (created on demand, not pre-seeded).

Groups are created lazily — only when the first user joins that district.

### User Onboarding

**Path 1 — DM the bot:**

User sends DM to `@nyc-civic` with an NYC address.

Bot flow:
1. Parse the message for an address (regex for NYC street addresses, or treat the whole message as an address)
2. Call nyc-civic `lookup_address` tool to resolve districts
3. For each tier (CD, AD, ED):
   - Check if group exists (bot maintains a mapping table)
   - If not, create it via MMP `mmp-create-group`
   - Add the user via MMP `mmp-add-member`
4. Reply with confirmation listing all groups joined

Bot response:
```
Welcome! Found your districts:

📍 Council District 1 — CM Christopher Marte
📍 Assembly District 65 — AM Grace Lee
📍 Election District 65-042

You've been added to 3 groups:
• NYC CD-1 (23 members)
• NYC AD-65 (8 members)
• NYC ED-65-042 (you're the first!)

You'll receive civic updates in these groups.
```

**Path 2 — nyc-civic dashboard:**

The civic dashboard has a "Join Chat" button. When clicked:
1. Dashboard calls `join_district_chat` tool with the user's resolved districts
2. nyc-civic server calls the bot's API to register the user
3. Bot creates/joins groups as above
4. Dashboard shows the groups in the Chat tab

This path requires the user to have an MMP account. The tool should check and prompt registration if needed.

### Broadcasts

**Scheduled broadcasts (via node-cron):**

| Broadcast | Schedule | Target | Data Source |
|-----------|----------|--------|-------------|
| Weekly 311 digest | Monday 9am | AD groups | nyc-civic `get_311` (past 7 days, aggregate by type) |
| Crime summary | Monday 9am | AD groups | nyc-civic `get_crime` (past 7 days, count by category) |
| Meeting reminders | Day before | AD + CD groups | Legistar events API (community board + council meetings) |

**Event-driven broadcasts (after data changes detected):**

| Broadcast | Trigger | Target | Data Source |
|-----------|---------|--------|-------------|
| New legislation | New matter introduced by district CM | CD groups | Legistar matters API (poll every 6 hours) |
| Vote results | After stated meeting | CD groups | Legistar histories API (PassedFlag changes) |
| Attendance report | After stated meeting | CD groups | Legistar rollcalls API |
| Council funding | New grants published | CD groups | NYC Open Data council funding dataset |

**Broadcast format:**

Messages are plain text with light formatting (MMP supports basic text):

```
📋 New Legislation — CD-1

Int 0764-2026: "311 transmitting image and video data for housing services"
Sponsored by: Crystal Hudson, Public Advocate Jumaane Williams
Status: In Committee

Reply in this group to discuss.
```

```
🗳️ Vote Result — CD-1

Int 0510-2026: "An online public procurement interface"
Result: ✅ Approved by Council (2026-02-12)
Your CM Christopher Marte: Voted in full session

Full history: Introduced → Committee Hearing → Amended → Approved
```

```
📊 Weekly 311 Digest — AD-65

Past 7 days near Assembly District 65:
• Noise: 14 complaints (↑ from 8 last week)
• Street Condition: 7 complaints
• Sanitation: 5 complaints
• Other: 3 complaints

Top location: 250 Broadway area (6 complaints)
```

### Bot Database Schema

```sql
-- Maps MMP users to their districts
CREATE TABLE user_districts (
  mmp_user_id TEXT NOT NULL,
  mmp_handle TEXT NOT NULL,
  address TEXT NOT NULL,
  council_district INTEGER,
  assembly_district INTEGER,
  election_district INTEGER,
  borough TEXT,
  lat REAL,
  lng REAL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (mmp_user_id)
);

-- Maps districts to MMP group thread IDs
CREATE TABLE district_groups (
  district_key TEXT NOT NULL,  -- "CD-1", "AD-65", "ED-65-042"
  tier TEXT NOT NULL,           -- "cd", "ad", "ed"
  mmp_thread_id TEXT NOT NULL,
  district_number INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (district_key)
);

-- Tracks what's been broadcast to avoid duplicates
CREATE TABLE broadcast_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  district_key TEXT NOT NULL,
  broadcast_type TEXT NOT NULL,  -- "legislation", "vote", "attendance", "311_digest", etc.
  content_hash TEXT NOT NULL,    -- hash of the message content to deduplicate
  sent_at INTEGER NOT NULL
);
```

### Webhook Handler

The bot receives POST requests from MMP when someone messages `@nyc-civic`:

```typescript
// POST /webhook
// MMP sends: { thread_id, sender_handle, body, ... }

async function handleWebhook(req, res) {
  const { thread_id, sender_handle, body } = req.body;

  // Check if this is a DM (onboarding) or group message
  if (isDM(thread_id)) {
    // Parse address from body
    const address = parseAddress(body);
    if (address) {
      await onboardUser(sender_handle, address);
    } else {
      await sendHelp(sender_handle);
    }
  } else {
    // Group message mentioning @nyc-civic
    // Could handle commands like "stats", "who's my rep", etc.
    await handleGroupCommand(thread_id, sender_handle, body);
  }

  res.json({ ok: true });
}
```

## nyc-civic Chat Tools

Three new tools added to `src/tools.ts`:

### `join_district_chat`

Registers the user with the bot and joins them to their district groups. Called from the dashboard "Join Chat" button.

```
Input: { mmp_handle: string, address: string }
Output: { groups: [{ name, thread_id, member_count }], message: string }
```

Calls the bot's HTTP API: `POST /api/join` with the user's MMP handle and address.

### `get_district_chat`

Fetches recent messages from a district group. The nyc-civic server proxies to MMP API.

```
Input: { district_key: string, limit?: number }
Output: { messages: [{ sender, body, timestamp }], group_name: string, member_count: number }
```

Calls MMP API: `mmp-thread` with the group's thread_id (looked up from bot's district_groups table).

### `post_to_district_chat`

Sends a message to a district group on behalf of the user.

```
Input: { district_key: string, message: string, mmp_handle: string }
Output: { sent: true, thread_id: string }
```

Calls MMP API: `mmp-reply` to post to the group thread.

## Dashboard Chat Tab

New `ChatTab` component in `ui/components/ChatTab.tsx`.

### Layout

```
┌─────────────────────────────────────────┐
│ Chat                    [Join Chat]      │
├─────────────────────────────────────────┤
│ ▼ NYC CD-1 · Council District    23 ppl │
│   ┌─────────────────────────────────┐   │
│   │ @nyc-civic  3/26                │   │
│   │ 🗳️ Vote: Int 0510-2026 Approved │   │
│   │                                 │   │
│   │ @jane  3/27                     │   │
│   │ Anyone going to the CB meeting? │   │
│   │                                 │   │
│   │ [Type a message...]       [Send]│   │
│   └─────────────────────────────────┘   │
│                                         │
│ ▶ NYC AD-65 · Assembly District   8 ppl │
│ ▶ NYC ED-65-042 · Election Dist   1 ppl │
└─────────────────────────────────────────┘
```

### States

- **Not joined**: Shows district info + "Join Chat" button that prompts for MMP handle
- **Joined**: Shows collapsible group sections with messages and send box
- **Loading**: Spinner per section while fetching messages
- **No MMP account**: Shows "Create an MMP account at mmp.chat to join neighborhood chat"

### Behavior

- Loads messages on tab open (calls `get_district_chat` for each group)
- Sending a message calls `post_to_district_chat`
- "Join Chat" calls `join_district_chat`
- Messages are not real-time (refresh on tab switch or manual refresh button)
- Bot broadcasts appear like regular messages from `@nyc-civic`

## Phased Implementation

**Phase 1: Bot core + DM onboarding**
- Create nyc-civic-bot project
- Register @nyc-civic on MMP
- Webhook handler for DM onboarding (address → districts → create/join groups)
- SQLite database for user/group tracking
- Deploy on Railway

**Phase 2: Broadcasts**
- Scheduled broadcasts (311 digest, crime summary, meeting reminders)
- Event-driven broadcasts (legislation, votes, attendance, funding)
- Broadcast deduplication via content hashing

**Phase 3: Dashboard integration**
- `join_district_chat`, `get_district_chat`, `post_to_district_chat` tools
- ChatTab UI component
- Bot API endpoints for nyc-civic to call

## Open Questions

- **Moderation**: Who moderates district groups? Bot owner (Tim) initially, then community moderators?
- **Rate limiting**: How often can the bot post? MMP may rate-limit. Batch broadcasts into digest-style messages.
- **Privacy**: Address data is stored in the bot DB. Users should be able to leave and delete their data.
- **Scale**: 6000+ potential ED groups. Only create on demand. Consider merging very low-activity ED groups.
