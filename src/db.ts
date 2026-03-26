import initSqlJs, { type Database } from "sql.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

let db: Database;
let dbPath: string;

export async function getDb(): Promise<Database> {
  if (db) return db;
  // Resolve relative to the project root (two dirs up from dist/db.js)
  const defaultPath = new URL("../../data/nyc-civic.db", import.meta.url).pathname;
  // If the resolved path escapes the project, use ~/.nyc-civic/ instead
  dbPath = process.env.NYC_CIVIC_DB_PATH || defaultPath;
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const SQL = await initSqlJs();
  if (existsSync(dbPath)) {
    const buffer = readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  migrate(db);
  persistDb();
  return db;
}

export function persistDb(): void {
  if (!db) return;
  const data = db.export();
  writeFileSync(dbPath, Buffer.from(data));
}

function migrate(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS districts (
      address_hash TEXT PRIMARY KEY,
      address_raw TEXT NOT NULL,
      council INTEGER,
      community_board TEXT,
      state_senate INTEGER,
      state_assembly INTEGER,
      congressional INTEGER,
      election_district INTEGER,
      borough TEXT,
      lat REAL,
      lng REAL,
      cached_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS reps (
      id TEXT PRIMARY KEY,
      level TEXT NOT NULL,
      district TEXT NOT NULL,
      name TEXT NOT NULL,
      party TEXT,
      profile_json TEXT,
      scraped_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS bills (
      id TEXT PRIMARY KEY,
      level TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      status TEXT,
      sponsors_json TEXT,
      scraped_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS votes (
      id TEXT PRIMARY KEY,
      bill_id TEXT NOT NULL,
      rep_id TEXT NOT NULL,
      vote TEXT NOT NULL,
      date TEXT NOT NULL,
      scraped_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS attendance (
      id TEXT PRIMARY KEY,
      rep_id TEXT NOT NULL,
      session_name TEXT,
      present INTEGER NOT NULL,
      date TEXT NOT NULL,
      scraped_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS party_orgs (
      id TEXT PRIMARY KEY,
      borough TEXT NOT NULL,
      role TEXT NOT NULL,
      name TEXT NOT NULL,
      assembly_district INTEGER,
      election_district INTEGER,
      details_json TEXT,
      scraped_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS community_boards (
      id TEXT PRIMARY KEY,
      district TEXT NOT NULL,
      members_json TEXT,
      meetings_json TEXT,
      contact_json TEXT,
      scraped_at INTEGER NOT NULL
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_reps_level_district ON reps(level, district)");
  db.run("CREATE INDEX IF NOT EXISTS idx_votes_rep ON votes(rep_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_votes_bill ON votes(bill_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_bills_level ON bills(level)");
  db.run("CREATE INDEX IF NOT EXISTS idx_attendance_rep ON attendance(rep_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_party_orgs_borough ON party_orgs(borough)");
  db.run("CREATE INDEX IF NOT EXISTS idx_party_orgs_ad ON party_orgs(assembly_district)");
}
