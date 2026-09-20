import { BigNumber } from "@ethersproject/bignumber";
import { Actions, V4Planner, URVersion } from "@uniswap/v4-sdk";
import { Ether, Token } from "@uniswap/sdk-core";
import { CommandType, RoutePlanner, UniversalRouterVersion } from "@uniswap/universal-router-sdk";
import { encodeFunctionData, parseEther, type Address, type Hash } from "viem";
import { ROBIN_CHAIN_ID, ROBIN_CONTRACTS } from "./chain.js";
import { getPublicClient, getWalletClient } from "./clients.js";
import type { PoolKey } from "./create-detect.js";

const QUOTER_ABI = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const UR_ABI = [
  {
    name: "execute",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

function resolveZeroForOne(poolKey: PoolKey, tokenOut: Address): boolean {
  const t = tokenOut.toLowerCase();
  const c0 = poolKey.currency0.toLowerCase();
  const c1 = poolKey.currency1.toLowerCase();
  const ethAddrs = new Set([ZERO.toLowerCase(), ROBIN_CONTRACTS.weth.toLowerCase()]);
  if (ethAddrs.has(c0) && t === c1) return false;
  if (ethAddrs.has(c1) && t === c0) return true;
  if (t === c0) return false;
  if (t === c1) return true;
  throw new Error("代币不在该 V4 池币对中");
}

export async function quoteV4Buy(
  poolKey: PoolKey,
  tokenOut: Address,
  amountInWei: bigint,
): Promise<bigint> {
  const client = getPublicClient();
  const zeroForOne = resolveZeroForOne(poolKey, tokenOut);
  const result = await client.simulateContract({
    address: ROBIN_CONTRACTS.v4Quoter,
    abi: QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args: [
      {
        poolKey: {
          currency0: poolKey.currency0,
          currency1: poolKey.currency1,
          fee: poolKey.fee,
          tickSpacing: poolKey.tickSpacing,
          hooks: poolKey.hooks,
        },
        zeroForOne,
        exactAmount: amountInWei,
        hookData: "0x",
      },
    ],
  });
  return result.result[0];
}

export async function executeV4Buy(params: {
  poolKey: PoolKey;
  tokenOut: Address;
  ethAmount: string;
  slippageBps: number;
  recipient?: Address;
}): Promise<Hash> {
  const wallet = getWalletClient();
  const account = wallet.account!;
  const recipient = params.recipient ?? account.address;
  const amountIn = parseEther(params.ethAmount);
  const amountOut = await quoteV4Buy(params.poolKey, params.tokenOut, amountIn);
  const minOut = (amountOut * BigInt(10_000 - params.slippageBps)) / 10_000n;
  const zeroForOne = resolveZeroForOne(params.poolKey, params.tokenOut);

  const eth = Ether.onChain(ROBIN_CHAIN_ID);
  const client = getPublicClient();
  let decimals = 18;
  try {
    decimals = Number(
      await client.readContract({
        address: params.tokenOut,
        abi: [{ name: "decimals", type: "function", inputs: [], outputs: [{ type: "uint8" }] }] as const,
        functionName: "decimals",
      }),
    );
  } catch {
    /* default 18 */
  }
  const token = new Token(ROBIN_CHAIN_ID, params.tokenOut, decimals);

  const v4 = new V4Planner();
  v4.addSettle(eth, true, BigNumber.from(amountIn.toString()));
  v4.addAction(
    Actions.SWAP_EXACT_IN_SINGLE,
    [
      {
        poolKey: {
          currency0: params.poolKey.currency0,
          currency1: params.poolKey.currency1,
          fee: params.poolKey.fee,
          tickSpacing: params.poolKey.tickSpacing,
          hooks: params.poolKey.hooks,
        },
        zeroForOne,
        amountIn: amountIn.toString(),
        amountOutMinimum: minOut.toString(),
        minHopPriceX36: 0,
        hookData: "0x",
      },
    ],
    URVersion.V2_1_2,
  );
  v4.addTake(token, recipient);

  const planner = new RoutePlanner();
  planner.addCommand(CommandType.V4_SWAP, [v4.finalize()], false, UniversalRouterVersion.V2_1_2);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const data = encodeFunctionData({
    abi: UR_ABI,
    functionName: "execute",
    args: [planner.commands as `0x${string}`, planner.inputs as `0x${string}`[], deadline],
  });

  const hash = await wallet.sendTransaction({
    account,
    chain: wallet.chain,
    to: ROBIN_CONTRACTS.universalRouter,
    data,
    value: amountIn,
  });

  await getPublicClient().waitForTransactionReceipt({ hash });
  return hash;
}
