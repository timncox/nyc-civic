import React, { useState, useCallback } from "react";
import type { App } from "@modelcontextprotocol/ext-apps";
import { colors } from "../mcp-app";

interface Bill {
  id: string;
  level: string;
  title: string;
  summary: string | null;
  status: string | null;
  sponsors: string[];
}

interface BillDetail extends Bill {
  votes?: Array<{
    id: string;
    repId: string;
    vote: string;
    date: string;
  }>;
}

interface BillsTabProps {
  app: App;
}

export function BillsTab({ app }: BillsTabProps) {
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<"city" | "state" | "federal" | "all">("all");
  const [bills, setBills] = useState<Bill[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedBill, setExpandedBill] = useState<BillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const handleSearch = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = query.trim();
      if (!trimmed) return;

      setLoading(true);
      setError(null);
      setBills([]);
      setExpandedBill(null);

      try {
        const result = await app.callServerTool({
          name: "search_legislation",
          arguments: { query: trimmed, level },
        });

        if (result.isError) {
          const msg =
            result.content && Array.isArray(result.content) && result.content.length > 0 && "text" in result.content[0]
              ? (result.content[0] as { text: string }).text
              : "Search failed";
          setError(msg);
          return;
        }

        if (result.content && Array.isArray(result.content) && result.content.length > 0) {
          const first = result.content[0];
          if ("text" in first && typeof first.text === "string") {
            const data = JSON.parse(first.text);
            setBills(data.bills || []);
            return;
          }
        }

        setError("Unexpected response format");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Search failed");
      } finally {
        setLoading(false);
      }
    },
    [app, query, level],
  );

  const handleBillClick = useCallback(
    async (bill: Bill) => {
      if (expandedBill?.id === bill.id) {
        setExpandedBill(null);
        return;
      }

      setDetailLoading(true);
      setDetailError(null);
      setExpandedBill({ ...bill });

      try {
        const result = await app.callServerTool({
          name: "get_bill",
          arguments: { bill_id: bill.id, level: bill.level },
        });

        if (result.isError) {
          const msg =
            result.content && Array.isArray(result.content) && result.content.length > 0 && "text" in result.content[0]
              ? (result.content[0] as { text: string }).text
              : "Failed to load bill details";
          setDetailError(msg);
          return;
        }

        if (result.content && Array.isArray(result.content) && result.content.length > 0) {
          const first = result.content[0];
          if ("text" in first && typeof first.text === "string") {
            const data = JSON.parse(first.text);
            setExpandedBill(data.bill || bill);
            return;
          }
        }

        setDetailError("Unexpected response format");
      } catch (err) {
        setDetailError(err instanceof Error ? err.message : "Failed to load bill details");
      } finally {
        setDetailLoading(false);
      }
    },
    [app, expandedBill],
  );

  const levelBadge = (l: string) => {
    const badgeColors: Record<string, string> = {
      city: "#8b5cf6",
      state: "#f59e0b",
      federal: colors.accent,
    };
    return (
      <span
        style={{
          background: badgeColors[l] || colors.muted,
          color: "#fff",
          fontSize: 10,
          fontWeight: 700,
          padding: "2px 6px",
          borderRadius: 6,
          textTransform: "uppercase",
          lineHeight: "14px",
        }}
      >
        {l}
      </span>
    );
  };

  return (
    <div>
      <form onSubmit={handleSearch} style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search bills by keyword..."
          style={{
            flex: 1,
            padding: "8px 12px",
            fontSize: 14,
            fontFamily: "system-ui, -apple-system, sans-serif",
            background: colors.card,
            color: colors.text,
            border: `1px solid ${colors.border}`,
            borderRadius: 8,
            outline: "none",
          }}
        />
        <select
          value={level}
          onChange={(e) => setLevel(e.target.value as typeof level)}
          style={{
            padding: "8px 12px",
            fontSize: 14,
            fontFamily: "system-ui, -apple-system, sans-serif",
            background: colors.card,
            color: colors.text,
            border: `1px solid ${colors.border}`,
            borderRadius: 8,
            outline: "none",
          }}
        >
          <option value="all">All Levels</option>
          <option value="city">City</option>
          <option value="state">State</option>
          <option value="federal">Federal</option>
        </select>
        <button
          type="submit"
          disabled={loading || !query.trim()}
          style={{
            padding: "8px 16px",
            fontSize: 14,
            fontFamily: "system-ui, -apple-system, sans-serif",
            fontWeight: 600,
            background: colors.accent,
            color: "#fff",
            border: "none",
            borderRadius: 8,
            cursor: loading || !query.trim() ? "not-allowed" : "pointer",
            opacity: loading || !query.trim() ? 0.5 : 1,
          }}
        >
          Search
        </button>
      </form>

      {loading && (
        <div style={{ color: colors.muted, fontSize: 14, padding: "20px 0" }}>
          <span style={{ animation: "pulse 1.5s ease-in-out infinite" }}>Loading...</span>
          <style>{`@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
        </div>
      )}

      {error && <div style={{ color: colors.no, fontSize: 14 }}>{error}</div>}

      {!loading && !error && bills.length === 0 && query.trim() && (
        <div style={{ color: colors.muted, fontSize: 14 }}>No bills found.</div>
      )}

      {!loading && bills.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {bills.map((bill) => {
            const isExpanded = expandedBill?.id === bill.id;
            return (
              <div
                key={bill.id}
                style={{
                  background: colors.card,
                  border: `1px solid ${isExpanded ? colors.accent : colors.border}`,
                  borderRadius: 8,
                  padding: 14,
                  cursor: "pointer",
                  transition: "border-color 0.15s",
                }}
                onClick={() => handleBillClick(bill)}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  {levelBadge(bill.level)}
                  <span style={{ fontSize: 12, color: colors.muted }}>{bill.id}</span>
                  {bill.status && (
                    <span style={{ fontSize: 12, color: colors.muted, marginLeft: "auto" }}>
                      {bill.status}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>{bill.title}</div>
                {bill.sponsors.length > 0 && (
                  <div style={{ fontSize: 12, color: colors.muted }}>
                    Sponsor: {bill.sponsors.join(", ")}
                  </div>
                )}

                {/* Expanded detail */}
                {isExpanded && (
                  <div
                    style={{
                      marginTop: 12,
                      paddingTop: 12,
                      borderTop: `1px solid ${colors.border}`,
                    }}
                  >
                    {detailLoading && (
                      <div style={{ color: colors.muted, fontSize: 13 }}>
                        <span style={{ animation: "pulse 1.5s ease-in-out infinite" }}>Loading details...</span>
                      </div>
                    )}
                    {detailError && (
                      <div style={{ color: colors.no, fontSize: 13 }}>{detailError}</div>
                    )}
                    {!detailLoading && !detailError && expandedBill && (
                      <>
                        {expandedBill.summary && (
                          <div style={{ fontSize: 13, color: colors.text, marginBottom: 10, lineHeight: 1.5 }}>
                            {expandedBill.summary}
                          </div>
                        )}
                        {expandedBill.votes && expandedBill.votes.length > 0 && (
                          <div>
                            <div
                              style={{
                                fontSize: 12,
                                fontWeight: 600,
                                color: colors.muted,
                                textTransform: "uppercase",
                                marginBottom: 6,
                              }}
                            >
                              Votes ({expandedBill.votes.length})
                            </div>
                            <div style={{ maxHeight: 200, overflowY: "auto" }}>
                              {expandedBill.votes.slice(0, 20).map((v) => (
                                <div
                                  key={v.id}
                                  style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    fontSize: 12,
                                    padding: "4px 0",
                                    borderBottom: `1px solid ${colors.border}`,
                                  }}
                                >
                                  <span style={{ color: colors.muted }}>{v.repId}</span>
                                  <span
                                    style={{
                                      color:
                                        v.vote === "yes"
                                          ? colors.yes
                                          : v.vote === "no"
                                            ? colors.no
                                            : colors.absent,
                                      fontWeight: 600,
                                    }}
                                  >
                                    {v.vote.toUpperCase()}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
