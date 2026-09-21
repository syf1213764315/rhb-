import { formatEther, type Address, type Hash } from "viem";
import { getPublicClient, getWalletAddress, resetClients } from "./clients.js";
import { parseLaunchFromReceipt, type LaunchEvent } from "./create-detect.js";
import { fetchTokenSummary } from "./agntApi.js";
import { loadSettings, saveSettings, validateSettingsForRun, type SnipeSettings } from "./settings.js";
import { quoteAndExecuteAgntBuy } from "./agntSwap.js";
import { readTokenMeta } from "./tokenMeta.js";
import { patchState, pushHit, pushLog } from "./state.js";
import { privateKeyConfigured } from "./secrets.js";
import { matchesTokenNameFilter } from "./tokenContext.js";
import { checkHolderFilter } from "./holderFilter.js";
import { scanLaunchesInBlockRange } from "./scanLaunches.js";

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

const processedTx = new Set<string>();
const inFlight = new Set<string>();

async function refreshWallet() {
  const client = getPublicClient();
  const addr = getWalletAddress();
  if (!addr) {
    patchState({ walletAddress: null, ethBalance: null });
    return;
  }
  const bal = await client.getBalance({ address: addr });
  patchState({ walletAddress: addr, ethBalance: formatEther(bal) });
}

async function waitMarketCapAndBuy(
  settings: SnipeSettings,
  launch: LaunchEvent,
  meta: Awaited<ReturnType<typeof readTokenMeta>>,
  signal: AbortSignal,
) {
  if (!privateKeyConfigured()) {
    pushLog("warn", "未配置私钥，仅记录发币，不执行买入");
    return;
  }

  pushLog(
    "info",
    `进入市值/持有人跟踪 · ${meta.symbol} · 阈值 $${settings.minMarketCapUsd} · 最长 10 分钟`,
  );

  const deadline = Date.now() + 10 * 60_000;
  let displaySymbol = meta.symbol;
  let displayName = meta.name;

  while (!signal.aborted && Date.now() < deadline) {
    const fresh = loadSettings();
    let mcap = 0;
    let summary: Awaited<ReturnType<typeof fetchTokenSummary>> | null = null;

    try {
      summary = await fetchTokenSummary(launch.token);
      mcap = summary.market_cap;
      displaySymbol = summary.symbol;
      displayName = summary.name;

      if (
        !matchesTokenNameFilter(fresh.nameFilter, [
          { name: meta.name, symbol: meta.symbol },
          { name: summary.name, symbol: summary.symbol },
        ])
      ) {
        pushLog(
          "info",
          `跳过 ${summary.symbol} · 名称不匹配筛选「${fresh.nameFilter}」（不区分大小写）`,
        );
        return;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushLog("info", `${displaySymbol} · 等待 agnt 收录 · ${msg.slice(0, 80)}`);
      patchState({
        phase: "watching_mcap",
        lastMessage: `${displaySymbol} · 等待 agnt 收录… (${msg.slice(0, 60)})`,
      });
      await sleep(fresh.pollIntervalSec * 1000, signal);
      continue;
    }

    patchState({
      phase: "watching_mcap",
      lastMessage: `${displaySymbol} 市值 $${mcap.toFixed(0)} (agnt) / 阈值 $${fresh.minMarketCapUsd}`,
    });
    pushLog(
      "info",
      `市值轮询 · ${displaySymbol} $${mcap.toFixed(0)} / 阈值 $${fresh.minMarketCapUsd}`,
    );

    const mcapOk = mcap >= fresh.minMarketCapUsd;
    let holderOk = true;
    let holderReason = "";
    if (fresh.holderFilterEnabled) {
      try {
        const h = await checkHolderFilter(launch.token, fresh, { fromBlock: launch.blockNumber });
        holderOk = h.ok;
        holderReason = h.reason;
      } catch (e) {
        holderOk = false;
        holderReason = e instanceof Error ? e.message : String(e);
      }
    }

    if (!mcapOk) {
      patchState({
        phase: "watching_mcap",
        lastMessage: `${displaySymbol} 市值 $${mcap.toFixed(0)} / 阈值 $${fresh.minMarketCapUsd}`,
      });
      await sleep(fresh.pollIntervalSec * 1000, signal);
      continue;
    }

    if (fresh.holderFilterEnabled) {
      pushLog(
        "info",
        `持有人检查 · ${displaySymbol} · ${holderOk ? "通过" : "未达标"} · ${holderReason || "—"}`,
      );
    }

    if (!holderOk) {
      patchState({
        phase: "watching_holders",
        lastMessage: `${displaySymbol} 市值已达标 · 持有人未达标: ${holderReason}`,
      });
      await sleep(fresh.pollIntervalSec * 1000, signal);
      continue;
    }

    if (mcapOk && holderOk) {
      pushLog(
        "ok",
        `市值+持有人达标 · 开始买入 ${displaySymbol} · ${fresh.buyEthAmount} ETH`,
      );
      patchState({
        phase: "buying",
        lastMessage: `市值+持有人达标，买入 ${displaySymbol} · ${fresh.buyEthAmount} ETH${holderReason ? ` · ${holderReason}` : ""}`,
      });

      let lastErr = "";
      for (let attempt = 1; attempt <= fresh.buyMaxRetries; attempt++) {
        pushLog("info", `买入尝试 ${attempt}/${fresh.buyMaxRetries} · ${displaySymbol}`);
        try {
          const buy = await quoteAndExecuteAgntBuy({
            buyToken: launch.token,
            ethAmount: fresh.buyEthAmount,
            slippageBps: fresh.slippageBps,
            execute: true,
          });
          if (buy.mode !== "swap" || !buy.txHash) throw new Error("quote_v2 未返回成交哈希");
          const buyHash = buy.txHash;
          pushLog("ok", `买入成功 · ${displaySymbol} · ${fresh.buyEthAmount} ETH · ${buyHash}`);
          pushHit({
            id: launch.txHash,
            at: new Date().toISOString(),
            creator: launch.creator,
            token: launch.token,
            name: displayName,
            symbol: displaySymbol,
            marketCapUsd: mcap,
            createTx: launch.txHash,
            buyTx: buyHash,
          });
          patchState({ phase: "success", lastMessage: `买入成功 ${buyHash}` });
          if (fresh.stopAfterBuy) {
            saveSettings({ ...loadSettings(), enabled: false });
            pushLog("info", "已按设置停止监控");
          }
          return;
        } catch (e) {
          lastErr = e instanceof Error ? e.message : String(e);
          pushLog("warn", `买入重试 ${attempt}/${fresh.buyMaxRetries} · ${lastErr.slice(0, 100)}`);
          await sleep(1500, signal);
        }
      }
      pushHit({
        id: launch.txHash,
        at: new Date().toISOString(),
        creator: launch.creator,
        token: launch.token,
        name: displayName,
        symbol: displaySymbol,
        marketCapUsd: mcap,
        createTx: launch.txHash,
        buyError: lastErr,
      });
      patchState({ phase: "error", lastMessage: `买入失败 · ${lastErr}` });
      return;
    }
  }
  pushLog("warn", `${displaySymbol} 等待市值超时`);
}

async function handleLaunchTx(
  txHash: Hash,
  creator: Address,
  blockNumber: bigint,
  signal: AbortSignal,
) {
  if (processedTx.has(txHash) || inFlight.has(txHash)) return;
  inFlight.add(txHash);

  try {
    const client = getPublicClient();
    const receipt = await client.getTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      pushLog("warn", `发币交易 revert · ${txHash.slice(0, 12)}…`);
      processedTx.add(txHash);
      return;
    }

    const launch = parseLaunchFromReceipt(receipt, creator);
    if (!launch) {
      pushLog("warn", `无法解析发币事件 · ${txHash.slice(0, 12)}…`);
      processedTx.add(txHash);
      return;
    }

    pushLog(
      "info",
      `发币候选 · tx ${txHash.slice(0, 12)}… · creator ${creator.slice(0, 10)}… · 区块 ${blockNumber}`,
    );

    const settings = loadSettings();
    const meta = await readTokenMeta(launch.token);
    let summary: Awaited<ReturnType<typeof fetchTokenSummary>> | null = null;
    try {
      summary = await fetchTokenSummary(launch.token);
    } catch {
      /* agnt 未收录时用链上 name/symbol */
    }

    if (settings.nameFilter.trim()) {
      const ok = matchesTokenNameFilter(settings.nameFilter, [
        { name: meta.name, symbol: meta.symbol },
        summary,
      ]);
      if (!ok) {
        pushLog(
          "info",
          `跳过 ${meta.symbol}（链上 ${meta.name}/${meta.symbol}${
            summary ? ` · agnt ${summary.name}/${summary.symbol}` : ""
          }）· 不匹配筛选「${settings.nameFilter}」（不区分大小写）`,
        );
        processedTx.add(txHash);
        return;
      }
      pushLog(
        "info",
        `名称筛选通过 · 「${settings.nameFilter}」↔ ${meta.symbol}/${meta.name}${
          summary ? ` · agnt ${summary.symbol}` : ""
        }`,
      );
    }

    pushLog(
      "ok",
      `捕获发币 · ${creator.slice(0, 8)}… → ${meta.symbol} (${launch.token.slice(0, 8)}…) · 区块 ${blockNumber}`,
    );

    await waitMarketCapAndBuy(settings, launch, meta, signal);
    processedTx.add(txHash);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    pushLog("err", `处理发币失败 · ${msg}`);
  } finally {
    inFlight.delete(txHash);
  }
}

function dispatchLaunchHits(
  hits: { txHash: Hash; creator: Address; blockNumber: bigint }[],
  signal: AbortSignal,
): number {
  for (const h of hits) {
    pushLog(
      "info",
      `区块 ${h.blockNumber} · 监控地址发币 tx ${h.txHash.slice(0, 12)}…（事件扫描）`,
    );
    void handleLaunchTx(h.txHash, h.creator, h.blockNumber, signal);
  }
  return hits.length;
}

export async function runWorker(signal: AbortSignal) {
  patchState({ running: true, phase: "idle", lastMessage: "Worker 已启动" });
  pushLog("info", "Robinhood 发币狙击 Worker 运行中（市值 summary · 买入 quote_v2）");

  let lastBlock: bigint | null = null;
  let resetBlockCursor = false;

  const onReset = () => {
    resetBlockCursor = true;
  };
  resetBlockCursorListeners.add(onReset);
  try {
    while (!signal.aborted) {
      if (resetBlockCursor) {
        lastBlock = null;
        resetBlockCursor = false;
        patchState({ lastBlock: null, lastMessage: "区块游标已重置" });
      }

      resetClients();
    const settings = loadSettings();
    const err = validateSettingsForRun(settings);
    if (!settings.enabled) {
      patchState({ phase: "idle", lastMessage: "监控未启用（暂停/停止中，可点「重启监控」恢复）" });
      pushLog("info", "轮询 · 监控未启用，等待恢复…");
      await sleep(3000, signal);
      continue;
    }
    if (err) {
      patchState({ phase: "error", lastMessage: err });
      await sleep(5000, signal);
      continue;
    }
    if (!privateKeyConfigured()) {
      patchState({ phase: "error", lastMessage: "请配置 config.json 中的 privateKey 才能自动买入" });
    }

    const watchSet = new Set(settings.watchAddresses.map((a) => a.toLowerCase()));

    try {
      await refreshWallet();
      const client = getPublicClient();
      const latest = await client.getBlockNumber();

      if (lastBlock === null) {
        lastBlock = latest;
        pushLog("info", `从区块 ${latest} 开始监控 · HTTP RPC ${settings.rpcHttpUrl}`);
        patchState({ lastBlock: Number(latest), lastMessage: `监控 ${watchSet.size} 个地址` });
        pushLog(
          "info",
          `轮询 · 链头 ${latest} · 游标 ${latest} · 已对齐链头（下一周期扫描新区块）`,
        );
      } else if (latest > lastBlock) {
        let cursor = lastBlock;
        let totalCreateLogs = 0;
        let totalCandidates = 0;
        let chainTip = latest;

        while (cursor < chainTip && !signal.aborted) {
          const from = cursor + 1n;
          let to = chainTip;
          const span = to - from + 1n;
          pushLog(
            "info",
            `轮询 · 链头 ${chainTip} · 事件扫描区块 ${from}–${to}（${span} 块）`,
          );

          const { createLogCount, hits, usedBlockFallback } = await scanLaunchesInBlockRange(
            client,
            from,
            to,
            watchSet,
          );
          if (usedBlockFallback) {
            pushLog(
              "warn",
              `RPC 无历史 logs · 区块 ${from}–${to} 已改用逐块交易扫描（${hits.length} 笔候选）`,
            );
          }
          totalCreateLogs += createLogCount;
          totalCandidates += dispatchLaunchHits(hits, signal);

          cursor = to;
          lastBlock = cursor;
          patchState({ lastBlock: Number(lastBlock), phase: "polling" });

          if (cursor < chainTip) {
            chainTip = await client.getBlockNumber();
            pushLog(
              "info",
              `追块中 · 游标 ${cursor} · 链头 ${chainTip} · 本批 Create 日志 ${createLogCount} · 候选 ${hits.length}`,
            );
          } else {
            pushLog(
              "info",
              `扫描完成 · 游标 → ${cursor} · Create 日志 ${totalCreateLogs} · 发币候选 ${totalCandidates} 笔`,
            );
          }
        }
      } else {
        pushLog("info", `轮询 · 链头 ${latest} · 游标 ${lastBlock} · 无新区块`);
        patchState({ phase: "polling", lastMessage: `等待新区块… · 链头 ${latest}` });
      }
    } catch (e) {
      if (signal.aborted) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      const detail =
        e && typeof e === "object" && "shortMessage" in e
          ? String((e as { shortMessage?: string }).shortMessage)
          : "";
      const cause =
        e instanceof Error && e.cause instanceof Error ? ` · ${e.cause.message}` : "";
      pushLog("err", `轮询异常 · ${detail || msg}${cause}`);
      patchState({ phase: "error", lastMessage: detail || msg });
    }

    await sleep(loadSettings().pollIntervalSec * 1000, signal);
    }
  } finally {
    resetBlockCursorListeners.delete(onReset);
  }
}

const resetBlockCursorListeners = new Set<() => void>();

export function requestBlockCursorReset() {
  for (const fn of resetBlockCursorListeners) fn();
}
