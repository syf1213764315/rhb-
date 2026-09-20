import { formatEther, type Address, type Hash } from "viem";
import { getPublicClient, getWalletAddress, resetClients } from "./clients.js";
import { isLaunchTarget, parseLaunchFromReceipt } from "./create-detect.js";
import { fetchTokenSummary } from "./agntApi.js";
import { loadSettings, saveSettings, validateSettingsForRun, type SnipeSettings } from "./settings.js";
import { quoteAndExecuteAgntBuy } from "./agntSwap.js";
import { readTokenMeta } from "./tokenMeta.js";
import { patchState, pushHit, pushLog } from "./state.js";
import { privateKeyConfigured } from "./secrets.js";
import { matchesAgntNameFilter } from "./tokenContext.js";
import { checkHolderFilter } from "./holderFilter.js";

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
  launch: { token: Address; creator: Address; txHash: Hash; poolKey: import("./create-detect.js").PoolKey | null },
  meta: Awaited<ReturnType<typeof readTokenMeta>>,
  signal: AbortSignal,
) {
  if (!privateKeyConfigured()) {
    pushLog("warn", "未配置私钥，仅记录发币，不执行买入");
    return;
  }

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

      if (!matchesAgntNameFilter(summary, fresh.nameFilter)) {
        pushLog("info", `跳过 ${summary.symbol} · 名称不匹配筛选「${fresh.nameFilter}」`);
        return;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
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

    const mcapOk = mcap >= fresh.minMarketCapUsd;
    let holderOk = true;
    let holderReason = "";
    if (fresh.holderFilterEnabled) {
      try {
        const h = await checkHolderFilter(launch.token, fresh);
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

    if (!holderOk) {
      patchState({
        phase: "watching_holders",
        lastMessage: `${displaySymbol} 市值已达标 · 持有人未达标: ${holderReason}`,
      });
      await sleep(fresh.pollIntervalSec * 1000, signal);
      continue;
    }

    if (mcapOk && holderOk) {
      patchState({
        phase: "buying",
        lastMessage: `市值+持有人达标，买入 ${displaySymbol} · ${fresh.buyEthAmount} ETH${holderReason ? ` · ${holderReason}` : ""}`,
      });

      let lastErr = "";
      for (let attempt = 1; attempt <= fresh.buyMaxRetries; attempt++) {
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

    const settings = loadSettings();
    const meta = await readTokenMeta(launch.token);

    if (settings.nameFilter.trim()) {
      try {
        const summary = await fetchTokenSummary(launch.token);
        if (!matchesAgntNameFilter(summary, settings.nameFilter)) {
          pushLog("info", `跳过 ${summary.symbol} · 名称不匹配筛选`);
          processedTx.add(txHash);
          return;
        }
      } catch {
        const localName = `${meta.name} ${meta.symbol}`;
        if (!localName.toLowerCase().includes(settings.nameFilter.trim().toLowerCase())) {
          pushLog("info", `跳过 ${meta.symbol} · agnt 未收录，链上名称不匹配`);
          processedTx.add(txHash);
          return;
        }
      }
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

function scanBlockTransactions(
  txs: readonly { from: Address; to: Address | null; hash: Hash }[],
  blockNumber: bigint,
  watchSet: Set<string>,
  signal: AbortSignal,
) {
  for (const tx of txs) {
    if (!watchSet.has(tx.from.toLowerCase())) continue;
    if (!isLaunchTarget(tx.to)) continue;
    void handleLaunchTx(tx.hash, tx.from, blockNumber, signal);
  }
}

export async function runWorker(signal: AbortSignal) {
  patchState({ running: true, phase: "idle", lastMessage: "Worker 已启动" });
  pushLog("info", "Robinhood 发币狙击 Worker 运行中（市值 summary · 买入 quote_v2）");

  let lastBlock: bigint | null = null;

  while (!signal.aborted) {
    resetClients();
    const settings = loadSettings();
    const err = validateSettingsForRun(settings);
    if (!settings.enabled) {
      patchState({ phase: "idle", lastMessage: "监控未启用，请在网页保存并开启" });
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
        pushLog("info", `从区块 ${latest} 开始监控 · RPC ${settings.rpcHttpUrl}`);
        patchState({ lastBlock: Number(latest), lastMessage: `监控 ${watchSet.size} 个地址` });
      } else if (latest > lastBlock) {
        const from = lastBlock + 1n;
        for (let b = from; b <= latest; b++) {
          const block = await client.getBlock({ blockNumber: b, includeTransactions: true });
          const txs = block.transactions.filter((t) => typeof t !== "string") as {
            from: Address;
            to: Address | null;
            hash: Hash;
          }[];
          scanBlockTransactions(txs, b, watchSet, signal);
        }
        lastBlock = latest;
        patchState({ lastBlock: Number(latest), phase: "polling" });
      } else {
        patchState({ phase: "polling", lastMessage: "等待新区块…" });
      }
    } catch (e) {
      if (signal.aborted) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      pushLog("err", `轮询异常 · ${msg}`);
      patchState({ phase: "error", lastMessage: msg });
    }

    await sleep(loadSettings().pollIntervalSec * 1000, signal);
  }
}
