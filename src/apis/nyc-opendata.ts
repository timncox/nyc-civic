/**
 * NYC Open Data (Socrata) API client.
 *
 * Provides typed access to key NYC datasets for civic engagement.
 * All datasets are free, no auth required (rate limit: ~1000 req/hr without app token).
 *
 * Datasets are queryable by address (lat/lng radius) or by district.
 */

const BASE = "https://data.cityofnewyork.us/resource";
const TIMEOUT = 15_000;

// ---------------------------------------------------------------------------
// Dataset IDs
// ---------------------------------------------------------------------------

const DATASETS = {
  complaints311: "erm2-nwe9",      // 311 Service Requests
  crime: "5uac-w243",              // NYPD Complaint Data Current
  restaurants: "43nn-pn8j",        // Restaurant Inspection Results
  dobPermits: "ipu4-2q9a",        // DOB Permit Issuance
  dobComplaints: "eabe-havv",      // DOB Complaints Received
  dobViolations: "3h2n-5cm9",     // DOB Violations
  hpdViolations: "wvxf-dwi5",     // HPD Violations
  propertyValues: "yjxr-fw8i",    // Property Assessment
  councilFunding: "4d7f-74pe",    // City Council Discretionary Funding
  evictions: "6z8x-wfk4",         // Evictions
  streetTrees: "uvpi-gqnh",       // Street Tree Census
  streetConstruction: "tqtj-sjs8", // Street Construction Permits
  sidewalkCafes: "qcdj-rwhu",     // Sidewalk Cafes
  pluto: "64uk-42ks",             // PLUTO (zoning/land use)
} as const;

// ---------------------------------------------------------------------------
// Generic Socrata query
// ---------------------------------------------------------------------------

async function socrataFetch(
  datasetId: string,
  params: Record<string, string>,
): Promise<unknown[]> {
  const url = new URL(`${BASE}/${datasetId}.json`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k.startsWith("$") ? k : `$${k}`, v);
  }
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`Socrata ${res.status}: ${datasetId}`);
  return res.json() as Promise<unknown[]>;
}

function geoFilter(geoColumn: string, lat: number, lng: number, radiusMeters: number): string {
  return `within_circle(${geoColumn},${lat},${lng},${radiusMeters})`;
}

/** Bounding box filter for datasets that only have separate lat/lng columns */
function bboxFilter(latCol: string, lngCol: string, lat: number, lng: number, radiusMeters: number): string {
  // Approximate: 1 degree latitude ≈ 111,000m, longitude varies by cos(lat)
  const latDelta = radiusMeters / 111000;
  const lngDelta = radiusMeters / (111000 * Math.cos(lat * Math.PI / 180));
  return `${latCol} between '${lat - latDelta}' and '${lat + latDelta}' AND ${lngCol} between '${lng - lngDelta}' and '${lng + lngDelta}'`;
}

// ---------------------------------------------------------------------------
// 311 Complaints
// ---------------------------------------------------------------------------

export interface Complaint311 {
  date: string;
  type: string;
  descriptor: string;
  status: string;
  address: string;
  agency: string;
  resolution: string | null;
}

export async function get311Complaints(
  lat: number, lng: number,
  opts?: { radiusMeters?: number; limit?: number; daysBack?: number },
): Promise<Complaint311[]> {
  const radius = opts?.radiusMeters ?? 500;
  const limit = opts?.limit ?? 50;
  const daysBack = opts?.daysBack ?? 90;
  const since = new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10);

  const data = await socrataFetch(DATASETS.complaints311, {
    $where: `${geoFilter("location", lat, lng, radius)} AND created_date > '${since}'`,
    $order: "created_date DESC",
    $limit: String(limit),
  }) as any[];

  return data.map(r => ({
    date: r.created_date?.slice(0, 10) ?? "",
    type: r.complaint_type ?? "",
    descriptor: r.descriptor ?? "",
    status: r.status ?? "",
    address: [r.incident_address, r.city].filter(Boolean).join(", "),
    agency: r.agency_name ?? r.agency ?? "",
    resolution: r.resolution_description ?? null,
  }));
}

// ---------------------------------------------------------------------------
// NYPD Crime Data
// ---------------------------------------------------------------------------

export interface CrimeIncident {
  date: string;
  offense: string;
  description: string;
  level: string;
  status: string;
  location: string;
  precinct: number | null;
}

export async function getCrimeData(
  lat: number, lng: number,
  opts?: { radiusMeters?: number; limit?: number; daysBack?: number },
): Promise<CrimeIncident[]> {
  const radius = opts?.radiusMeters ?? 500;
  const limit = opts?.limit ?? 50;
  const daysBack = opts?.daysBack ?? 180;
  const since = new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10);

  const data = await socrataFetch(DATASETS.crime, {
    $where: `${geoFilter("lat_lon", lat, lng, radius)} AND cmplnt_fr_dt > '${since}'`,
    $order: "cmplnt_fr_dt DESC",
    $limit: String(limit),
  }) as any[];

  return data.map(r => ({
    date: r.cmplnt_fr_dt?.slice(0, 10) ?? "",
    offense: r.ofns_desc ?? "",
    description: r.pd_desc ?? "",
    level: r.law_cat_cd ?? "",
    status: r.crm_atpt_cptd_cd ?? "",
    location: r.prem_typ_desc ?? "",
    precinct: r.addr_pct_cd ? Number(r.addr_pct_cd) : null,
  }));
}

// ---------------------------------------------------------------------------
// Restaurant Inspections
// ---------------------------------------------------------------------------

export interface RestaurantInspection {
  name: string;
  cuisine: string;
  address: string;
  grade: string | null;
  score: number | null;
  inspectionDate: string;
  violations: string[];
  critical: boolean;
}

export async function getRestaurantInspections(
  lat: number, lng: number,
  opts?: { radiusMeters?: number; limit?: number },
): Promise<RestaurantInspection[]> {
  const radius = opts?.radiusMeters ?? 300;
  const limit = opts?.limit ?? 50;

  const data = await socrataFetch(DATASETS.restaurants, {
    $where: geoFilter("location", lat, lng, radius),
    $order: "inspection_date DESC",
    $limit: String(limit),
  }) as any[];

  // Group by restaurant (camis) and take latest inspection per restaurant
  const byRestaurant = new Map<string, any[]>();
  for (const r of data) {
    const key = r.camis ?? r.dba;
    if (!byRestaurant.has(key)) byRestaurant.set(key, []);
    byRestaurant.get(key)!.push(r);
  }

  const results: RestaurantInspection[] = [];
  for (const [_, records] of byRestaurant) {
    const latest = records[0];
    const violations = records
      .filter(r => r.violation_description)
      .map(r => r.violation_description);

    results.push({
      name: latest.dba ?? "",
      cuisine: latest.cuisine_description ?? "",
      address: [latest.building, latest.street, latest.zipcode].filter(Boolean).join(" "),
      grade: latest.grade ?? null,
      score: latest.score ? Number(latest.score) : null,
      inspectionDate: latest.inspection_date?.slice(0, 10) ?? "",
      violations: [...new Set(violations)],
      critical: records.some(r => r.critical_flag === "Critical"),
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// HPD Housing Violations
// ---------------------------------------------------------------------------

export interface HousingViolation {
  date: string;
  address: string;
  apartment: string | null;
  violationClass: string;
  description: string;
  status: string;
}

export async function getHousingViolations(
  boroId: string,
  houseNumber: string,
  streetName: string,
  opts?: { limit?: number },
): Promise<HousingViolation[]> {
  const limit = opts?.limit ?? 50;

  const data = await socrataFetch(DATASETS.hpdViolations, {
    $where: `boroid='${boroId}' AND upper(streetname) like '%${streetName.toUpperCase()}%' AND housenumber='${houseNumber}'`,
    $order: "inspectiondate DESC",
    $limit: String(limit),
  }) as any[];

  return data.map(r => ({
    date: r.inspectiondate?.slice(0, 10) ?? "",
    address: `${r.housenumber ?? ""} ${r.streetname ?? ""}`.trim(),
    apartment: r.apartment ?? null,
    violationClass: r.class ?? "",
    description: r.novdescription ?? "",
    status: r.currentstatus ?? r.violationstatus ?? "",
  }));
}

// ---------------------------------------------------------------------------
// DOB Building Permits
// ---------------------------------------------------------------------------

export interface BuildingPermit {
  jobNumber: string;
  date: string;
  type: string;
  description: string;
  address: string;
  owner: string;
  status: string;
  estimatedCost: string | null;
}

export async function getBuildingPermits(
  boroCode: string,
  houseNumber: string,
  streetName: string,
  opts?: { limit?: number },
): Promise<BuildingPermit[]> {
  const limit = opts?.limit ?? 30;

  const data = await socrataFetch(DATASETS.dobPermits, {
    $where: `borough='${boroCode}' AND upper(house__) like '%${houseNumber}%' AND upper(street_name) like '%${streetName.toUpperCase()}%'`,
    $order: "issuance_date DESC",
    $limit: String(limit),
  }) as any[];

  return data.map(r => ({
    jobNumber: r.job__ ?? "",
    date: r.issuance_date?.slice(0, 10) ?? "",
    type: r.permit_type ?? "",
    description: r.job_description ?? "",
    address: `${r.house__ ?? ""} ${r.street_name ?? ""}`.trim(),
    owner: r.owner_s_first_name && r.owner_s_last_name
      ? `${r.owner_s_first_name} ${r.owner_s_last_name}` : (r.permittee_s_first_name ?? ""),
    status: r.permit_status ?? "",
    estimatedCost: r.estimated_job_cost ?? null,
  }));
}

// ---------------------------------------------------------------------------
// DOB Complaints
// ---------------------------------------------------------------------------

export interface BuildingComplaint {
  number: string;
  date: string;
  category: string;
  status: string;
  address: string;
  dispositionDate: string | null;
}

export async function getBuildingComplaints(
  houseNumber: string,
  streetName: string,
  opts?: { limit?: number },
): Promise<BuildingComplaint[]> {
  const limit = opts?.limit ?? 30;

  const data = await socrataFetch(DATASETS.dobComplaints, {
    $where: `house_number='${houseNumber}' AND upper(house_street) like '%${streetName.toUpperCase()}%'`,
    $order: "date_entered DESC",
    $limit: String(limit),
  }) as any[];

  return data.map(r => ({
    number: r.complaint_number ?? "",
    date: r.date_entered?.slice(0, 10) ?? "",
    category: r.complaint_category ?? "",
    status: r.status ?? "",
    address: `${r.house_number ?? ""} ${r.house_street ?? ""}`.trim(),
    dispositionDate: r.disposition_date?.slice(0, 10) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Property Data (PLUTO)
// ---------------------------------------------------------------------------

export interface PropertyInfo {
  bbl: string;
  address: string;
  ownerName: string;
  zoning: string;
  landUse: string;
  buildingClass: string;
  yearBuilt: number | null;
  numFloors: number | null;
  numUnits: number | null;
  lotArea: number | null;
  buildingArea: number | null;
  assessedValue: number | null;
  marketValue: number | null;
}

export async function getPropertyInfo(
  lat: number, lng: number,
  opts?: { radiusMeters?: number },
): Promise<PropertyInfo[]> {
  const radius = opts?.radiusMeters ?? 100;

  const data = await socrataFetch(DATASETS.pluto, {
    $where: bboxFilter("latitude", "longitude", lat, lng, radius),
    $limit: "5",
  }) as any[];

  return data.map(r => ({
    bbl: r.bbl ?? "",
    address: r.address ?? "",
    ownerName: r.ownername ?? "",
    zoning: [r.zonedist1, r.zonedist2].filter(Boolean).join(" / "),
    landUse: r.landuse ?? "",
    buildingClass: r.bldgclass ?? "",
    yearBuilt: r.yearbuilt ? Number(r.yearbuilt) : null,
    numFloors: r.numfloors ? Number(r.numfloors) : null,
    numUnits: r.unitstotal ? Number(r.unitstotal) : null,
    lotArea: r.lotarea ? Number(r.lotarea) : null,
    buildingArea: r.bldgarea ? Number(r.bldgarea) : null,
    assessedValue: r.assesstot ? Number(r.assesstot) : null,
    marketValue: r.fullval ? Number(r.fullval) : null,
  }));
}

// ---------------------------------------------------------------------------
// Council Discretionary Funding
// ---------------------------------------------------------------------------

export interface CouncilFunding {
  fiscalYear: string;
  councilMember: string;
  organization: string;
  amount: number;
  purpose: string;
  address: string;
}

export async function getCouncilFunding(
  councilDistrict: number,
  opts?: { limit?: number; fiscalYear?: string },
): Promise<CouncilFunding[]> {
  const limit = opts?.limit ?? 50;
  let where = `council_district='${councilDistrict}'`;
  if (opts?.fiscalYear) where += ` AND fiscal_year='${opts.fiscalYear}'`;

  const data = await socrataFetch(DATASETS.councilFunding, {
    $where: where,
    $order: "amount DESC",
    $limit: String(limit),
  }) as any[];

  return data.map(r => ({
    fiscalYear: r.fiscal_year ?? "",
    councilMember: r.council_member ?? "",
    organization: r.legal_name_of_organization ?? "",
    amount: r.amount ? Number(r.amount) : 0,
    purpose: r.purpose_of_funds ?? "",
    address: [r.address, r.city, r.state, r.postcode].filter(Boolean).join(", "),
  }));
}

// ---------------------------------------------------------------------------
// Evictions
// ---------------------------------------------------------------------------

export interface Eviction {
  date: string;
  address: string;
  apt: string | null;
  marshalName: string;
  status: string;
  borough: string;
}

export async function getEvictions(
  lat: number, lng: number,
  opts?: { radiusMeters?: number; limit?: number; daysBack?: number },
): Promise<Eviction[]> {
  const radius = opts?.radiusMeters ?? 500;
  const limit = opts?.limit ?? 30;
  const daysBack = opts?.daysBack ?? 365;
  const since = new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10);

  const data = await socrataFetch(DATASETS.evictions, {
    $where: `${bboxFilter("latitude", "longitude", lat, lng, radius)} AND executed_date > '${since}'`,
    $order: "executed_date DESC",
    $limit: String(limit),
  }) as any[];

  return data.map(r => ({
    date: r.executed_date?.slice(0, 10) ?? "",
    address: [r.eviction_address, r.eviction_zip].filter(Boolean).join(" "),
    apt: r.eviction_apt_num ?? null,
    marshalName: [r.marshal_first_name, r.marshal_last_name].filter(Boolean).join(" "),
    status: r.residential_commercial_ind ?? "",
    borough: r.borough ?? "",
  }));
}

// ---------------------------------------------------------------------------
// Street Trees
// ---------------------------------------------------------------------------

export interface StreetTree {
  species: string;
  diameter: number | null;
  health: string;
  status: string;
  address: string;
  problems: string[];
}

export async function getStreetTrees(
  lat: number, lng: number,
  opts?: { radiusMeters?: number; limit?: number },
): Promise<StreetTree[]> {
  const radius = opts?.radiusMeters ?? 200;
  const limit = opts?.limit ?? 30;

  const data = await socrataFetch(DATASETS.streetTrees, {
    $where: bboxFilter("latitude", "longitude", lat, lng, radius),
    $limit: String(limit),
  }) as any[];

  return data.map(r => ({
    species: r.spc_common ?? r.spc_latin ?? "Unknown",
    diameter: r.tree_dbh ? Number(r.tree_dbh) : null,
    health: r.health ?? "",
    status: r.status ?? "",
    address: [r.address, r.zipcode].filter(Boolean).join(" "),
    problems: [r.root_stone, r.root_grate, r.root_other, r.trunk_wire, r.trnk_light, r.trnk_other, r.brch_light, r.brch_shoe, r.brch_other]
      .filter(v => v && v !== "No"),
  }));
}
