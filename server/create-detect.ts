import { decodeAbiParameters, getAddress, type Address, type Hash, type TransactionReceipt } from "viem";
import {
  ROBIN_CONTRACTS,
  AIRLOCK_CREATE_TOPIC,
  POOL_INITIALIZE_TOPIC,
  TOKEN_CREATED_TOPIC,
} from "./chain.js";

const ENTRY_SET = new Set(
  [...ROBIN_CONTRACTS.launchEntry, ROBIN_CONTRACTS.dopplerAirlock].map((a) => a.toLowerCase()),
);
const AIRLOCK_LOWER = ROBIN_CONTRACTS.dopplerAirlock.toLowerCase();

export type PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  sqrtPriceX96: bigint;
};

export type LaunchEvent = {
  token: Address;
  creator: Address;
  txHash: Hash;
  blockNumber: bigint;
  poolKey: PoolKey | null;
};

function topicToAddress(topic: string): Address {
  return getAddress(`0x${topic.slice(-40)}`);
}

export function isLaunchTarget(to: string | null | undefined): boolean {
  if (!to) return false;
  return ENTRY_SET.has(to.toLowerCase());
}

export function parseLaunchFromReceipt(
  receipt: TransactionReceipt,
  expectedCreator?: Address,
): LaunchEvent | null {
  const creatorLower = expectedCreator?.toLowerCase();
  let token: Address | null = null;
  let poolKey: PoolKey | null = null;

  for (const log of receipt.logs) {
    const t0 = log.topics[0]?.toLowerCase();
    if (!t0) continue;

    if (
      t0 === TOKEN_CREATED_TOPIC.toLowerCase() &&
      ENTRY_SET.has(log.address.toLowerCase())
    ) {
      if (log.topics.length >= 2 && log.topics[1]) {
        token = topicToAddress(log.topics[1]);
      } else if (log.data && log.data.length >= 66) {
        const [addr] = decodeAbiParameters([{ type: "address" }], log.data);
        token = getAddress(addr);
      }
    }

    if (
      t0 === AIRLOCK_CREATE_TOPIC.toLowerCase() &&
      log.address.toLowerCase() === AIRLOCK_LOWER &&
      log.data.length >= 66
    ) {
      const [asset] = decodeAbiParameters([{ type: "address" }], log.data);
      token = getAddress(asset);
    }

    if (
      t0 === POOL_INITIALIZE_TOPIC.toLowerCase() &&
      log.address.toLowerCase() === ROBIN_CONTRACTS.poolManager.toLowerCase() &&
      log.topics.length >= 4
    ) {
      const currency0 = topicToAddress(log.topics[2]!);
      const currency1 = topicToAddress(log.topics[3]!);
      const decoded = decodeAbiParameters(
        [
          { type: "uint24", name: "fee" },
          { type: "int24", name: "tickSpacing" },
          { type: "address", name: "hooks" },
          { type: "uint160", name: "sqrtPriceX96" },
          { type: "int24", name: "tick" },
        ],
        log.data,
      );
      poolKey = {
        currency0,
        currency1,
        fee: Number(decoded[0]),
        tickSpacing: Number(decoded[1]),
        hooks: getAddress(decoded[2] as string),
        sqrtPriceX96: decoded[3] as bigint,
      };
      if (!token) {
        const zero = "0x0000000000000000000000000000000000000000";
        const c0 = currency0.toLowerCase();
        const c1 = currency1.toLowerCase();
        if (c0 !== zero && c0 !== ROBIN_CONTRACTS.weth.toLowerCase()) token = currency0;
        else if (c1 !== zero && c1 !== ROBIN_CONTRACTS.weth.toLowerCase()) token = currency1;
      }
    }
  }

  if (!token) return null;
  const creator = getAddress(receipt.from);
  if (creatorLower && creator.toLowerCase() !== creatorLower) return null;

  return {
    token,
    creator,
    txHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
    poolKey,
  };
}
