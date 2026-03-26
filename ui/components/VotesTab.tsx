import React, { useState, useCallback } from "react";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { DistrictInfo } from "../mcp-app";
import { colors } from "../mcp-app";

interface Vote {
  id: string;
  billId: string;
  repId: string;
  vote: string;
  date: string;
}

interface VotesTabProps {
  app: App;
  districts: DistrictInfo;
}

type LevelOption = {
  label: string;
  level: "city" | "state_senate" | "state_assembly" | "federal" | "all";
  district: number | null;
};

export function VotesTab({ app, districts }: VotesTabProps) {
  const [votes, setVotes] = useState<Vote[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedLevel, setSelectedLevel] = useState("");

  const options: LevelOption[] = ([
    districts.council != null
      ? { label: `City Council ${districts.council}`, level: "city" as const, district: districts.council }
      : null,
    districts.stateSenate != null
      ? { label: `State Senate ${districts.stateSenate}`, level: "state_senate" as const, district: districts.stateSenate }
      : null,
    districts.stateAssembly != null
      ? { label: `State Assembly ${districts.stateAssembly}`, level: "state_assembly" as const, district: districts.stateAssembly }
      : null,
    districts.congressional != null
      ? { label: `Congressional ${districts.congressional}`, level: "federal" as const, district: districts.congressional }
      : null,
  ] as (LevelOption | null)[]).filter((o): o is LevelOption => o !== null);

  const handleLoad = useCallback(
    async (optionIndex: string) => {
      setSelectedLevel(optionIndex);
      if (!optionIndex) return;

      const opt = options[Number(optionIndex)];
      if (!opt) return;

      setLoading(true);
      setError(null);

      try {
        const result = await app.callServerTool({
          name: "get_votes",
          arguments: { district: opt.district ?? undefined, level: opt.level },
        });

        if (result.isError) {
          const msg =
            result.content && Array.isArray(result.content) && result.content.length > 0 && "text" in result.content[0]
              ? (result.content[0] as { text: string }).text
              : "Failed to load votes";
          setError(msg);
          return;
        }

        if (result.content && Array.isArray(result.content) && result.content.length > 0) {
          const first = result.content[0];
          if ("text" in first && typeof first.text === "string") {
            const data = JSON.parse(first.text);
            setVotes(data.votes || []);
            return;
          }
        }

        setError("Unexpected response format");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load votes");
      } finally {
        setLoading(false);
      }
    },
    [app, options],
  );

  const voteBadge = (v: string) => {
    const lower = v.toLowerCase();
    let bg = colors.absent;
    let label = v.toUpperCase();
    if (lower === "yes") {
      bg = colors.yes;
      label = "YES";
    } else if (lower === "no") {
      bg = colors.no;
      label = "NO";
    } else if (lower === "absent" || lower === "not_voting" || lower === "abstain") {
      bg = colors.absent;
      label = lower === "not_voting" ? "N/V" : lower.toUpperCase();
    }
    return (
      <span
        style={{
          background: bg,
          color: "#fff",
          fontSize: 11,
          fontWeight: 700,
          padding: "2px 8px",
          borderRadius: 6,
          lineHeight: "16px",
        }}
      >
        {label}
      </span>
    );
  };

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <select
          value={selectedLevel}
          onChange={(e) => handleLoad(e.target.value)}
          style={{
            padding: "8px 12px",
            fontSize: 14,
            fontFamily: "system-ui, -apple-system, sans-serif",
            background: colors.card,
            color: colors.text,
            border: `1px solid ${colors.border}`,
            borderRadius: 8,
            outline: "none",
            minWidth: 240,
          }}
        >
          <option value="">Select representative...</option>
          {options.map((opt, i) => (
            <option key={opt.level} value={String(i)}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {loading && (
        <div style={{ color: colors.muted, fontSize: 14, padding: "20px 0" }}>
          <span style={{ animation: "pulse 1.5s ease-in-out infinite" }}>Loading...</span>
          <style>{`@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
        </div>
      )}

      {error && <div style={{ color: colors.no, fontSize: 14 }}>{error}</div>}

      {!loading && !error && votes.length === 0 && selectedLevel && (
        <div style={{ color: colors.muted, fontSize: 14 }}>No votes found for this representative.</div>
      )}

      {!loading && votes.length > 0 && (
        <div
          style={{
            background: colors.card,
            border: `1px solid ${colors.border}`,
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13,
            }}
          >
            <thead>
              <tr>
                <th style={thStyle}>Bill</th>
                <th style={{ ...thStyle, textAlign: "center", width: 80 }}>Vote</th>
                <th style={{ ...thStyle, textAlign: "right", width: 100 }}>Date</th>
              </tr>
            </thead>
            <tbody>
              {votes.map((v) => (
                <tr key={v.id}>
                  <td style={tdStyle}>{v.billId}</td>
                  <td style={{ ...tdStyle, textAlign: "center" }}>{voteBadge(v.vote)}</td>
                  <td style={{ ...tdStyle, textAlign: "right", color: colors.muted }}>{v.date}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "10px 14px",
  fontWeight: 600,
  fontSize: 12,
  color: "#888",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  borderBottom: `1px solid #2a2a2a`,
};

const tdStyle: React.CSSProperties = {
  padding: "10px 14px",
  borderBottom: `1px solid #2a2a2a`,
};
