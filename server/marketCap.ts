import type { PoolKey } from "./create-detect.js";
import type { TokenMeta } from "./tokenMeta.js";
import { ROBIN_CONTRACTS } from "./chain.js";

const ZERO = "0x0000000000000000000000000000000000000000";

/** 由 V4 池 sqrtPriceX96 估算 token 的 USD 市值（FDV） */
export function estimateMarketCapUsd(
  poolKey: PoolKey,
  token: `0x${string}`,
  meta: TokenMeta,
  ethUsd: number,
): number {
  if (meta.totalSupply <= 0n || poolKey.sqrtPriceX96 <= 0n) return 0;

  const tokenLower = token.toLowerCase();
  const isToken0 =
    poolKey.currency0.toLowerCase() === tokenLower ||
    (poolKey.currency0.toLowerCase() === ZERO && tokenLower === ROBIN_CONTRACTS.weth.toLowerCase());
  const isToken1 = poolKey.currency1.toLowerCase() === tokenLower;

  if (!isToken0 && !isToken1) return 0;

  const sqrt = Number(poolKey.sqrtPriceX96) / 2 ** 96;
  const price1Per0 = sqrt * sqrt;

  const dec0 =
    poolKey.currency0.toLowerCase() === ZERO || poolKey.currency0.toLowerCase() === ROBIN_CONTRACTS.weth.toLowerCase()
      ? 18
      : meta.decimals;
  const dec1 =
    poolKey.currency1.toLowerCase() === ZERO || poolKey.currency1.toLowerCase() === ROBIN_CONTRACTS.weth.toLowerCase()
      ? 18
      : meta.decimals;

  let priceEthPerToken = 0;
  const ethIs0 =
    poolKey.currency0.toLowerCase() === ZERO || poolKey.currency0.toLowerCase() === ROBIN_CONTRACTS.weth.toLowerCase();
  const ethIs1 =
    poolKey.currency1.toLowerCase() === ZERO || poolKey.currency1.toLowerCase() === ROBIN_CONTRACTS.weth.toLowerCase();

  if (isToken0 && ethIs1) {
    priceEthPerToken = price1Per0 * 10 ** (dec0 - dec1);
  } else if (isToken1 && ethIs0) {
    priceEthPerToken = (price1Per0 > 0 ? 1 / price1Per0 : 0) * 10 ** (dec1 - dec0);
  } else {
    return 0;
  }

  const supply = Number(meta.totalSupply) / 10 ** meta.decimals;
  const mcapEth = priceEthPerToken * supply;
  return mcapEth * ethUsd;
}
