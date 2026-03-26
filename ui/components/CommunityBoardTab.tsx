import React, { useState, useEffect } from "react";
import type { App } from "@modelcontextprotocol/ext-apps";
import { colors } from "../mcp-app";

interface CommunityBoard {
  id: string;
  district: string;
  members: Array<{ name: string; title?: string }>;
  meetings: Array<{ date: string; location?: string; description?: string }>;
  contact: { phone?: string; email?: string; address?: string; website?: string };
}

interface CommunityBoardTabProps {
  app: App;
  district: string | null;
}

export function CommunityBoardTab({ app, district }: CommunityBoardTabProps) {
  const [data, setData] = useState<CommunityBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!district) {
      setLoading(false);
      setError("No community board district found for this address.");
      return;
    }

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const result = await app.callServerTool({
          name: "get_community_board",
          arguments: { district },
        });

        if (cancelled) return;

        if (result.isError) {
          const msg =
            result.content && Array.isArray(result.content) && result.content.length > 0 && "text" in result.content[0]
              ? (result.content[0] as { text: string }).text
              : "Failed to load community board data";
          setError(msg);
          return;
        }

        if (result.content && Array.isArray(result.content) && result.content.length > 0) {
          const first = result.content[0];
          if ("text" in first && typeof first.text === "string") {
            const parsed = JSON.parse(first.text);
            setData(parsed);
            return;
          }
        }

        setError("Unexpected response format");
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load community board data");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [app, district]);

  if (loading) {
    return (
      <div style={{ color: colors.muted, fontSize: 14, padding: "20px 0" }}>
        <span style={{ animation: "pulse 1.5s ease-in-out infinite" }}>Loading...</span>
        <style>{`@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
      </div>
    );
  }

  if (error) return <div style={{ color: colors.no, fontSize: 14 }}>{error}</div>;
  if (!data) return <div style={{ color: colors.muted, fontSize: 14 }}>No community board data available.</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Contact Info */}
      {(data.contact.phone || data.contact.email || data.contact.address || data.contact.website) && (
        <div>
          <h3 style={sectionHeaderStyle}>Contact Info</h3>
          <div
            style={{
              background: colors.card,
              border: `1px solid ${colors.border}`,
              borderRadius: 8,
              padding: 14,
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
              {data.contact.phone && (
                <div>
                  <span style={{ color: colors.muted, fontWeight: 600 }}>Phone:</span>{" "}
                  <span style={{ color: colors.text }}>{data.contact.phone}</span>
                </div>
              )}
              {data.contact.email && (
                <div>
                  <span style={{ color: colors.muted, fontWeight: 600 }}>Email:</span>{" "}
                  <span style={{ color: colors.text }}>{data.contact.email}</span>
                </div>
              )}
              {data.contact.address && (
                <div>
                  <span style={{ color: colors.muted, fontWeight: 600 }}>Address:</span>{" "}
                  <span style={{ color: colors.text }}>{data.contact.address}</span>
                </div>
              )}
              {data.contact.website && (
                <div>
                  <span style={{ color: colors.muted, fontWeight: 600 }}>Website:</span>{" "}
                  <span style={{ color: colors.accent }}>{data.contact.website}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Meeting Schedule */}
      {data.meetings.length > 0 && (
        <div>
          <h3 style={sectionHeaderStyle}>Meeting Schedule</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {data.meetings.map((m, i) => (
              <div
                key={i}
                style={{
                  background: colors.card,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 8,
                  padding: 12,
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 500 }}>{m.date}</div>
                {m.location && (
                  <div style={{ fontSize: 13, color: colors.muted, marginTop: 4 }}>{m.location}</div>
                )}
                {m.description && (
                  <div style={{ fontSize: 13, color: colors.muted, marginTop: 2 }}>{m.description}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Board Members */}
      {data.members.length > 0 && (
        <div>
          <h3 style={sectionHeaderStyle}>Board Members ({data.members.length})</h3>
          <div
            style={{
              background: colors.card,
              border: `1px solid ${colors.border}`,
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            <div style={{ maxHeight: 400, overflowY: "auto" }}>
              {data.members.map((member, i) => (
                <div
                  key={i}
                  style={{
                    padding: "10px 14px",
                    borderBottom: i < data.members.length - 1 ? `1px solid ${colors.border}` : "none",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span style={{ fontSize: 14 }}>{member.name}</span>
                  {member.title && (
                    <span
                      style={{
                        fontSize: 12,
                        color: colors.muted,
                        background: `${colors.border}`,
                        padding: "2px 8px",
                        borderRadius: 6,
                      }}
                    >
                      {member.title}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Empty state */}
      {data.members.length === 0 && data.meetings.length === 0 && (
        <div style={{ color: colors.muted, fontSize: 14 }}>
          No community board data available for district {district}.
        </div>
      )}
    </div>
  );
}

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "#888",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  margin: "0 0 10px",
};
