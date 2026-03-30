import React, { useState, useEffect } from "react";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { DistrictInfo } from "../mcp-app";
import { colors } from "../mcp-app";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Complaint311 { date: string; type: string; descriptor: string; status: string; address: string; agency: string; }
interface CrimeIncident { date: string; offense: string; description: string; level: string; location: string; }
interface Restaurant { name: string; cuisine: string; address: string; grade: string | null; score: number | null; inspectionDate: string; violations: string[]; critical: boolean; }
interface PropertyInfo { bbl: string; address: string; ownerName: string; zoning: string; buildingClass: string; yearBuilt: number | null; numFloors: number | null; numUnits: number | null; marketValue: number | null; }
interface StreetTree { species: string; diameter: number | null; health: string; }

interface SectionData {
  complaints?: Complaint311[];
  crime?: CrimeIncident[];
  restaurants?: Restaurant[];
  property?: PropertyInfo[];
  trees?: StreetTree[];
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface NeighborhoodTabProps {
  app: App;
  districts: DistrictInfo;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NeighborhoodTab({ app, districts }: NeighborhoodTabProps) {
  const [data, setData] = useState<SectionData>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<string | null>("complaints");

  const lat = districts.lat;
  const lng = districts.lng;

  useEffect(() => {
    if (lat == null || lng == null) return;

    // Load all sections in parallel
    const sections: Array<{ key: string; toolName: string; args: Record<string, unknown>; extract: (d: any) => any }> = [
      { key: "complaints", toolName: "get_311", args: { lat, lng, days_back: 30, limit: 20 }, extract: d => d.complaints },
      { key: "crime", toolName: "get_crime", args: { lat, lng, days_back: 90, limit: 20 }, extract: d => d.incidents },
      { key: "restaurants", toolName: "get_restaurants", args: { lat, lng, radius_meters: 200, limit: 20 }, extract: d => d.restaurants },
      { key: "property", toolName: "get_property", args: { lat, lng }, extract: d => d.properties },
      { key: "trees", toolName: "get_street_trees", args: { lat, lng, radius_meters: 150 }, extract: d => d.trees },
    ];

    for (const section of sections) {
      setLoading(prev => ({ ...prev, [section.key]: true }));
      app.callServerTool({ name: section.toolName, arguments: section.args })
        .then(result => {
          if (result.content && Array.isArray(result.content) && result.content.length > 0) {
            const first = result.content[0];
            if ("text" in first && typeof first.text === "string") {
              const parsed = JSON.parse(first.text);
              setData(prev => ({ ...prev, [section.key]: section.extract(parsed) }));
            }
          }
        })
        .catch(err => {
          setErrors(prev => ({ ...prev, [section.key]: err instanceof Error ? err.message : String(err) }));
        })
        .finally(() => {
          setLoading(prev => ({ ...prev, [section.key]: false }));
        });
    }
  }, [app, lat, lng]);

  if (lat == null || lng == null) {
    return <div style={{ color: colors.muted, fontSize: 13, padding: "20px 0", textAlign: "center" }}>
      Address coordinates not available. Try re-entering the address.
    </div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* 311 Complaints */}
      <CollapsibleSection
        title="311 Complaints"
        subtitle="Last 30 days"
        count={data.complaints?.length}
        loading={loading.complaints}
        error={errors.complaints}
        expanded={expanded === "complaints"}
        onToggle={() => setExpanded(expanded === "complaints" ? null : "complaints")}
        color="#f59e0b"
      >
        {data.complaints && data.complaints.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {data.complaints.map((c, i) => (
              <div key={i} style={rowStyle}>
                <span style={{ color: colors.muted, fontSize: 11, minWidth: 70 }}>{c.date}</span>
                <Badge text={c.type} color={complaintColor(c.type)} />
                <span style={{ flex: 1, fontSize: 12 }}>{c.descriptor}</span>
                <StatusBadge status={c.status} />
              </div>
            ))}
          </div>
        ) : !loading.complaints && <EmptyState text="No 311 complaints in the last 30 days" />}
      </CollapsibleSection>

      {/* Crime */}
      <CollapsibleSection
        title="Crime"
        subtitle="Last 90 days"
        count={data.crime?.length}
        loading={loading.crime}
        error={errors.crime}
        expanded={expanded === "crime"}
        onToggle={() => setExpanded(expanded === "crime" ? null : "crime")}
        color="#ef4444"
      >
        {data.crime && data.crime.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {data.crime.map((c, i) => (
              <div key={i} style={rowStyle}>
                <span style={{ color: colors.muted, fontSize: 11, minWidth: 70 }}>{c.date}</span>
                <Badge text={c.level} color={crimeColor(c.level)} />
                <span style={{ flex: 1, fontSize: 12 }}>{c.description || c.offense}</span>
                {c.location && <span style={{ color: colors.muted, fontSize: 11 }}>{c.location}</span>}
              </div>
            ))}
          </div>
        ) : !loading.crime && <EmptyState text="No reported incidents in the last 90 days" />}
      </CollapsibleSection>

      {/* Restaurants */}
      <CollapsibleSection
        title="Restaurant Grades"
        subtitle="Nearby"
        count={data.restaurants?.length}
        loading={loading.restaurants}
        error={errors.restaurants}
        expanded={expanded === "restaurants"}
        onToggle={() => setExpanded(expanded === "restaurants" ? null : "restaurants")}
        color="#22c55e"
      >
        {data.restaurants && data.restaurants.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {data.restaurants.map((r, i) => (
              <div key={i} style={{ ...rowStyle, flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
                  <GradeBadge grade={r.grade} />
                  <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{r.name}</span>
                  <span style={{ color: colors.muted, fontSize: 11 }}>{r.cuisine}</span>
                </div>
                {r.critical && r.violations.length > 0 && (
                  <div style={{ fontSize: 11, color: colors.no, paddingLeft: 34 }}>
                    {r.violations[0].slice(0, 80)}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : !loading.restaurants && <EmptyState text="No restaurants found nearby" />}
      </CollapsibleSection>

      {/* Property */}
      <CollapsibleSection
        title="Property"
        subtitle="Zoning & ownership"
        count={data.property?.length}
        loading={loading.property}
        error={errors.property}
        expanded={expanded === "property"}
        onToggle={() => setExpanded(expanded === "property" ? null : "property")}
        color="#8b5cf6"
      >
        {data.property && data.property.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {data.property.map((p, i) => (
              <div key={i} style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: 6, padding: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{p.address}</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 12px", fontSize: 12 }}>
                  <Detail label="Owner" value={p.ownerName} />
                  <Detail label="Zoning" value={p.zoning} />
                  <Detail label="Built" value={p.yearBuilt ? String(p.yearBuilt) : "—"} />
                  <Detail label="Floors" value={p.numFloors ? String(p.numFloors) : "—"} />
                  <Detail label="Units" value={p.numUnits ? String(p.numUnits) : "—"} />
                  <Detail label="Market Value" value={p.marketValue ? `$${p.marketValue.toLocaleString()}` : "—"} />
                </div>
              </div>
            ))}
          </div>
        ) : !loading.property && <EmptyState text="No property data found" />}
      </CollapsibleSection>

      {/* Street Trees */}
      <CollapsibleSection
        title="Street Trees"
        subtitle="Nearby"
        count={data.trees?.length}
        loading={loading.trees}
        error={errors.trees}
        expanded={expanded === "trees"}
        onToggle={() => setExpanded(expanded === "trees" ? null : "trees")}
        color="#16a34a"
      >
        {data.trees && data.trees.length > 0 ? (() => {
          // Aggregate by species
          const speciesCounts = new Map<string, { count: number; health: Record<string, number>; avgDiameter: number; totalDiameter: number }>();
          for (const t of data.trees!) {
            const existing = speciesCounts.get(t.species) || { count: 0, health: {}, avgDiameter: 0, totalDiameter: 0 };
            existing.count++;
            existing.health[t.health] = (existing.health[t.health] || 0) + 1;
            existing.totalDiameter += t.diameter ?? 0;
            existing.avgDiameter = existing.totalDiameter / existing.count;
            speciesCounts.set(t.species, existing);
          }
          const sorted = [...speciesCounts.entries()].sort((a, b) => b[1].count - a[1].count);
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {sorted.map(([species, info]) => (
                <div key={species} style={rowStyle}>
                  <span style={{ flex: 1, fontSize: 12, fontWeight: 500 }}>{species}</span>
                  <span style={{ color: colors.muted, fontSize: 11 }}>{info.count} trees</span>
                  <span style={{ color: colors.muted, fontSize: 11 }}>avg {Math.round(info.avgDiameter)}" dia</span>
                  <HealthDots health={info.health} />
                </div>
              ))}
            </div>
          );
        })() : !loading.trees && <EmptyState text="No street tree data" />}
      </CollapsibleSection>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function CollapsibleSection({
  title, subtitle, count, loading, error, expanded, onToggle, color, children,
}: {
  title: string; subtitle: string; count?: number; loading?: boolean; error?: string;
  expanded: boolean; onToggle: () => void; color: string; children: React.ReactNode;
}) {
  return (
    <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: 8, overflow: "hidden" }}>
      <button
        onClick={onToggle}
        style={{
          display: "flex", alignItems: "center", gap: 10, width: "100%",
          padding: "10px 14px", background: "none", border: "none",
          color: colors.text, cursor: "pointer", fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1, textAlign: "left" }}>{title}</span>
        <span style={{ fontSize: 11, color: colors.muted }}>{subtitle}</span>
        {loading && <Spinner />}
        {!loading && count != null && (
          <span style={{
            fontSize: 11, fontWeight: 700, color: count > 0 ? colors.text : colors.muted,
            background: count > 0 ? `${color}22` : "transparent",
            padding: "1px 6px", borderRadius: 4,
          }}>
            {count}
          </span>
        )}
        <span style={{ fontSize: 10, color: colors.muted, transition: "transform 0.15s", transform: expanded ? "rotate(180deg)" : "none" }}>
          ▼
        </span>
      </button>
      {expanded && (
        <div style={{ padding: "0 14px 12px", borderTop: `1px solid ${colors.border}` }}>
          {error ? <div style={{ color: colors.no, fontSize: 12, padding: "8px 0" }}>{error}</div> : (
            <div style={{ paddingTop: 8 }}>{children}</div>
          )}
        </div>
      )}
    </div>
  );
}

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 4,
      background: `${color}22`, color, textTransform: "uppercase", whiteSpace: "nowrap",
    }}>
      {text}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const lower = status.toLowerCase();
  const color = lower.includes("closed") ? colors.yes : lower.includes("progress") ? "#f59e0b" : colors.muted;
  return <span style={{ fontSize: 10, color, fontWeight: 600 }}>{status}</span>;
}

function GradeBadge({ grade }: { grade: string | null }) {
  const gradeColors: Record<string, string> = {
    A: "#22c55e", B: "#f59e0b", C: "#ef4444", Z: "#6b7280", P: "#3b82f6",
  };
  const bg = gradeColors[grade ?? ""] ?? colors.muted;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: 22, height: 22, borderRadius: 4, fontSize: 12, fontWeight: 800,
      background: bg, color: "#fff",
    }}>
      {grade || "?"}
    </span>
  );
}

function HealthDots({ health }: { health: Record<string, number> }) {
  const healthColors: Record<string, string> = { Good: "#22c55e", Fair: "#f59e0b", Poor: "#ef4444" };
  return (
    <div style={{ display: "flex", gap: 2 }}>
      {Object.entries(health).map(([h, count]) => (
        <span key={h} title={`${h}: ${count}`} style={{
          width: 8, height: 8, borderRadius: "50%",
          background: healthColors[h] || colors.muted,
          border: `1px solid ${colors.border}`,
        }} />
      ))}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span style={{ color: colors.muted }}>{label}: </span>
      <span style={{ color: colors.text }}>{value}</span>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div style={{ color: colors.muted, fontSize: 12, padding: "8px 0" }}>{text}</div>;
}

function Spinner() {
  return (
    <>
      <span style={{ fontSize: 11, color: colors.muted, animation: "pulse 1.5s ease-in-out infinite" }}>...</span>
      <style>{`@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>
    </>
  );
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "5px 0",
  borderBottom: `1px solid ${colors.border}`,
  fontSize: 12,
};

function complaintColor(type: string): string {
  const lower = type.toLowerCase();
  if (lower.includes("noise")) return "#8b5cf6";
  if (lower.includes("street") || lower.includes("pothole")) return "#f59e0b";
  if (lower.includes("sanit") || lower.includes("trash")) return "#6b7280";
  if (lower.includes("heat") || lower.includes("water")) return "#ef4444";
  if (lower.includes("park") || lower.includes("tree")) return "#22c55e";
  return "#3b82f6";
}

function crimeColor(level: string): string {
  const lower = level.toLowerCase();
  if (lower.includes("felony")) return "#ef4444";
  if (lower.includes("misdemeanor")) return "#f59e0b";
  return "#6b7280";
}
