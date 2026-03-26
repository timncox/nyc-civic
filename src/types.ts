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

export interface Rep {
  id: string;
  level: "city" | "state_senate" | "state_assembly" | "federal_house" | "federal_senate";
  district: string;
  name: string;
  party: string | null;
  profile: RepProfile;
  scrapedAt: number;
}

export interface RepProfile {
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
}

export interface Bill {
  id: string;
  level: "city" | "state" | "federal";
  title: string;
  summary: string | null;
  status: string | null;
  sponsors: string[];
  scrapedAt: number;
}

export interface Vote {
  id: string;
  billId: string;
  repId: string;
  vote: "yes" | "no" | "abstain" | "absent" | "not_voting";
  date: string;
  scrapedAt: number;
}

export interface AttendanceRecord {
  id: string;
  repId: string;
  sessionName: string | null;
  present: boolean;
  date: string;
  scrapedAt: number;
}

export interface PartyOrg {
  id: string;
  borough: string;
  role: "chair" | "vice_chair" | "district_leader" | "county_committee" | "executive_committee" | "other";
  name: string;
  assemblyDistrict: number | null;
  electionDistrict: number | null;
  details: Record<string, unknown>;
  scrapedAt: number;
}

export interface CommunityBoard {
  id: string;
  district: string;
  members: Array<{ name: string; title?: string }>;
  meetings: Array<{ date: string; location?: string; description?: string }>;
  contact: { phone?: string; email?: string; address?: string; website?: string };
  scrapedAt: number;
}

export interface ScrapeResult<T> {
  data: T[];
  errors: string[];
  stale: boolean;
  scrapedAt: number;
}

export interface SyncReport {
  level: string;
  recordsUpdated: number;
  errors: string[];
  elapsedMs: number;
}
