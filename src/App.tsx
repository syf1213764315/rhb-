import { useCallback, useEffect, useRef, useState } from "react";
import { fetchApiJson } from "./api";

type CompareOp = "gt" | "lt" | "eq";

type SnipeSettings = {
  enabled: boolean;
  watchAddresses: string[];
  nameFilter: string;
  minMarketCapUsd: number;
  marketCapCompareOp?: CompareOp;
  ethUsdPrice: number;
  buyEthAmount: string;
  slippageBps: number;
  pollIntervalSec: number;
  stopAfterBuy: boolean;
  buyMaxRetries: number;
  rpcWsUrl: string;
  rpcHttpUrl: string;
  holderFilterEnabled: boolean;
  holderWatchAddresses: string[];
  holderMode: "any" | "all";
  holderMinPct: number;
  holderMinPctCompareOp?: CompareOp;
  holderMaxTop10Pct: number;
  holderMaxTop10CompareOp?: CompareOp;
  holderRequireListed: boolean;
};

type Status = {
  running: boolean;
  phase: string;
  lastMessage: string;
  lastBlock: number | null;
  walletAddress: string | null;
  ethBalance: string | null;
  privateKeyConfigured: boolean;
  workerRunning: boolean;
  monitoringEnabled?: boolean;
  settings: SnipeSettings;
  hits: {
    token: string;
    symbol: string;
    name: string;
    marketCapUsd: number;
    createTx: string;
    buyTx?: string;
    buyError?: string;
  }[];
  logs: { time: string; level: string; message: string }[];
};

const PHASE: Record<string, string> = {
  idle: "空闲",
  polling: "扫块中",
  watching_mcap: "盯市值",
  watching_holders: "盯持有人",
  buying: "买入中",
  success: "成功",
  error: "异常",
};

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [watchText, setWatchText] = useState("");
  const [nameFilter, setNameFilter] = useState("");
  const [minMcap, setMinMcap] = useState("10000");
  const [marketCapCompareOp, setMarketCapCompareOp] = useState<CompareOp>("gt");
  const [ethUsd, setEthUsd] = useState("3000");
  const [buyEth, setBuyEth] = useState("0.01");
  const [slippagePct, setSlippagePct] = useState("5");
  const [pollSec, setPollSec] = useState("2");
  const [enabled, setEnabled] = useState(false);
  const [stopAfterBuy, setStopAfterBuy] = useState(false);
  const [rpcWs, setRpcWs] = useState("wss://robinhood.api.pocket.network");
  const [rpcHttp, setRpcHttp] = useState("https://robinhood.api.pocket.network");
  const [holderEnabled, setHolderEnabled] = useState(false);
  const [holderWatchText, setHolderWatchText] = useState("");
  const [holderMode, setHolderMode] = useState<"any" | "all">("any");
  const [holderMinPct, setHolderMinPct] = useState("0");
  const [holderMinPctCompareOp, setHolderMinPctCompareOp] = useState<CompareOp>("gt");
  const [holderMaxTop10, setHolderMaxTop10] = useState("0");
  const [holderMaxTop10CompareOp, setHolderMaxTop10CompareOp] = useState<CompareOp>("lt");
  const [holderRequireListed, setHolderRequireListed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [workerBusy, setWorkerBusy] = useState("");

  const [testToken, setTestToken] = useState("");
  const [testEth, setTestEth] = useState("0.001");
  const [testSlippagePct, setTestSlippagePct] = useState("1");
  const [testSwapMode, setTestSwapMode] = useState<"agnt" | "v4">("agnt");
  const [testPoolJson, setTestPoolJson] = useState("");
  const [testBusy, setTestBusy] = useState("");
  const [testResult, setTestResult] = useState("");

  const formHydrated = useRef(false);

  const applyFormFromSettings = useCallback((s: SnipeSettings) => {
    setWatchText(s.watchAddresses.join("\n"));
    setNameFilter(s.nameFilter);
    setMinMcap(String(s.minMarketCapUsd));
    setMarketCapCompareOp(s.marketCapCompareOp ?? "gt");
    setEthUsd(String(s.ethUsdPrice));
    setBuyEth(s.buyEthAmount);
    setSlippagePct(String(s.slippageBps / 100));
    setPollSec(String(s.pollIntervalSec));
    setEnabled(s.enabled);
    setStopAfterBuy(s.stopAfterBuy);
    setRpcWs(s.rpcWsUrl);
    setRpcHttp(s.rpcHttpUrl);
    setHolderEnabled(s.holderFilterEnabled ?? false);
    setHolderWatchText((s.holderWatchAddresses ?? []).join("\n"));
    setHolderMode(s.holderMode === "all" ? "all" : "any");
    setHolderMinPct(String(s.holderMinPct ?? 0));
    setHolderMinPctCompareOp(s.holderMinPctCompareOp ?? "gt");
    setHolderMaxTop10(String(s.holderMaxTop10Pct ?? 0));
    setHolderMaxTop10CompareOp(s.holderMaxTop10CompareOp ?? "lt");
    setHolderRequireListed(!!s.holderRequireListed);
  }, []);

  const refresh = useCallback(async () => {
    const data = await fetchApiJson<Status>("/api/status");
    setStatus(data);
    if (!formHydrated.current) {
      applyFormFromSettings(data.settings);
      formHydrated.current = true;
    }
  }, [applyFormFromSettings]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [refresh]);

  function parseOptionalPoolKey(): Record<string, string | number> | undefined {
    const t = testPoolJson.trim();
    if (!t) return undefined;
    const o = JSON.parse(t) as Record<string, string | number>;
    return o;
  }

  async function v4Test(execute: boolean) {
    if (!testToken.trim()) {
      setTestResult("请填写代币地址");
      return;
    }
    setTestBusy(execute ? "swap" : "quote");
    setTestResult("");
    try {
      let poolKey: Record<string, string | number> | undefined;
      try {
        poolKey = parseOptionalPoolKey();
      } catch {
        throw new Error("PoolKey JSON 格式无效");
      }
      const data = await fetchApiJson<Record<string, unknown>>("/api/v4/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: testToken.trim(),
          ethAmount: testEth,
          slippageBps: Math.round(Number(testSlippagePct) * 100),
          execute,
          swapMode: testSwapMode,
          poolKey,
        }),
      });
      setTestResult(JSON.stringify(data, null, 2));
      void refresh();
    } catch (e) {
      setTestResult(e instanceof Error ? e.message : String(e));
    } finally {
      setTestBusy("");
    }
  }

  async function queryHoldersForTest() {
    const addr = testToken.trim() || holderWatchText.split(/\s+/)[0]?.trim();
    if (!addr) {
      setTestResult("请填写代币地址");
      return;
    }
    setTestBusy("holders");
    setTestResult("");
    try {
      const data = await fetchApiJson<{ holders: unknown; check: { ok: boolean; reason: string } }>(
        `/api/token/holders?token=${encodeURIComponent(addr)}`,
      );
      setTestResult(JSON.stringify(data, null, 2));
    } catch (e) {
      setTestResult(e instanceof Error ? e.message : String(e));
    } finally {
      setTestBusy("");
    }
  }

  async function v4LookupPool() {
    if (!testToken.trim()) {
      setTestResult("请填写代币地址");
      return;
    }
    setTestBusy("pool");
    setTestResult("");
    try {
      const data = await fetchApiJson<{
        poolKey?: unknown;
      }>(`/api/token/summary?token=${encodeURIComponent(testToken.trim())}`);
      if (data.poolKey) {
        setTestPoolJson(JSON.stringify(data.poolKey, null, 2));
      }
      setTestResult(JSON.stringify(data, null, 2));
    } catch (e) {
      setTestResult(e instanceof Error ? e.message : String(e));
    } finally {
      setTestBusy("");
    }
  }

  async function workerControl(action: "pause" | "stop" | "restart") {
    setWorkerBusy(action);
    setMsg("");
    try {
      const data = await fetchApiJson<{ ok: boolean; settings: SnipeSettings }>(`/api/worker/${action}`, {
        method: "POST",
      });
      applyFormFromSettings(data.settings);
      setEnabled(data.settings.enabled);
      const labels = { pause: "已暂停监控", stop: "已停止监控", restart: "已重启监控" };
      setMsg(labels[action]);
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setWorkerBusy("");
    }
  }

  async function save() {
    setSaving(true);
    setMsg("");
    try {
      const addresses = watchText
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const holderAddresses = holderWatchText
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const saved = await fetchApiJson<{ ok: boolean; settings: SnipeSettings }>("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          watchAddresses: addresses,
          nameFilter,
          minMarketCapUsd: Number(minMcap),
          marketCapCompareOp,
          ethUsdPrice: Number(ethUsd),
          buyEthAmount: buyEth.trim(),
          slippageBps: Math.round(Number(slippagePct) * 100),
          pollIntervalSec: Number(pollSec),
          stopAfterBuy,
          rpcWsUrl: rpcWs.trim(),
          rpcHttpUrl: rpcHttp.trim(),
          holderFilterEnabled: holderEnabled,
          holderWatchAddresses: holderAddresses,
          holderMode,
          holderMinPct: Number(holderMinPct),
          holderMinPctCompareOp,
          holderMaxTop10Pct: Number(holderMaxTop10),
          holderMaxTop10CompareOp,
          holderRequireListed,
        }),
      });
      applyFormFromSettings(saved.settings);
      setMsg(`已保存（监控买入 ${saved.settings.buyEthAmount} ETH）。Worker 每次买入前会重新读 settings.json。`);
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page">
      <header>
        <h1>Robinhood 发币狙击</h1>
        <p className="sub">
          监控 pools.trade 发币 · 市值 summary · 达标后 agnt quote_v2 买入 · 链 ID 4663
        </p>
      </header>

      <section className="card status">
        <div className="row">
          <span>Worker</span>
          <strong className={status?.workerRunning ? "ok" : "warn"}>
            {status?.workerRunning ? "运行中（独立于浏览器）" : "—"}
          </strong>
        </div>
        <div className="row">
          <span>阶段</span>
          <strong>{status ? (PHASE[status.phase] ?? status.phase) : "—"}</strong>
        </div>
        <div className="row">
          <span>说明</span>
          <span className="muted">{status?.lastMessage ?? "—"}</span>
        </div>
        <div className="row">
          <span>区块</span>
          <span>{status?.lastBlock ?? "—"}</span>
        </div>
        <div className="row">
          <span>已保存买入量</span>
          <strong>{status?.settings.buyEthAmount ?? "—"} ETH</strong>
        </div>
        <div className="row">
          <span>钱包</span>
          <span>
            {status?.walletAddress ?? "未配置私钥"}
            {status?.ethBalance ? ` · ${status.ethBalance} ETH` : ""}
          </span>
        </div>
        <div className="row">
          <span>监控开关</span>
          <strong className={status?.monitoringEnabled ?? status?.settings.enabled ? "ok" : "warn"}>
            {status?.monitoringEnabled ?? status?.settings.enabled ? "已启用" : "已关闭"}
          </strong>
        </div>
        <div className="worker-actions">
          <button type="button" disabled={!!workerBusy} onClick={() => void workerControl("pause")}>
            {workerBusy === "pause" ? "…" : "暂停监控"}
          </button>
          <button type="button" disabled={!!workerBusy} onClick={() => void workerControl("stop")}>
            {workerBusy === "stop" ? "…" : "停止监控"}
          </button>
          <button type="button" className="primary" disabled={!!workerBusy} onClick={() => void workerControl("restart")}>
            {workerBusy === "restart" ? "…" : "重启监控"}
          </button>
        </div>
        <p className="sub worker-hint">
          暂停/停止：关闭 enabled；停止并重置区块游标。重启：重新拉起 Worker 并从最新区块扫块（enabled=true）。
        </p>
      </section>

      <section className="card">
        <h2>监控与买入</h2>
        <label>
          发币地址（每行一个）
          <textarea
            rows={4}
            value={watchText}
            onChange={(e) => setWatchText(e.target.value)}
            placeholder="0xCreator1…"
          />
        </label>
        <label>
          代币名称筛选（包含匹配、不区分大小写，留空=全部）
          <input value={nameFilter} onChange={(e) => setNameFilter(e.target.value)} placeholder="例如 PEPE" />
        </label>
        <div className="grid2">
          <label>
            市值 USD
            <input value={minMcap} onChange={(e) => setMinMcap(e.target.value)} />
          </label>
          <label>
            市值条件
            <select
              value={marketCapCompareOp}
              onChange={(e) => setMarketCapCompareOp(e.target.value as CompareOp)}
            >
              <option value="gt">大于</option>
              <option value="lt">小于</option>
              <option value="eq">等于</option>
            </select>
          </label>
          <label>
            ETH/USD 估价
            <input value={ethUsd} onChange={(e) => setEthUsd(e.target.value)} />
          </label>
          <label>
            买入 ETH
            <input value={buyEth} onChange={(e) => setBuyEth(e.target.value)} />
          </label>
          <label>
            滑点 %
            <input value={slippagePct} onChange={(e) => setSlippagePct(e.target.value)} />
          </label>
          <label>
            轮询间隔（秒）
            <input value={pollSec} onChange={(e) => setPollSec(e.target.value)} />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          启用后台监控
        </label>
        <label className="check">
          <input type="checkbox" checked={stopAfterBuy} onChange={(e) => setStopAfterBuy(e.target.checked)} />
          买入成功后自动停止
        </label>

        <h3>持有人条件（可选）</h3>
        <p className="sub" style={{ marginTop: 0 }}>
          市值达标后，通过链上 RPC（Transfer 日志 + balanceOf）计算监控钱包持仓 %，满足后再买入。
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={holderEnabled}
            onChange={(e) => setHolderEnabled(e.target.checked)}
          />
          启用持有人买入条件
        </label>
        <label>
          监控钱包（每行一个）
          <textarea
            rows={3}
            value={holderWatchText}
            onChange={(e) => setHolderWatchText(e.target.value)}
            placeholder="0xb0362b41a673cf7d11f2e5b4859a075ee897d9c4"
          />
        </label>
        <div className="grid2">
          <label>
            条件模式
            <select value={holderMode} onChange={(e) => setHolderMode(e.target.value as "any" | "all")}>
              <option value="any">任一地址持仓达标</option>
              <option value="all">全部地址都要达标</option>
            </select>
          </label>
          <label>
            持仓 % 阈值
            <input value={holderMinPct} onChange={(e) => setHolderMinPct(e.target.value)} />
          </label>
          <label>
            持仓条件
            <select
              value={holderMinPctCompareOp}
              onChange={(e) => setHolderMinPctCompareOp(e.target.value as CompareOp)}
            >
              <option value="gt">大于</option>
              <option value="lt">小于</option>
              <option value="eq">等于</option>
            </select>
          </label>
          <label>
            Top10 阈值 %（0=不限制）
            <input value={holderMaxTop10} onChange={(e) => setHolderMaxTop10(e.target.value)} />
          </label>
          <label>
            Top10 条件
            <select
              value={holderMaxTop10CompareOp}
              onChange={(e) => setHolderMaxTop10CompareOp(e.target.value as CompareOp)}
            >
              <option value="gt">大于</option>
              <option value="lt">小于</option>
              <option value="eq">等于</option>
            </select>
          </label>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={holderRequireListed}
            onChange={(e) => setHolderRequireListed(e.target.checked)}
          />
          监控地址链上持仓必须 &gt; 0
        </label>

        <h3>RPC</h3>
        <label>
          WebSocket
          <input value={rpcWs} onChange={(e) => setRpcWs(e.target.value)} />
        </label>
        <label>
          HTTP（发交易）
          <input value={rpcHttp} onChange={(e) => setRpcHttp(e.target.value)} />
        </label>
        <button type="button" className="primary" disabled={saving} onClick={() => void save()}>
          {saving ? "保存中…" : "保存并运行"}
        </button>
        {msg && <p className="msg">{msg}</p>}
        {!status?.privateKeyConfigured && (
          <p className="warn-box">请在 <code>robin/config.json</code> 配置 <code>privateKey</code> 后才能自动买入。</p>
        )}
      </section>

      <section className="card v4-test">
        <h2>V4 交易测试</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          默认与网页一致：<code>quote_v2</code>（Relay 充值 + 路由成交）。可选「直连 V4」走 Universal Router。
        </p>
        <label>
          买入方式
          <select value={testSwapMode} onChange={(e) => setTestSwapMode(e.target.value as "agnt" | "v4")}>
            <option value="agnt">agnt quote_v2（推荐，与官网相同）</option>
            <option value="v4">直连 Uniswap V4</option>
          </select>
        </label>
        <label>
          代币地址
          <input
            value={testToken}
            onChange={(e) => setTestToken(e.target.value)}
            placeholder="0x…"
          />
        </label>
        <div className="grid2">
          <label>
            测试买入 ETH
            <input value={testEth} onChange={(e) => setTestEth(e.target.value)} />
          </label>
          <label>
            滑点 %
            <input value={testSlippagePct} onChange={(e) => setTestSlippagePct(e.target.value)} />
          </label>
        </div>
        <details className="advanced">
          <summary>高级：手动 PoolKey（一般不需要）</summary>
          <textarea
            rows={4}
            value={testPoolJson}
            onChange={(e) => setTestPoolJson(e.target.value)}
            placeholder='{"currency0":"0x0…","currency1":"0x…","fee":…,"tickSpacing":25,"hooks":"0x0…"}'
          />
        </details>
        <div className="btn-row">
          <button type="button" disabled={!!testBusy} onClick={() => void v4LookupPool()}>
            {testBusy === "pool" ? "查询中…" : "查询代币 (agnt)"}
          </button>
          <button type="button" disabled={!!testBusy} onClick={() => void queryHoldersForTest()}>
            {testBusy === "holders" ? "查询中…" : "查询 holders"}
          </button>
          <button type="button" disabled={!!testBusy} onClick={() => void v4Test(false)}>
            {testBusy === "quote" ? "报价中…" : "quote_v2 报价"}
          </button>
          <button type="button" className="primary" disabled={!!testBusy} onClick={() => void v4Test(true)}>
            {testBusy === "swap" ? "发送中…" : "实盘买入"}
          </button>
        </div>
        {testResult && <pre className="test-out">{testResult}</pre>}
      </section>

      <section className="card">
        <h2>命中记录</h2>
        <ul className="hits">
          {(status?.hits ?? []).map((h) => (
            <li key={h.createTx}>
              <strong>{h.symbol}</strong> {h.name} · 市值 ${h.marketCapUsd.toFixed(0)}
              {h.buyTx ? ` · 买入 ${h.buyTx.slice(0, 10)}…` : h.buyError ? ` · 失败 ${h.buyError}` : ""}
            </li>
          ))}
          {!status?.hits?.length && <li className="muted">暂无</li>}
        </ul>
      </section>

      <section className="card">
        <h2>日志</h2>
        <p className="muted small">最新 {status?.logs?.length ?? 0} 条（含轮询、发币、市值、持有人、买入）</p>
        <pre className="logs">
          {(status?.logs ?? [])
            .map((l) => {
              const tag =
                l.level === "ok"
                  ? "OK"
                  : l.level === "warn"
                    ? "WARN"
                    : l.level === "err"
                      ? "ERR"
                      : "INFO";
              return `[${l.time.slice(11, 19)}][${tag}] ${l.message}`;
            })
            .join("\n")}
        </pre>
      </section>
    </div>
  );
}
