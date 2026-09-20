import { type Address } from "viem";
import { fetchTokenHoldersFromChain, type ChainHoldersOptions, type HoldersSnapshot } from "./chainHolders.js";

export type AgntHolderRow = {
  rank: number;
  address: string;
  is_contract?: boolean;
  label?: string | null;
  balance: number;
  pct: number;
  agnt?: { name?: string; handle?: string; pfp?: string };
};

export type AgntHoldersResponse = HoldersSnapshot & {
  distribution?: {
    top10?: number;
    top50?: number;
    agnt?: number;
  };
};

/** 通过链上 RPC：Transfer 日志 + balanceOf */
export async function fetchTokenHolders(
  token: Address,
  options: ChainHoldersOptions = {},
): Promise<AgntHoldersResponse> {
  return fetchTokenHoldersFromChain(token, options);
}

export function findHolderPct(holders: AgntHolderRow[], address: string): number | null {
  const want = address.toLowerCase();
  const row = holders.find((h) => h.address.toLowerCase() === want);
  return row == null ? null : row.pct;
}
