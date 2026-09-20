import { decodeAbiParameters, getAddress, parseAbiItem, type Address } from "viem";
import { ROBIN_CONTRACTS } from "./chain.js";
import { getPublicClient } from "./clients.js";
import type { PoolKey } from "./create-detect.js";

function poolKeyFromInitializeArgs(args: {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  sqrtPriceX96: bigint;
}): PoolKey {
  return {
    currency0: getAddress(args.currency0),
    currency1: getAddress(args.currency1),
    fee: Number(args.fee),
    tickSpacing: Number(args.tickSpacing),
    hooks: getAddress(args.hooks),
    sqrtPriceX96: args.sqrtPriceX96,
  };
}

const WETH = ROBIN_CONTRACTS.weth.toLowerCase();
const ZERO = "0x0000000000000000000000000000000000000000";

/** Robinhood V4 PoolManager 部署区块 */
const V4_DEPLOY_BLOCK = 9070n;

/** 通过 agnt / Gecko 返回的 pool_address（V4 PoolId）反查 PoolKey */
export async function findPoolKeyByPoolId(poolId: `0x${string}`): Promise<PoolKey | null> {
  const client = getPublicClient();
  const logs = await client.getLogs({
    address: ROBIN_CONTRACTS.poolManager,
    event: parseAbiItem(
      "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
    ),
    args: { id: poolId },
    fromBlock: V4_DEPLOY_BLOCK,
    toBlock: "latest",
  });
  const log = logs[logs.length - 1];
  const args = log?.args;
  if (!args?.currency0 || !args.currency1 || args.sqrtPriceX96 == null || !args.hooks) return null;
  return poolKeyFromInitializeArgs({
    currency0: args.currency0,
    currency1: args.currency1,
    fee: Number(args.fee),
    tickSpacing: Number(args.tickSpacing),
    hooks: args.hooks,
    sqrtPriceX96: args.sqrtPriceX96,
  });
}

/** 在链上查找含该代币的 V4 池（ETH/WETH 配对优先） */
export async function findV4PoolForToken(token: Address, lookbackBlocks = 300_000n): Promise<PoolKey | null> {
  const client = getPublicClient();
  const latest = await client.getBlockNumber();
  const from = latest > lookbackBlocks ? latest - lookbackBlocks : 0n;
  const tokenL = token.toLowerCase();

  const logs = await client.getLogs({
    address: ROBIN_CONTRACTS.poolManager,
    event: parseAbiItem(
      "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
    ),
    fromBlock: from,
    toBlock: latest,
  });

  let fallback: PoolKey | null = null;
  for (const log of logs) {
    const args = log.args;
    if (!args?.currency0 || !args.currency1 || args.sqrtPriceX96 == null || !args.hooks) continue;
    const key = poolKeyFromInitializeArgs({
      currency0: args.currency0,
      currency1: args.currency1,
      fee: Number(args.fee),
      tickSpacing: Number(args.tickSpacing),
      hooks: args.hooks,
      sqrtPriceX96: args.sqrtPriceX96,
    });
    const c0 = key.currency0.toLowerCase();
    const c1 = key.currency1.toLowerCase();
    if (c0 !== tokenL && c1 !== tokenL) continue;

    const other = c0 === tokenL ? c1 : c0;
    const ethPair = other === ZERO || other === WETH;
    if (ethPair) return key;
    if (!fallback) fallback = key;
  }
  return fallback;
}

export function parsePoolKeyInput(raw: {
  currency0?: string;
  currency1?: string;
  fee?: number | string;
  tickSpacing?: number | string;
  hooks?: string;
}): PoolKey {
  if (!raw.currency0?.trim() || !raw.currency1?.trim()) {
    throw new Error("手动 PoolKey 需填写 currency0 / currency1");
  }
  return {
    currency0: getAddress(raw.currency0.trim()),
    currency1: getAddress(raw.currency1.trim()),
    fee: Number(raw.fee ?? 0),
    tickSpacing: Number(raw.tickSpacing ?? 0),
    hooks: getAddress((raw.hooks?.trim() || "0x0000000000000000000000000000000000000000") as Address),
    sqrtPriceX96: 0n,
  };
}
