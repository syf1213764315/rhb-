import { encodeAbiParameters, keccak256 } from "viem";
import { ROBIN_CONTRACTS } from "./chain.js";
import { getPublicClient } from "./clients.js";
import type { PoolKey } from "./create-detect.js";

const STATE_VIEW_ABI = [
  {
    name: "getSlot0",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
] as const;

export function poolIdFromKey(poolKey: PoolKey): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
    ),
  );
}

export async function readPoolSqrtPrice(poolKey: PoolKey): Promise<bigint> {
  const client = getPublicClient();
  const poolId = poolIdFromKey(poolKey);
  const slot = await client.readContract({
    address: ROBIN_CONTRACTS.stateView,
    abi: STATE_VIEW_ABI,
    functionName: "getSlot0",
    args: [poolId],
  });
  return slot[0];
}
