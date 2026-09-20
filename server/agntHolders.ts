import { getAddress, type Address } from "viem";

const HOLDERS_BASE = (process.env.AGNT_API_BASE ?? "https://agnt.social/api/token").replace(/\/$/, "");

export type AgntHolderRow = {
  rank: number;
  address: string;
  is_contract?: boolean;
  label?: string | null;
  balance: number;
  pct: number;
  agnt?: { name?: string; handle?: string; pfp?: string };
};

export type AgntHoldersResponse = {
  status: string;
  source?: string;
  count?: number;
  distribution?: {
    top10?: number;
    top50?: number;
    agnt?: number;
  };
  holders: AgntHolderRow[];
};

export function holdersUrl(token: Address) {
  return `${HOLDERS_BASE}/${token}/holders?chain=robinhood`;
}

export async function fetchTokenHolders(token: Address): Promise<AgntHoldersResponse> {
  const res = await fetch(holdersUrl(token), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`agnt holders HTTP ${res.status}: ${raw.slice(0, 120)}`);
  }
  if (raw.trimStart().startsWith("<")) {
    throw new Error("agnt holders 返回 HTML 而非 JSON");
  }
  const json = JSON.parse(raw) as AgntHoldersResponse & { reason?: string };
  if (json.status !== "ok" || !Array.isArray(json.holders)) {
    throw new Error(json.reason ?? "agnt holders 数据无效");
  }
  return json;
}

export function findHolderPct(holders: AgntHolderRow[], address: string): number | null {
  const want = address.toLowerCase();
  const row = holders.find((h) => h.address.toLowerCase() === want);
  return row == null ? null : row.pct;
}
