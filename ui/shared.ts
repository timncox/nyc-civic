// Shared types and design tokens — extracted to break circular dependency
// between mcp-app.tsx and tab components.

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

export const colors = {
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

export const fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
