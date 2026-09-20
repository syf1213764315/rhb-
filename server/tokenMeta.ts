import { type Address } from "viem";
import { getPublicClient } from "./clients.js";

const ERC20_ABI = [
  { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export type TokenMeta = {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
};

export async function readTokenMeta(token: Address): Promise<TokenMeta> {
  const client = getPublicClient();
  try {
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      client.readContract({ address: token, abi: ERC20_ABI, functionName: "name" }),
      client.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }),
      client.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }),
      client.readContract({ address: token, abi: ERC20_ABI, functionName: "totalSupply" }),
    ]);
    return { name, symbol, decimals: Number(decimals), totalSupply };
  } catch {
    return { name: "?", symbol: "TOKEN", decimals: 18, totalSupply: 0n };
  }
}

export function matchesNameFilter(meta: TokenMeta, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  return meta.name.toLowerCase().includes(f) || meta.symbol.toLowerCase().includes(f);
}
