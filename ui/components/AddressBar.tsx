import React, { useState, useCallback } from "react";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { DistrictInfo } from "../shared";
import { colors } from "../shared";

interface AddressBarProps {
  app: App;
  onDistrictsLoaded: (address: string, districts: DistrictInfo) => void;
  initialAddress: string;
}

export function AddressBar({ app, onDistrictsLoaded, initialAddress }: AddressBarProps) {
  const [input, setInput] = useState(initialAddress);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync if parent provides a new initial address
  React.useEffect(() => {
    if (initialAddress && initialAddress !== input) {
      setInput(initialAddress);
    }
    // Only sync when initialAddress changes from parent
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAddress]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = input.trim();
      if (!trimmed) return;

      setLoading(true);
      setError(null);

      try {
        const result = await app.callServerTool({
          name: "lookup_address",
          arguments: { address: trimmed },
        });

        if (result.isError) {
          const msg =
            result.content && Array.isArray(result.content) && result.content.length > 0 && "text" in result.content[0]
              ? (result.content[0] as { text: string }).text
              : "Lookup failed";
          setError(msg);
          return;
        }

        if (result.content && Array.isArray(result.content) && result.content.length > 0) {
          const first = result.content[0];
          if ("text" in first && typeof first.text === "string") {
            const districts: DistrictInfo = JSON.parse(first.text);
            onDistrictsLoaded(trimmed, districts);
            return;
          }
        }

        setError("Unexpected response format");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Lookup failed");
      } finally {
        setLoading(false);
      }
    },
    [app, input, onDistrictsLoaded],
  );

  return (
    <div>
      <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8 }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Enter NYC address, e.g. 350 5th Ave, New York, NY"
          disabled={loading}
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
        <button
          type="submit"
          disabled={loading || !input.trim()}
          style={{
            padding: "8px 16px",
            fontSize: 14,
            fontFamily: "system-ui, -apple-system, sans-serif",
            fontWeight: 600,
            background: colors.accent,
            color: "#fff",
            border: "none",
            borderRadius: 8,
            cursor: loading || !input.trim() ? "not-allowed" : "pointer",
            opacity: loading || !input.trim() ? 0.5 : 1,
            minWidth: 44,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {loading ? <Spinner /> : "\uD83D\uDD0D"}
        </button>
      </form>
      {error && (
        <div style={{ color: colors.no, fontSize: 13, marginTop: 6 }}>{error}</div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <span
      style={{
        display: "inline-block",
        width: 16,
        height: 16,
        border: "2px solid rgba(255,255,255,0.3)",
        borderTopColor: "#fff",
        borderRadius: "50%",
        animation: "spin 0.6s linear infinite",
      }}
    >
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </span>
  );
}
