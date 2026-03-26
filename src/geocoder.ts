import { createHash } from "crypto";
import type { DistrictInfo } from "./types.js";
import { getDb, persistDb } from "./db.js";
import { isStale } from "./cache.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic hash for caching an address string. */
export function hashAddress(address: string): string {
  const normalized = address.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex");
}

/** Build an empty DistrictInfo with all fields null. */
function emptyDistrict(): DistrictInfo {
  return {
    council: null,
    communityBoard: null,
    stateSenate: null,
    stateAssembly: null,
    congressional: null,
    electionDistrict: null,
    borough: null,
    lat: null,
    lng: null,
  };
}

/**
 * Safely parse a value as a number. Returns null when the input is
 * undefined, null, NaN, or not coercible.
 */
function safeNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Step 1 — NYC GeoSearch (lat/lng + BBL)
// ---------------------------------------------------------------------------

interface GeoSearchResult {
  lat: number | null;
  lng: number | null;
  bbl: string | null;
  borough: string | null;
}

async function geoSearch(address: string): Promise<GeoSearchResult> {
  const url = `https://geosearch.planninglabs.nyc/v2/search?text=${encodeURIComponent(address)}`;
  const res = await fetch(url);
  if (!res.ok) return { lat: null, lng: null, bbl: null, borough: null };

  const json = (await res.json()) as {
    features?: Array<{
      geometry?: { coordinates?: [number, number] };
      properties?: {
        borough?: string;
        addendum?: { pad?: { bbl?: string } };
      };
    }>;
  };

  const feat = json.features?.[0];
  if (!feat) return { lat: null, lng: null, bbl: null, borough: null };

  const [lng, lat] = feat.geometry?.coordinates ?? [null, null];
  const bbl = feat.properties?.addendum?.pad?.bbl ?? null;
  const borough = feat.properties?.borough ?? null;

  return {
    lat: lat != null && Number.isFinite(lat) ? lat : null,
    lng: lng != null && Number.isFinite(lng) ? lng : null,
    bbl: bbl ?? null,
    borough: borough ?? null,
  };
}

// ---------------------------------------------------------------------------
// Step 2 — NYC PLUTO via Socrata (council district, community district, …)
// ---------------------------------------------------------------------------

interface PlutoResult {
  council: number | null;
  communityBoard: string | null;
}

async function plutoLookup(bbl: string): Promise<PlutoResult> {
  const url = `https://data.cityofnewyork.us/resource/64uk-42ks.json?$where=bbl=${encodeURIComponent(bbl)}&$limit=1`;
  const res = await fetch(url);
  if (!res.ok) return { council: null, communityBoard: null };

  const rows = (await res.json()) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return { council: null, communityBoard: null };

  return {
    council: safeNum(row.council),
    communityBoard: row.cd != null ? String(row.cd) : null,
  };
}

// ---------------------------------------------------------------------------
// Step 3 — US Census Geocoder (congressional, state senate, assembly)
// ---------------------------------------------------------------------------

interface CensusResult {
  congressional: number | null;
  stateSenate: number | null;
  stateAssembly: number | null;
}

/**
 * Parse the raw address string into street / city / state components.
 * Expects a comma-separated format like "123 Main St, New York, NY" or
 * at minimum "123 Main St, New York, NY 10001".  Falls back gracefully.
 */
function parseAddressParts(address: string): {
  street: string;
  city: string;
  state: string;
} {
  const parts = address.split(",").map((s) => s.trim());
  const street = parts[0] ?? address;
  const city = parts[1] ?? "New York";
  // The state may include a zip — strip it.
  const stateRaw = parts[2] ?? "NY";
  const state = stateRaw.replace(/\d{5}(-\d{4})?/, "").trim() || "NY";
  return { street, city, state };
}

async function censusLookup(address: string): Promise<CensusResult> {
  const { street, city, state } = parseAddressParts(address);
  const params = new URLSearchParams({
    street,
    city,
    state,
    benchmark: "Public_AR_Current",
    vintage: "Current_Current",
    layers: "all",
    format: "json",
  });
  const url = `https://geocoding.geo.census.gov/geocoder/geographies/address?${params}`;

  console.error("[nyc-civic] Census URL:", url);
  let json: any;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    console.error("[nyc-civic] Census status:", res.status);
    if (!res.ok) return { congressional: null, stateSenate: null, stateAssembly: null };
    json = await res.json();
    console.error("[nyc-civic] Census matches:", json?.result?.addressMatches?.length ?? 0);
  } catch (fetchErr: any) {
    console.error("[nyc-civic] Census fetch error:", fetchErr?.message ?? fetchErr);
    return { congressional: null, stateSenate: null, stateAssembly: null };
  }

  const geographies = json.result?.addressMatches?.[0]?.geographies;
  if (!geographies) return { congressional: null, stateSenate: null, stateAssembly: null };

  // Census API key names change with redistricting cycles — match flexibly
  const congressKey = Object.keys(geographies).find(k => k.includes("Congressional District"));
  const senateKey = Object.keys(geographies).find(k => k.includes("Legislative Districts - Upper"));
  const assemblyKey = Object.keys(geographies).find(k => k.includes("Legislative Districts - Lower"));

  const congress = congressKey ? geographies[congressKey]?.[0] : undefined;
  const senateArr = senateKey ? geographies[senateKey]?.[0] : undefined;
  const assemblyArr = assemblyKey ? geographies[assemblyKey]?.[0] : undefined;

  return {
    congressional: safeNum(congress?.GEOID?.toString().slice(-2)) ?? safeNum(congress?.CD119FP),
    stateSenate: safeNum(senateArr?.GEOID?.toString().slice(-3)) ?? safeNum(senateArr?.SLDUST),
    stateAssembly: safeNum(assemblyArr?.GEOID?.toString().slice(-3)) ?? safeNum(assemblyArr?.SLDLST),
  };
}

// ---------------------------------------------------------------------------
// lookupAddress — the full pipeline (never throws)
// ---------------------------------------------------------------------------

/**
 * Geocode a street address into all political districts by calling three
 * keyless REST APIs in sequence (GeoSearch → PLUTO → Census).
 *
 * Never throws — returns a DistrictInfo with nulls for any data that
 * could not be resolved.
 */
export async function lookupAddress(address: string): Promise<DistrictInfo> {
  const info = emptyDistrict();

  // Run GeoSearch and Census in parallel — they're independent
  const [geoResult, censusResult] = await Promise.allSettled([
    geoSearch(address),
    censusLookup(address),
  ]);

  // Apply GeoSearch results
  if (geoResult.status === "fulfilled") {
    const geo = geoResult.value;
    info.lat = geo.lat;
    info.lng = geo.lng;
    info.borough = geo.borough;

    // PLUTO requires BBL from GeoSearch
    if (geo.bbl) {
      try {
        const pluto = await plutoLookup(geo.bbl);
        info.council = pluto.council;
        info.communityBoard = pluto.communityBoard;
      } catch {
        // PLUTO failed — continue with what we have
      }
    }
  }

  // Apply Census results
  console.error("[nyc-civic] Census result status:", censusResult.status);
  if (censusResult.status === "fulfilled") {
    console.error("[nyc-civic] Census values:", JSON.stringify(censusResult.value));
    info.congressional = censusResult.value.congressional;
    info.stateSenate = censusResult.value.stateSenate;
    info.stateAssembly = censusResult.value.stateAssembly;
  } else {
    console.error("[nyc-civic] Census lookup rejected:", censusResult.reason);
  }

  return info;
}

// ---------------------------------------------------------------------------
// resolveAddress — cache-aware wrapper
// ---------------------------------------------------------------------------

/**
 * Resolve an address to districts, checking the SQLite cache first.
 *
 * 1. If the districts table contains a fresh row for this address hash,
 *    return it immediately.
 * 2. Otherwise, call lookupAddress and persist the result.
 *
 * Never throws.
 */
export async function resolveAddress(address: string): Promise<DistrictInfo> {
  const hash = hashAddress(address);

  try {
    const db = await getDb();

    // Check cache
    const stmt = db.prepare(
      "SELECT * FROM districts WHERE address_hash = :hash LIMIT 1"
    );
    stmt.bind({ ":hash": hash });

    if (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      stmt.free();

      const cachedAt = Number(row.cached_at ?? 0);
      if (!isStale(cachedAt, "districts")) {
        return {
          council: safeNum(row.council),
          communityBoard: row.community_board != null ? String(row.community_board) : null,
          stateSenate: safeNum(row.state_senate),
          stateAssembly: safeNum(row.state_assembly),
          congressional: safeNum(row.congressional),
          electionDistrict: safeNum(row.election_district),
          borough: row.borough != null ? String(row.borough) : null,
          lat: safeNum(row.lat),
          lng: safeNum(row.lng),
        };
      }
    } else {
      stmt.free();
    }
  } catch {
    // DB read failed — fall through to live lookup
  }

  // Cache miss or stale — perform live lookup
  const info = await lookupAddress(address);

  // Persist to cache
  try {
    const db = await getDb();
    db.run(
      `INSERT OR REPLACE INTO districts
        (address_hash, address_raw, council, community_board, state_senate,
         state_assembly, congressional, election_district, borough, lat, lng, cached_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        hash,
        address,
        info.council,
        info.communityBoard,
        info.stateSenate,
        info.stateAssembly,
        info.congressional,
        info.electionDistrict,
        info.borough,
        info.lat,
        info.lng,
        Date.now(),
      ]
    );
    persistDb();
  } catch {
    // Persist failed — non-fatal, the lookup result is still valid
  }

  return info;
}
