import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { DistrictInfo } from "./types.js";

const CONFIG_DIR = join(homedir(), ".nyc-civic");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export interface SavedAddress {
  label: string;
  address: string;
  districts: DistrictInfo;
}

export interface Config {
  saved_addresses: SavedAddress[];
  congress_api_key: string | null;
  ttl_overrides: Record<string, number>;
  geoclient_key: string | null;
}

const DEFAULT_CONFIG: Config = {
  saved_addresses: [],
  congress_api_key: null,
  ttl_overrides: {},
  geoclient_key: null,
};

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
}

export function saveConfig(config: Config): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function getCongressApiKey(): string {
  return process.env.NYC_CIVIC_CONGRESS_API_KEY || loadConfig().congress_api_key || "DEMO_KEY";
}

export function getGeoClientKey(): string | null {
  return process.env.NYC_CIVIC_GEOCLIENT_KEY || loadConfig().geoclient_key || null;
}
