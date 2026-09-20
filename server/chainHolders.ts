import { parseAbiItem, zeroAddress, type Address } from "viem";
import { getPublicClient } from "./clients.js";
import { readTokenMeta } from "./tokenMeta.js";

export type HolderRow = {
  rank: number;
  address: string;
  balance: number;
  pct: number;
};

export type HoldersSnapshot = {
  status: string;
  source?: string;
  count?: number;
  distribution?: { top10?: number };
  holders: HolderRow[];
};

const ERC20_BALANCE = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const TRANSFER = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

const LOG_CHUNK = 2000n;
const DEFAULT_LOOKBACK = 30_000n;

function pctOf(balance: bigint, totalSupply: bigint): number {
  if (totalSupply <= 0n) return 0;
  return Number((balance * 100_000_000n) / totalSupply) / 1_000_000;
}

async function readBalance(token: Address, account: Address): Promise<bigint> {
  const client = getPublicClient();
  return client.readContract({
    address: token,
    abi: ERC20_BALANCE,
    functionName: "balanceOf",
    args: [account],
  });
}

async function scanTransferBalances(
  token: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Map<string, bigint>> {
  const client = getPublicClient();
  const balances = new Map<string, bigint>();
  const zero = zeroAddress.toLowerCase();

  if (fromBlock > toBlock) return balances;

  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK) {
    const end = start + LOG_CHUNK - 1n > toBlock ? toBlock : start + LOG_CHUNK - 1n;
    const logs = await client.getLogs({
      address: token,
      event: TRANSFER,
      fromBlock: start,
      toBlock: end,
    });
    for (const log of logs) {
      const from = log.args.from?.toLowerCase();
      const to = log.args.to?.toLowerCase();
      const value = log.args.value ?? 0n;
      if (from && from !== zero) {
        balances.set(from, (balances.get(from) ?? 0n) - value);
      }
      if (to && to !== zero) {
        balances.set(to, (balances.get(to) ?? 0n) + value);
      }
    }
  }

  for (const [addr, bal] of [...balances.entries()]) {
    if (bal <= 0n) balances.delete(addr);
  }
  return balances;
}

function buildHolderRows(
  balances: Map<string, bigint>,
  totalSupply: bigint,
  limit = 100,
): HolderRow[] {
  const sorted = [...balances.entries()].sort((a, b) => (a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0));
  return sorted.slice(0, limit).map(([address, balance], i) => ({
    rank: i + 1,
    address,
    balance: Number(balance),
    pct: pctOf(balance, totalSupply),
  }));
}

function top10Pct(rows: HolderRow[], totalSupply: bigint, allBalances: Map<string, bigint>): number {
  if (totalSupply <= 0n) return 0;
  if (rows.length >= 10) {
    const sum = rows.slice(0, 10).reduce((acc, r) => acc + r.pct, 0);
    return Math.round(sum * 100) / 100;
  }
  const sorted = [...allBalances.values()].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const top = sorted.slice(0, 10);
  const sum = top.reduce((acc, bal) => acc + pctOf(bal, totalSupply), 0);
  return Math.round(sum * 100) / 100;
}

export type ChainHoldersOptions = {
  /** 从该区块扫 Transfer（发币区块）；不传则从 latest-lookback 起扫 */
  fromBlock?: bigint;
  /** 额外用 balanceOf 校准的地址（监控钱包） */
  watchAddresses?: Address[];
  lookbackBlocks?: bigint;
};

export async function fetchTokenHoldersFromChain(
  token: Address,
  options: ChainHoldersOptions = {},
): Promise<HoldersSnapshot> {
  const meta = await readTokenMeta(token);
  const client = getPublicClient();
  const latest = await client.getBlockNumber();
  const lookback = options.lookbackBlocks ?? DEFAULT_LOOKBACK;
  let fromBlock = options.fromBlock ?? (latest > lookback ? latest - lookback : 0n);
  if (fromBlock < 0n) fromBlock = 0n;

  const balances = await scanTransferBalances(token, fromBlock, latest);

  for (const watch of options.watchAddresses ?? []) {
    const bal = await readBalance(token, watch);
    if (bal > 0n) balances.set(watch.toLowerCase(), bal);
    else balances.delete(watch.toLowerCase());
  }

  const rows = buildHolderRows(balances, meta.totalSupply, 200);
  const top10 = top10Pct(rows, meta.totalSupply, balances);

  return {
    status: "ok",
    source: "rpc",
    count: balances.size,
    distribution: { top10 },
    holders: rows,
  };
}

export async function getWatchBalancesPct(
  token: Address,
  watches: Address[],
): Promise<{ address: string; pct: number | null; balance: bigint }[]> {
  const meta = await readTokenMeta(token);
  const out: { address: string; pct: number | null; balance: bigint }[] = [];
  for (const w of watches) {
    const balance = await readBalance(token, w);
    if (balance <= 0n) {
      out.push({ address: w, pct: null, balance: 0n });
    } else {
      out.push({ address: w, pct: pctOf(balance, meta.totalSupply), balance });
    }
  }
  return out;
}
