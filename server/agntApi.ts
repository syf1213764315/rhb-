import { getAddress, type Address } from "viem";

const DEFAULT_BASE = "https://agnt.social/api/token";

export type AgntPoolInfo = {
  source?: string;
  network?: string;
  chain?: string;
  pool_address: string;
  quote_token?: string | null;
  name?: string;
  dex_label?: string;
  reserve_usd?: number;
};

export type AgntTokenSummary = {
  token_address: string;
  chain: string;
  name: string;
  symbol: string;
  image?: string;
  price: number;
  price_change_24h?: number;
  market_cap: number;
  volume_24h?: number;
  volume_source?: string;
  pool?: AgntPoolInfo;
};

type AgntResponse = {
  status: string;
  data?: AgntTokenSummary;
  source?: string;
  stale?: boolean;
  reason?: string | null;
};

export function agntSummaryUrl(token: Address, baseUrl = DEFAULT_BASE) {
  const root = baseUrl.replace(/\/$/, "");
  return `${root}/${token}/summary?chain=robinhood`;
}

export async function fetchTokenSummary(token: Address, baseUrl?: string): Promise<AgntTokenSummary> {
  const url = agntSummaryUrl(token, baseUrl ?? process.env.AGNT_API_BASE ?? DEFAULT_BASE);
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await res.text();
  const ct = res.headers.get("content-type") ?? "";
  if (!res.ok) {
    throw new Error(`agnt.social 请求失败 HTTP ${res.status}: ${raw.slice(0, 120)}`);
  }
  if (!ct.includes("application/json") && raw.trimStart().startsWith("<")) {
    throw new Error("agnt.social 返回了 HTML 而非 JSON，请检查网络或 AGNT_API_BASE");
  }
  let json: AgntResponse;
  try {
    json = JSON.parse(raw) as AgntResponse;
  } catch {
    throw new Error(`agnt.social 响应非 JSON: ${raw.slice(0, 120)}`);
  }
  if (json.status !== "ok" || !json.data) {
    throw new Error(json.reason ?? "agnt.social 暂无该代币数据");
  }
  return {
    ...json.data,
    token_address: getAddress(json.data.token_address),
  };
}
