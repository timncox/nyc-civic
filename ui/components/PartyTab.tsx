import React, { useState, useEffect } from "react";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { DistrictInfo } from "../mcp-app";
import { colors } from "../mcp-app";

interface PartyOrg {
  id: string;
  borough: string;
  role: string;
  name: string;
  assemblyDistrict: number | null;
  electionDistrict: number | null;
  details: Record<string, unknown>;
}

interface PartyResult {
  leadership: PartyOrg[];
  districtLeaders: PartyOrg[];
  countyCommittee: PartyOrg[];
  meetings?: Array<{ date: string; location?: string; description?: string }>;
  getInvolved?: string;
}

interface PartyTabProps {
  app: App;
  address: string;
  districts: DistrictInfo;
}

export function PartyTab({ app, address, districts }: PartyTabProps) {
  const [data, setData] = useState<PartyResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const args: Record<string, unknown> = {};
        if (address) args.address = address;
        if (districts.borough) args.borough = districts.borough;
        if (districts.stateAssembly) args.assembly_district = districts.stateAssembly;
        if (districts.electionDistrict) args.election_district = districts.electionDistrict;

        const result = await app.callServerTool({
          name: "get_dem_party",
          arguments: args,
        });

        if (cancelled) return;

        if (result.isError) {
          const msg =
            result.content && Array.isArray(result.content) && result.content.length > 0 && "text" in result.content[0]
              ? (result.content[0] as { text: string }).text
              : "Failed to load party data";
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
          setError(err instanceof Error ? err.message : "Failed to load party data");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [app, address, districts]);

  if (loading) {
    return (
      <div style={{ color: colors.muted, fontSize: 14, padding: "20px 0" }}>
        <span style={{ animation: "pulse 1.5s ease-in-out infinite" }}>Loading...</span>
        <style>{`@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
      </div>
    );
  }

  if (error) return <div style={{ color: colors.no, fontSize: 14 }}>{error}</div>;
  if (!data) return <div style={{ color: colors.muted, fontSize: 14 }}>No party data available.</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Borough Leadership */}
      {data.leadership && data.leadership.length > 0 && (
        <Section title="Borough Leadership">
          {data.leadership.map((org) => (
            <OrgCard key={org.id} org={org} />
          ))}
        </Section>
      )}

      {/* District Leaders */}
      {data.districtLeaders && data.districtLeaders.length > 0 && (
        <Section title="District Leaders">
          {data.districtLeaders.map((org) => (
            <OrgCard key={org.id} org={org} />
          ))}
        </Section>
      )}

      {/* County Committee */}
      {data.countyCommittee && data.countyCommittee.length > 0 && (
        <Section title="County Committee">
          {data.countyCommittee.map((org) => (
            <OrgCard key={org.id} org={org} />
          ))}
        </Section>
      )}

      {/* Meetings */}
      {data.meetings && data.meetings.length > 0 && (
        <Section title="Meetings">
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
        </Section>
      )}

      {/* Get Involved */}
      {data.getInvolved && (
        <Section title="Get Involved">
          <div
            style={{
              background: colors.card,
              border: `1px solid ${colors.border}`,
              borderRadius: 8,
              padding: 14,
              fontSize: 14,
              lineHeight: 1.6,
              color: colors.text,
            }}
          >
            {data.getInvolved}
          </div>
        </Section>
      )}

      {/* Empty state */}
      {data.leadership.length === 0 &&
        data.districtLeaders.length === 0 &&
        data.countyCommittee.length === 0 && (
          <div style={{ color: colors.muted, fontSize: 14 }}>
            No Democratic Party organization data found for this area.
          </div>
        )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
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
        {title}
      </h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{children}</div>
    </div>
  );
}

function OrgCard({ org }: { org: PartyOrg }) {
  const roleBadge = (role: string) => {
    const roleColors: Record<string, string> = {
      chair: colors.demBlue,
      vice_chair: "#6366f1",
      district_leader: "#8b5cf6",
      county_committee: "#a855f7",
      executive_committee: "#7c3aed",
    };
    return (
      <span
        style={{
          background: roleColors[role] || colors.muted,
          color: "#fff",
          fontSize: 10,
          fontWeight: 700,
          padding: "2px 6px",
          borderRadius: 6,
          textTransform: "uppercase",
          lineHeight: "14px",
        }}
      >
        {role.replace(/_/g, " ")}
      </span>
    );
  };

  return (
    <div
      style={{
        background: colors.card,
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        padding: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{org.name}</span>
        {roleBadge(org.role)}
      </div>
      <div style={{ fontSize: 12, color: colors.muted }}>
        {org.borough}
        {org.assemblyDistrict != null && ` \u00B7 AD ${org.assemblyDistrict}`}
        {org.electionDistrict != null && ` \u00B7 ED ${org.electionDistrict}`}
      </div>
    </div>
  );
}
