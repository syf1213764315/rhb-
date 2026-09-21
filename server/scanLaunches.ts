import type { Address, Hash, PublicClient } from "viem";
import { ROBIN_CONTRACTS, AIRLOCK_CREATE_TOPIC, TOKEN_CREATED_TOPIC } from "./chain.js";
import { isLaunchTarget } from "./create-detect.js";

const LAUNCH_ENTRY_SET = new Set(ROBIN_CONTRACTS.launchEntry.map((a) => a.toLowerCase()));

/** 单次 eth_getLogs 区块跨度（追块时分批） */
export const LAUNCH_LOG_CHUNK_BLOCKS = 1000n;

export type LaunchScanHit = {
  txHash: Hash;
  creator: Address;
  blockNumber: bigint;
};

/**
 * 用 Create / TokenCreated 事件追发币，比逐块 getBlock(含全量 tx) 快且不易追块落后。
 */
export async function scanLaunchesInBlockRange(
  client: PublicClient,
  fromBlock: bigint,
  toBlock: bigint,
  watchSet: Set<string>,
): Promise<{ createLogCount: number; hits: LaunchScanHit[] }> {
  const hits: LaunchScanHit[] = [];
  const seenTx = new Set<string>();
  let createLogCount = 0;

  for (let start = fromBlock; start <= toBlock; start += LAUNCH_LOG_CHUNK_BLOCKS) {
    const end =
      start + LAUNCH_LOG_CHUNK_BLOCKS - 1n > toBlock ? toBlock : start + LAUNCH_LOG_CHUNK_BLOCKS - 1n;

    const [airlockLogs, tokenCreatedLogs] = await Promise.all([
      client.getLogs({
        address: ROBIN_CONTRACTS.dopplerAirlock,
        topics: [AIRLOCK_CREATE_TOPIC],
        fromBlock: start,
        toBlock: end,
      }),
      client.getLogs({
        topics: [TOKEN_CREATED_TOPIC],
        fromBlock: start,
        toBlock: end,
      }),
    ]);

    const entryLogs = tokenCreatedLogs.filter((l) =>
      LAUNCH_ENTRY_SET.has(l.address.toLowerCase()),
    );
    createLogCount += airlockLogs.length + entryLogs.length;

    for (const log of [...airlockLogs, ...entryLogs]) {
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
  }

  return { createLogCount, hits };
}
