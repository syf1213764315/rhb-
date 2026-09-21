import type { Address, Hash, Log, PublicClient } from "viem";
import { ROBIN_CONTRACTS, AIRLOCK_CREATE_TOPIC, TOKEN_CREATED_TOPIC } from "./chain.js";
import { isLaunchTarget } from "./create-detect.js";

/** Pocket 等 RPC 对大范围 getLogs 易报 historical state is not available */
export const LAUNCH_LOG_CHUNK_BLOCKS = 80n;

const MIN_LOG_CHUNK = 8n;

export type LaunchScanHit = {
  txHash: Hash;
  creator: Address;
  blockNumber: bigint;
};

function isLogsUnavailableError(e: unknown): boolean {
  const parts: string[] = [];
  if (e instanceof Error) {
    parts.push(e.message);
    if (e.cause instanceof Error) parts.push(e.cause.message);
  } else parts.push(String(e));
  const msg = parts.join(" ").toLowerCase();
  return (
    msg.includes("historical state") ||
    msg.includes("missing or invalid parameters") ||
    msg.includes("invalid params")
  );
}

async function fetchCreateLogsChunk(
  client: PublicClient,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Log[]> {
  const airlockLogs = await client.getLogs({
    address: ROBIN_CONTRACTS.dopplerAirlock,
    topics: [AIRLOCK_CREATE_TOPIC],
    fromBlock: fromBlock,
    toBlock: toBlock,
  });

  const entryLogs = (
    await Promise.all(
      ROBIN_CONTRACTS.launchEntry.map((address) =>
        client.getLogs({
          address,
          topics: [TOKEN_CREATED_TOPIC],
          fromBlock: fromBlock,
          toBlock: toBlock,
        }),
      ),
    )
  ).flat();

  return [...airlockLogs, ...entryLogs];
}

async function hitsFromLogs(
  client: PublicClient,
  logs: Log[],
  watchSet: Set<string>,
  seenTx: Set<string>,
): Promise<LaunchScanHit[]> {
  const hits: LaunchScanHit[] = [];
  for (const log of logs) {
    const txHash = log.transactionHash;
    if (seenTx.has(txHash)) continue;
    seenTx.add(txHash);

    const tx = await client.getTransaction({ hash: txHash });
    if (!watchSet.has(tx.from.toLowerCase())) continue;
    if (!isLaunchTarget(tx.to)) continue;

    hits.push({
      txHash,
      creator: tx.from,
      blockNumber: log.blockNumber,
    });
  }
  return hits;
}

/** getLogs 不可用时：逐块扫监控地址 → Airlock / launch 入口 的交易 */
async function scanLaunchesByBlockTxs(
  client: PublicClient,
  fromBlock: bigint,
  toBlock: bigint,
  watchSet: Set<string>,
  seenTx: Set<string>,
): Promise<{ createLogCount: number; hits: LaunchScanHit[] }> {
  const hits: LaunchScanHit[] = [];
  for (let b = fromBlock; b <= toBlock; b++) {
    const block = await client.getBlock({ blockNumber: b, includeTransactions: true });
    for (const t of block.transactions) {
      if (typeof t === "string") continue;
      if (!watchSet.has(t.from.toLowerCase())) continue;
      if (!isLaunchTarget(t.to)) continue;
      if (seenTx.has(t.hash)) continue;
      seenTx.add(t.hash);
      hits.push({ txHash: t.hash, creator: t.from, blockNumber: b });
    }
  }
  return { createLogCount: 0, hits };
}

async function scanLaunchesChunk(
  client: PublicClient,
  fromBlock: bigint,
  toBlock: bigint,
  watchSet: Set<string>,
  seenTx: Set<string>,
): Promise<{ createLogCount: number; hits: LaunchScanHit[]; viaBlockFallback: boolean }> {
  const span = toBlock - fromBlock + 1n;
  try {
    const logs = await fetchCreateLogsChunk(client, fromBlock, toBlock);
    const hits = await hitsFromLogs(client, logs, watchSet, seenTx);
    return { createLogCount: logs.length, hits, viaBlockFallback: false };
  } catch (e) {
    if (!isLogsUnavailableError(e)) throw e;

    if (span > MIN_LOG_CHUNK) {
      const mid = fromBlock + span / 2n;
      const left = await scanLaunchesChunk(client, fromBlock, mid, watchSet, seenTx);
      const right = await scanLaunchesChunk(client, mid + 1n, toBlock, watchSet, seenTx);
      return {
        createLogCount: left.createLogCount + right.createLogCount,
        hits: [...left.hits, ...right.hits],
        viaBlockFallback: left.viaBlockFallback || right.viaBlockFallback,
      };
    }

    const fb = await scanLaunchesByBlockTxs(client, fromBlock, toBlock, watchSet, seenTx);
    return { ...fb, viaBlockFallback: true };
  }
}

export async function scanLaunchesInBlockRange(
  client: PublicClient,
  fromBlock: bigint,
  toBlock: bigint,
  watchSet: Set<string>,
): Promise<{ createLogCount: number; hits: LaunchScanHit[]; usedBlockFallback: boolean }> {
  const seenTx = new Set<string>();
  let createLogCount = 0;
  const hits: LaunchScanHit[] = [];
  let usedBlockFallback = false;

  for (let start = fromBlock; start <= toBlock; start += LAUNCH_LOG_CHUNK_BLOCKS) {
    const end =
      start + LAUNCH_LOG_CHUNK_BLOCKS - 1n > toBlock ? toBlock : start + LAUNCH_LOG_CHUNK_BLOCKS - 1n;

    const chunk = await scanLaunchesChunk(client, start, end, watchSet, seenTx);
    createLogCount += chunk.createLogCount;
    hits.push(...chunk.hits);
    if (chunk.viaBlockFallback) usedBlockFallback = true;
  }

  return { createLogCount, hits, usedBlockFallback };
}
