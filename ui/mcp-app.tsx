import React, { useState, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@modelcontextprotocol/ext-apps";
import { AddressBar } from "./components/AddressBar";
import { RepsTab } from "./components/RepsTab";
import { VotesTab } from "./components/VotesTab";
import { BillsTab } from "./components/BillsTab";
import { PartyTab } from "./components/PartyTab";
import { CommunityBoardTab } from "./components/CommunityBoardTab";
import { NeighborhoodTab } from "./components/NeighborhoodTab";

// ── Types ──────────────────────────────────────────────────────────────
export interface DistrictInfo {
  council: number | null;
  communityBoard: string | null;
  stateSenate: number | null;
  stateAssembly: number | null;
  congressional: number | null;
  electionDistrict: number | null;
  borough: string | null;
  lat: number | null;
  lng: number | null;
}

// ── App instance (module-level singleton) ──────────────────────────────
const app = new App(
  { name: "NYC Civic Tracker", version: "1.0.0" },
  {},
  { autoResize: true },
);

// ── Design tokens ──────────────────────────────────────────────────────
const colors = {
  bg: "#0a0a0a",
  card: "#1a1a1a",
  border: "#2a2a2a",
  text: "#e5e5e5",
  muted: "#888",
  accent: "#3b82f6",
  demBlue: "#2563eb",
  repRed: "#dc2626",
  yes: "#22c55e",
  no: "#ef4444",
  absent: "#6b7280",
};
export { colors };

const fontFamily = "system-ui, -apple-system, sans-serif";

// ── Tab definitions ────────────────────────────────────────────────────
type TabId = "reps" | "votes" | "bills" | "hood" | "party" | "cb";

const tabs: { id: TabId; label: string }[] = [
  { id: "reps", label: "Reps" },
  { id: "votes", label: "Votes" },
  { id: "bills", label: "Bills" },
  { id: "hood", label: "Neighborhood" },
  { id: "party", label: "Party" },
  { id: "cb", label: "CB" },
];

// ── Dashboard component ────────────────────────────────────────────────
function Dashboard() {
  const [address, setAddress] = useState<string>("");
  const [districts, setDistricts] = useState<DistrictInfo | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("reps");

  // Listen for initial tool result from host (civic_dashboard)
  useEffect(() => {
    // Receive tool input (the address passed to civic_dashboard)
    app.ontoolinput = (params: any) => {
      try {
        const addr = params?.arguments?.address || params?.address;
        if (addr) setAddress(addr);
      } catch { /* ignore */ }
    };

    // Receive tool result (district data from civic_dashboard)
    app.ontoolresult = (params: any) => {
      try {
        if (params.content && Array.isArray(params.content) && params.content.length > 0) {
          const first = params.content[0];
          if ("text" in first && typeof first.text === "string") {
            const data = JSON.parse(first.text);
            if (data.address) setAddress(data.address);
            if (data.districts) {
              setDistricts(data.districts);
              setActiveTab("reps");
            }
          }
        }
      } catch {
        // ignore parse errors from initial result
      }
    };

    app.connect().then(() => {
      // Request a tall display mode so the dashboard isn't cramped
      try { app.sendSizeChanged({ width: 800, height: 700 }); } catch { /* ignore if not supported */ }
    }).catch((err) => {
      console.error("Failed to connect MCP App:", err);
    });
  }, []);

  const handleDistrictsLoaded = useCallback(
    (addr: string, d: DistrictInfo) => {
      setAddress(addr);
      setDistricts(d);
      setActiveTab("reps");
      // Tell host we need more space now
      try { app.sendSizeChanged({ width: 800, height: 800 }); } catch { /* ignore */ }
    },
    [],
  );

  const districtSummary =
    districts &&
    [
      districts.council != null && `Council ${districts.council}`,
      districts.stateSenate != null && `Senate ${districts.stateSenate}`,
      districts.stateAssembly != null && `Assembly ${districts.stateAssembly}`,
      districts.congressional != null && `Congressional ${districts.congressional}`,
      districts.communityBoard && `${districts.borough ?? ""} CB${parseInt(districts.communityBoard.slice(-2), 10)}`,
    ]
      .filter(Boolean)
      .join(" \u00B7 ");

  return (
    <div
      style={{
        background: colors.bg,
        color: colors.text,
        fontFamily,
        minHeight: 400,
        padding: 0,
        margin: 0,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "16px 20px 12px",
          borderBottom: `1px solid ${colors.border}`,
        }}
      >
        <h1
          style={{
            margin: "0 0 12px",
            fontSize: 20,
            fontWeight: 700,
            letterSpacing: "-0.01em",
          }}
        >
          NYC Civic Tracker
        </h1>
        <AddressBar app={app} onDistrictsLoaded={handleDistrictsLoaded} initialAddress={address} />
      </div>

      {/* District summary bar */}
      {districtSummary && (
        <div
          style={{
            padding: "10px 20px",
            fontSize: 13,
            color: colors.muted,
            borderBottom: `1px solid ${colors.border}`,
            letterSpacing: "0.01em",
          }}
        >
          {districtSummary}
        </div>
      )}

      {/* Tabs */}
      <div
        style={{
          display: "flex",
          borderBottom: `1px solid ${colors.border}`,
          padding: "0 12px",
        }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              background: "none",
              border: "none",
              borderBottom: activeTab === tab.id ? `2px solid ${colors.accent}` : "2px solid transparent",
              color: activeTab === tab.id ? colors.text : colors.muted,
              padding: "10px 16px",
              fontSize: 13,
              fontWeight: activeTab === tab.id ? 600 : 400,
              cursor: "pointer",
              fontFamily,
              transition: "color 0.15s, border-color 0.15s",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ padding: "16px 20px" }}>
        {!districts && activeTab !== "bills" && (
          <div style={{ color: colors.muted, fontSize: 14, padding: "40px 0", textAlign: "center" }}>
            Enter an address above to look up your elected representatives and civic data.
          </div>
        )}

        {activeTab === "reps" && districts && <RepsTab app={app} address={address} districts={districts} />}
        {activeTab === "votes" && districts && <VotesTab app={app} districts={districts} />}
        {activeTab === "bills" && <BillsTab app={app} />}
        {activeTab === "hood" && districts && <NeighborhoodTab app={app} districts={districts} />}
        {activeTab === "party" && districts && <PartyTab app={app} address={address} districts={districts} />}
        {activeTab === "cb" && districts && (
          <CommunityBoardTab app={app} district={districts.communityBoard} />
        )}
      </div>
    </div>
  );
}

// ── Mount ──────────────────────────────────────────────────────────────
const root = document.getElementById("root");
if (root) {
  // Reset any default body styles and set min-height for autoResize
  document.body.style.margin = "0";
  document.body.style.padding = "0";
  document.body.style.background = colors.bg;
  document.documentElement.style.minHeight = "700px";
  createRoot(root).render(<Dashboard />);
}
