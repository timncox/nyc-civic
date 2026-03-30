import React, { useState, useEffect, useCallback } from "react";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { DistrictInfo } from "../mcp-app";
import { colors } from "../mcp-app";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  from: string;
  body: string;
  ts: string;
}

interface GroupInfo {
  district_key: string;
  thread_id: string;
  tier: string;
  messages: ChatMessage[];
  member_count?: number;
}

interface JoinResult {
  groups?: Array<{ district_key: string; tier: string }>;
  error?: string;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ChatTabProps {
  app: App;
  address: string;
  districts: DistrictInfo;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOKEN_KEY = "nyc-civic-mmp-token";

function getStoredToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

function storeToken(token: string) {
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ }
}

function tierLabel(tier: string): string {
  if (tier === "council") return "Council District";
  if (tier === "assembly") return "Assembly District";
  if (tier === "election") return "Election District";
  return tier;
}

function tierColor(tier: string): string {
  if (tier === "council") return "#3b82f6";
  if (tier === "assembly") return "#8b5cf6";
  if (tier === "election") return "#22c55e";
  return colors.muted;
}

function formatDate(ts: string): string {
  try {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  } catch { return ts; }
}

function districtKeys(districts: DistrictInfo): string[] {
  const keys: string[] = [];
  if (districts.council != null) keys.push(`NYC-CD-${districts.council}`);
  if (districts.stateAssembly != null) keys.push(`NYC-AD-${districts.stateAssembly}`);
  if (districts.stateAssembly != null && districts.electionDistrict != null) {
    keys.push(`NYC-ED-${districts.stateAssembly}-${String(districts.electionDistrict).padStart(3, "0")}`);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ChatTab({ app, address, districts }: ChatTabProps) {
  const [token, setToken] = useState<string | null>(getStoredToken);
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<Record<string, boolean>>({});

  // Join flow state
  const [showJoin, setShowJoin] = useState(false);
  const [joinHandle, setJoinHandle] = useState("");
  const [joinToken, setJoinToken] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  // Load messages for all district groups
  const loadMessages = useCallback(() => {
    if (!token) return;
    const keys = districtKeys(districts);
    if (keys.length === 0) return;

    // Expand first group by default
    if (!expanded && keys.length > 0) setExpanded(keys[0]);

    for (const key of keys) {
      setLoading(prev => ({ ...prev, [key]: true }));
      app.callServerTool({
        name: "get_district_chat",
        arguments: { district_key: key, mmp_token: token, limit: 20 },
      })
        .then(result => {
          if (result.content && Array.isArray(result.content) && result.content.length > 0) {
            const first = result.content[0];
            if ("text" in first && typeof first.text === "string") {
              const parsed = JSON.parse(first.text);
              // Extract messages array from the MMP tool response
              const msgs: ChatMessage[] = [];
              const raw = parsed.messages;
              if (raw?.content && Array.isArray(raw.content)) {
                for (const c of raw.content) {
                  if ("text" in c && typeof c.text === "string") {
                    try {
                      const inner = JSON.parse(c.text);
                      if (Array.isArray(inner.messages)) {
                        for (const m of inner.messages) msgs.push({ from: m.from || m.sender || "?", body: m.body || m.text || "", ts: m.ts || m.timestamp || "" });
                      } else if (inner.from || inner.body) {
                        msgs.push({ from: inner.from || "?", body: inner.body || "", ts: inner.ts || "" });
                      }
                    } catch { /* skip unparseable */ }
                  }
                }
              } else if (Array.isArray(raw)) {
                for (const m of raw) msgs.push({ from: m.from || m.sender || "?", body: m.body || m.text || "", ts: m.ts || m.timestamp || "" });
              }
              setGroups(prev => {
                const existing = prev.filter(g => g.district_key !== key);
                return [...existing, { district_key: key, thread_id: parsed.thread_id, tier: parsed.tier, messages: msgs, member_count: parsed.member_count }];
              });
            }
          }
        })
        .catch(err => {
          setErrors(prev => ({ ...prev, [key]: err instanceof Error ? err.message : String(err) }));
        })
        .finally(() => {
          setLoading(prev => ({ ...prev, [key]: false }));
        });
    }
  }, [app, districts, token, expanded]);

  useEffect(() => {
    if (token) loadMessages();
  }, [token, loadMessages]);

  // Send a message
  const handleSend = useCallback((districtKey: string) => {
    const msg = drafts[districtKey]?.trim();
    if (!msg || !token) return;

    setSending(prev => ({ ...prev, [districtKey]: true }));
    app.callServerTool({
      name: "post_to_district_chat",
      arguments: { district_key: districtKey, message: msg, mmp_token: token },
    })
      .then(() => {
        setDrafts(prev => ({ ...prev, [districtKey]: "" }));
        // Reload this group's messages
        setLoading(prev => ({ ...prev, [districtKey]: true }));
        return app.callServerTool({
          name: "get_district_chat",
          arguments: { district_key: districtKey, mmp_token: token, limit: 20 },
        });
      })
      .then(result => {
        if (result?.content && Array.isArray(result.content) && result.content.length > 0) {
          const first = result.content[0];
          if ("text" in first && typeof first.text === "string") {
            const parsed = JSON.parse(first.text);
            const msgs: ChatMessage[] = [];
            const raw = parsed.messages;
            if (raw?.content && Array.isArray(raw.content)) {
              for (const c of raw.content) {
                if ("text" in c && typeof c.text === "string") {
                  try {
                    const inner = JSON.parse(c.text);
                    if (Array.isArray(inner.messages)) {
                      for (const m of inner.messages) msgs.push({ from: m.from || m.sender || "?", body: m.body || m.text || "", ts: m.ts || m.timestamp || "" });
                    }
                  } catch { /* skip */ }
                }
              }
            } else if (Array.isArray(raw)) {
              for (const m of raw) msgs.push({ from: m.from || m.sender || "?", body: m.body || m.text || "", ts: m.ts || m.timestamp || "" });
            }
            setGroups(prev => {
              const existing = prev.filter(g => g.district_key !== districtKey);
              return [...existing, { district_key: districtKey, thread_id: parsed.thread_id, tier: parsed.tier, messages: msgs, member_count: parsed.member_count }];
            });
          }
        }
      })
      .catch(err => {
        setErrors(prev => ({ ...prev, [districtKey]: err instanceof Error ? err.message : String(err) }));
      })
      .finally(() => {
        setSending(prev => ({ ...prev, [districtKey]: false }));
        setLoading(prev => ({ ...prev, [districtKey]: false }));
      });
  }, [app, drafts, token]);

  // Join handler
  const handleJoin = useCallback(() => {
    if (!joinHandle.trim() || !joinToken.trim()) return;
    setJoining(true);
    setJoinError(null);

    // Store the token first
    storeToken(joinToken.trim());

    app.callServerTool({
      name: "join_district_chat",
      arguments: { address, mmp_handle: joinHandle.trim() },
    })
      .then(result => {
        if (result.isError) {
          const msg = result.content && Array.isArray(result.content) && result.content.length > 0 && "text" in result.content[0]
            ? (result.content[0] as { text: string }).text
            : "Failed to join";
          setJoinError(msg);
          return;
        }
        // Success — set token and close join dialog
        setToken(joinToken.trim());
        setShowJoin(false);
      })
      .catch(err => {
        setJoinError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setJoining(false);
      });
  }, [app, address, joinHandle, joinToken]);

  const keys = districtKeys(districts);

  // Sort groups to match district key order
  const sortedGroups = keys.map(key => groups.find(g => g.district_key === key)).filter(Boolean) as GroupInfo[];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>Chat</span>
        <div style={{ display: "flex", gap: 8 }}>
          {token && (
            <button onClick={loadMessages} style={smallBtnStyle} title="Refresh messages">
              Refresh
            </button>
          )}
          <button
            onClick={() => setShowJoin(!showJoin)}
            style={{ ...smallBtnStyle, background: colors.accent, color: "#fff" }}
          >
            {token ? "Settings" : "Join Chat"}
          </button>
        </div>
      </div>

      {/* Join / Settings dialog */}
      {showJoin && (
        <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: 8, padding: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
            {token ? "Chat Settings" : "Join District Chats"}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <input
              type="text"
              placeholder="MMP handle (e.g. @jane)"
              value={joinHandle}
              onChange={e => setJoinHandle(e.target.value)}
              style={inputStyle}
            />
            <input
              type="password"
              placeholder="MMP token"
              value={joinToken || (token ?? "")}
              onChange={e => setJoinToken(e.target.value)}
              style={inputStyle}
            />
            {joinError && <div style={{ color: colors.no, fontSize: 12 }}>{joinError}</div>}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={handleJoin}
                disabled={joining || !joinHandle.trim() || !joinToken.trim()}
                style={{
                  ...smallBtnStyle,
                  background: colors.accent,
                  color: "#fff",
                  opacity: joining ? 0.6 : 1,
                }}
              >
                {joining ? "Joining..." : "Join"}
              </button>
              <button onClick={() => setShowJoin(false)} style={smallBtnStyle}>
                Cancel
              </button>
              {token && (
                <button
                  onClick={() => {
                    try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
                    setToken(null);
                    setGroups([]);
                    setShowJoin(false);
                  }}
                  style={{ ...smallBtnStyle, color: colors.no }}
                >
                  Disconnect
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Not joined state */}
      {!token && !showJoin && (
        <div style={{ color: colors.muted, fontSize: 13, padding: "20px 0", textAlign: "center" }}>
          Connect your MMP account to chat with neighbors in your district groups.
        </div>
      )}

      {/* Group sections */}
      {token && keys.map(key => {
        const group = sortedGroups.find(g => g.district_key === key);
        const isExpanded = expanded === key;
        const isLoading = loading[key];
        const error = errors[key];
        const tier = group?.tier || tierFromKey(key);
        const color = tierColor(tier);

        return (
          <div key={key} style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: 8, overflow: "hidden" }}>
            <button
              onClick={() => setExpanded(isExpanded ? null : key)}
              style={{
                display: "flex", alignItems: "center", gap: 10, width: "100%",
                padding: "10px 14px", background: "none", border: "none",
                color: colors.text, cursor: "pointer", fontFamily: "system-ui, -apple-system, sans-serif",
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
              <span style={{ fontSize: 13, fontWeight: 600, flex: 1, textAlign: "left" }}>{key}</span>
              <span style={{ fontSize: 11, color: colors.muted }}>{tierLabel(tier)}</span>
              {isLoading && <Spinner />}
              {group?.member_count != null && (
                <span style={{ fontSize: 11, color: colors.muted }}>{group.member_count} ppl</span>
              )}
              <span style={{ fontSize: 10, color: colors.muted, transition: "transform 0.15s", transform: isExpanded ? "rotate(180deg)" : "none" }}>
                {"\u25BC"}
              </span>
            </button>
            {isExpanded && (
              <div style={{ padding: "0 14px 12px", borderTop: `1px solid ${colors.border}` }}>
                {error ? (
                  <div style={{ color: colors.no, fontSize: 12, padding: "8px 0" }}>{error}</div>
                ) : (
                  <div style={{ paddingTop: 8 }}>
                    {/* Messages */}
                    {group && group.messages.length > 0 ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 300, overflowY: "auto", marginBottom: 8 }}>
                        {group.messages.map((msg, i) => (
                          <div key={i} style={{ fontSize: 12, padding: "4px 0", borderBottom: `1px solid ${colors.border}` }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                              <span style={{ fontWeight: 600, color: msg.from === "@nyc-civic" ? colors.accent : colors.text }}>
                                {msg.from}
                              </span>
                              {msg.ts && <span style={{ color: colors.muted, fontSize: 11 }}>{formatDate(msg.ts)}</span>}
                            </div>
                            <div style={{ color: colors.text, lineHeight: 1.4 }}>{msg.body}</div>
                          </div>
                        ))}
                      </div>
                    ) : !isLoading && (
                      <div style={{ color: colors.muted, fontSize: 12, padding: "8px 0" }}>No messages yet</div>
                    )}

                    {/* Send box */}
                    <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                      <input
                        type="text"
                        placeholder="Type a message..."
                        value={drafts[key] || ""}
                        onChange={e => setDrafts(prev => ({ ...prev, [key]: e.target.value }))}
                        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(key); } }}
                        style={{ ...inputStyle, flex: 1 }}
                      />
                      <button
                        onClick={() => handleSend(key)}
                        disabled={sending[key] || !drafts[key]?.trim()}
                        style={{
                          ...smallBtnStyle,
                          background: colors.accent,
                          color: "#fff",
                          opacity: sending[key] ? 0.6 : 1,
                        }}
                      >
                        {sending[key] ? "..." : "Send"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components & styles
// ---------------------------------------------------------------------------

function Spinner() {
  return (
    <>
      <span style={{ fontSize: 11, color: colors.muted, animation: "pulse 1.5s ease-in-out infinite" }}>...</span>
      <style>{`@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>
    </>
  );
}

function tierFromKey(key: string): string {
  if (key.startsWith("NYC-CD-")) return "council";
  if (key.startsWith("NYC-AD-")) return "assembly";
  if (key.startsWith("NYC-ED-")) return "election";
  return "unknown";
}

const smallBtnStyle: React.CSSProperties = {
  background: colors.card,
  border: `1px solid ${colors.border}`,
  color: colors.text,
  fontSize: 12,
  fontWeight: 600,
  padding: "5px 12px",
  borderRadius: 6,
  cursor: "pointer",
  fontFamily: "system-ui, -apple-system, sans-serif",
};

const inputStyle: React.CSSProperties = {
  background: colors.bg,
  border: `1px solid ${colors.border}`,
  color: colors.text,
  fontSize: 12,
  padding: "7px 10px",
  borderRadius: 6,
  outline: "none",
  fontFamily: "system-ui, -apple-system, sans-serif",
};
