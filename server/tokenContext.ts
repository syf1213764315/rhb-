import { formatUnits, getAddress, parseEther, parseUnits, type Address } from "viem";
import { fetchTokenSummary, type AgntTokenSummary } from "./agntApi.js";
import { findPoolKeyByPoolId, findV4PoolForToken, parsePoolKeyInput } from "./poolDiscover.js";
import { loadSettings } from "./settings.js";
import { readTokenMeta } from "./tokenMeta.js";
import type { PoolKey } from "./create-detect.js";

export type ResolvedTokenContext = {
  token: Address;
  summary: AgntTokenSummary;
  poolKey: PoolKey | null;
  decimals: number;
};

export async function resolvePoolKeyForToken(
  token: Address,
  opts?: {
    poolId?: string;
    manualPoolKey?: {
      currency0?: string;
      currency1?: string;
      fee?: number | string;
      tickSpacing?: number | string;
      hooks?: string;
    };
    fallback?: PoolKey | null;
  },
): Promise<PoolKey> {
  if (opts?.manualPoolKey?.currency0 && opts.manualPoolKey.currency1) {
    return parsePoolKeyInput(opts.manualPoolKey);
  }

  const poolId = opts?.poolId?.trim();
  if (poolId && /^0x[a-fA-F0-9]{64}$/.test(poolId)) {
    const byId = await findPoolKeyByPoolId(poolId as `0x${string}`);
    if (byId) return byId;
  }

  try {
    const summary = await fetchTokenSummary(token);
    const addr = summary.pool?.pool_address;
    if (addr && /^0x[a-fA-F0-9]{64}$/.test(addr)) {
      const key = await findPoolKeyByPoolId(addr as `0x${string}`);
      if (key) return key;
    }
  } catch {
    /* agnt 未收录时走链上扫描 */
  }

  if (opts?.fallback) return opts.fallback;

  const scanned = await findV4PoolForToken(token);
  if (!scanned) {
    throw new Error("无法解析 V4 PoolKey：agnt 无池或链上未找到 Initialize");
  }
  return scanned;
}

export async function loadTokenContext(token: Address): Promise<ResolvedTokenContext> {
  const summary = await fetchTokenSummary(token);
  const meta = await readTokenMeta(token);
  let poolKey: PoolKey | null = null;
  const poolAddr = summary.pool?.pool_address;
  if (poolAddr && /^0x[a-fA-F0-9]{64}$/.test(poolAddr)) {
    poolKey = await findPoolKeyByPoolId(poolAddr as `0x${string}`);
  }
  if (!poolKey) {
    poolKey = await findV4PoolForToken(token);
  }
  return { token, summary, poolKey, decimals: meta.decimals };
}

/** 用 agnt 的 USD 单价估算买入可得代币数量（替代链上 Quoter 展示） */
export function quoteOutFromSummary(params: {
  summary: AgntTokenSummary;
  ethAmount: string;
  ethUsdPrice: number;
  decimals: number;
  slippageBps: number;
}) {
  const eth = Number.parseFloat(params.ethAmount);
  if (!Number.isFinite(eth) || eth <= 0) throw new Error("ethAmount 无效");
  if (!params.summary.price || params.summary.price <= 0) throw new Error("agnt 无有效 price");
  const usdIn = eth * params.ethUsdPrice;
  const tokens = usdIn / params.summary.price;
  const tokenStr = tokens.toFixed(Math.min(18, params.decimals));
  const amountOut = parseUnits(tokenStr, params.decimals);
  const minOut = (amountOut * BigInt(10_000 - params.slippageBps)) / 10_000n;
  return {
    usdIn,
    amountOut,
    minOut,
    amountOutFormatted: formatUnits(amountOut, params.decimals),
    minOutFormatted: formatUnits(minOut, params.decimals),
    priceUsd: params.summary.price,
    marketCapUsd: params.summary.market_cap,
  };
}

export async function getMarketCapUsd(token: Address): Promise<number> {
  const summary = await fetchTokenSummary(token);
  return summary.market_cap;
}

export function matchesAgntNameFilter(summary: AgntTokenSummary, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  return summary.name.toLowerCase().includes(f) || summary.symbol.toLowerCase().includes(f);
}

export function ethUsdFromSettings() {
  return loadSettings().ethUsdPrice;
}
