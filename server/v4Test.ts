import { getAddress } from "viem";
import { fetchTokenSummary } from "./agntApi.js";
import { quoteAndExecuteAgntBuy } from "./agntSwap.js";
import { executeV4Buy } from "./swapV4.js";
import { resolvePoolKeyForToken } from "./tokenContext.js";
import { privateKeyConfigured } from "./secrets.js";
import { ROBIN_CONTRACTS } from "./chain.js";
import { getWalletAddress } from "./clients.js";

export type V4TestBody = {
  token: string;
  ethAmount?: string;
  slippageBps?: number;
  execute?: boolean;
  /** agnt 网页同款 relay；v4 为直连 Universal Router */
  swapMode?: "agnt" | "v4";
  poolKey?: {
    currency0?: string;
    currency1?: string;
    fee?: number | string;
    tickSpacing?: number | string;
    hooks?: string;
  };
};

export async function runV4Test(body: V4TestBody) {
  const token = getAddress(body.token.trim());
  const ethAmount = (body.ethAmount ?? "0.001").trim();
  const slippageBps = Math.min(5000, Math.max(0, Math.floor(body.slippageBps ?? 100)));
  const swapMode = body.swapMode ?? "agnt";

  const summary = await fetchTokenSummary(token).catch(() => null);

  if (swapMode === "agnt") {
    if (body.execute && !privateKeyConfigured()) {
      throw new Error("实盘测试需配置 config.json privateKey");
    }
    const result = await quoteAndExecuteAgntBuy({
      buyToken: token,
      ethAmount,
      slippageBps,
      execute: !!body.execute,
    });
    return {
      swapMode: "agnt",
      token,
      symbol: summary?.symbol,
      name: summary?.name,
      marketCapUsd: summary?.market_cap,
      taker: getWalletAddress(),
      ...result,
    };
  }

  if (body.execute && !privateKeyConfigured()) {
    throw new Error("实盘测试需配置 config.json privateKey");
  }

  const poolKey = await resolvePoolKeyForToken(token, {
    poolId: summary?.pool?.pool_address,
    manualPoolKey: body.poolKey,
  });

  const agntPreview = await quoteAndExecuteAgntBuy({
    buyToken: token,
    ethAmount,
    slippageBps,
    execute: false,
  }).catch(() => null);

  if (!body.execute) {
    return {
      swapMode: "v4",
      ok: true,
      mode: "quote" as const,
      token,
      note: "v4 模式：执行走链上 UR；报价参考 agnt quote_v2",
      agntQuote: agntPreview,
      poolKey: {
        currency0: poolKey.currency0,
        currency1: poolKey.currency1,
        fee: poolKey.fee,
        tickSpacing: poolKey.tickSpacing,
        hooks: poolKey.hooks,
      },
      universalRouter: ROBIN_CONTRACTS.universalRouter,
    };
  }

  const hash = await executeV4Buy({ poolKey, tokenOut: token, ethAmount, slippageBps });
  return {
    swapMode: "v4",
    ok: true,
    mode: "swap" as const,
    token,
    txHash: hash,
    explorerUrl: ROBIN_CONTRACTS.explorerTx(hash),
    agntQuote: agntPreview,
  };
}

export async function lookupToken(tokenRaw: string) {
  const token = getAddress(tokenRaw.trim());
  const summary = await fetchTokenSummary(token);
  return {
    token,
    found: true,
    quoteSource: "agnt.social/token/summary",
    summary,
    /** V4 池 ID（agnt）；买入走 quote_v2，无需本地 PoolKey */
    poolId: summary.pool?.pool_address ?? null,
    poolKey: null,
  };
}

export const lookupV4Pool = lookupToken;
