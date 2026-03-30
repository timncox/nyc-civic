import { getLegistarToken } from "../config.js";

const LEGISTAR_API = "https://webapi.legistar.com/v1/nyc";
const FETCH_TIMEOUT = 15_000;

export async function legistarFetch(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const token = getLegistarToken();
  if (!token) throw new Error("Legistar API token not configured — set legistar_token in ~/.nyc-civic/config.json");

  const url = new URL(`${LEGISTAR_API}${path}`);
  url.searchParams.set("token", token);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(`$${k}`, v);
  }

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) throw new Error(`Legistar API ${res.status}: ${path}`);
  return res.json();
}
