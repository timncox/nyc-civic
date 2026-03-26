import React, { useState, useEffect } from "react";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { DistrictInfo } from "../mcp-app";
import { colors } from "../mcp-app";

interface Rep {
  id: string;
  level: string;
  district: string;
  name: string;
  party: string | null;
  profile: {
    title?: string;
    photoUrl?: string;
    email?: string;
    phone?: string;
    office?: string;
    website?: string;
    socialMedia?: { twitter?: string; facebook?: string; instagram?: string };
    committees?: string[];
    termStart?: string;
    termEnd?: string;
  };
}

interface RepsTabProps {
  app: App;
  address: string;
  districts: DistrictInfo;
}

const levelLabels: Record<string, string> = {
  city: "City Council",
  state_senate: "State Senate",
  state_assembly: "State Assembly",
  federal_house: "US House",
  federal_senate: "US Senate",
};

const levelOrder = ["city", "state_senate", "state_assembly", "federal_house", "federal_senate"];

export function RepsTab({ app, address, districts }: RepsTabProps) {
  const [reps, setReps] = useState<Rep[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const result = await app.callServerTool({
          name: "get_reps",
          arguments: { address, level: "all" },
        });

        if (cancelled) return;

        if (result.isError) {
          const msg =
            result.content && Array.isArray(result.content) && result.content.length > 0 && "text" in result.content[0]
              ? (result.content[0] as { text: string }).text
              : "Failed to load representatives";
          setError(msg);
          return;
        }

        if (result.content && Array.isArray(result.content) && result.content.length > 0) {
          const first = result.content[0];
          if ("text" in first && typeof first.text === "string") {
            const data = JSON.parse(first.text);
            setReps(data.reps || []);
            return;
          }
        }

        setError("Unexpected response format");
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load representatives");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [app, address, districts]);

  if (loading) return <LoadingPulse />;
  if (error) return <div style={{ color: colors.no, fontSize: 14 }}>{error}</div>;
  if (reps.length === 0) {
    return <div style={{ color: colors.muted, fontSize: 14 }}>No representatives found.</div>;
  }

  // Group by level
  const grouped = new Map<string, Rep[]>();
  for (const rep of reps) {
    const list = grouped.get(rep.level) || [];
    list.push(rep);
    grouped.set(rep.level, list);
  }

  const sortedLevels = [...grouped.keys()].sort(
    (a, b) => levelOrder.indexOf(a) - levelOrder.indexOf(b),
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {sortedLevels.map((level) => (
        <div key={level}>
          <h3
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: colors.muted,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              margin: "0 0 10px",
            }}
          >
            {levelLabels[level] || level}
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {grouped.get(level)!.map((rep) => (
              <RepCard key={rep.id} rep={rep} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function RepCard({ rep }: { rep: Rep }) {
  const partyColor =
    rep.party?.startsWith("D") ? colors.demBlue : rep.party?.startsWith("R") ? colors.repRed : colors.muted;
  const partyLabel = rep.party?.startsWith("D") ? "D" : rep.party?.startsWith("R") ? "R" : rep.party || "?";

  return (
    <div
      style={{
        background: colors.card,
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        padding: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <span style={{ fontSize: 16, fontWeight: 600 }}>{rep.name}</span>
        <span
          style={{
            background: partyColor,
            color: "#fff",
            fontSize: 11,
            fontWeight: 700,
            padding: "2px 7px",
            borderRadius: 6,
            lineHeight: "16px",
          }}
        >
          {partyLabel}
        </span>
        <span style={{ fontSize: 13, color: colors.muted, marginLeft: "auto" }}>
          District {rep.district}
        </span>
      </div>

      {rep.profile.title && (
        <div style={{ fontSize: 13, color: colors.muted, marginBottom: 6 }}>{rep.profile.title}</div>
      )}

      {rep.profile.committees && rep.profile.committees.length > 0 && (
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 6 }}>
          <span style={{ fontWeight: 600 }}>Committees:</span>{" "}
          {rep.profile.committees.join(", ")}
        </div>
      )}

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, color: colors.muted }}>
        {rep.profile.email && <span>{rep.profile.email}</span>}
        {rep.profile.phone && <span>{rep.profile.phone}</span>}
        {rep.profile.office && <span>{rep.profile.office}</span>}
      </div>
    </div>
  );
}

function LoadingPulse() {
  return (
    <div style={{ color: colors.muted, fontSize: 14, padding: "20px 0" }}>
      <span style={{ animation: "pulse 1.5s ease-in-out infinite" }}>Loading...</span>
      <style>{`@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
    </div>
  );
}
