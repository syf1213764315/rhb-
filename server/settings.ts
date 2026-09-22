import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getAddress } from "viem";
import { DATA_DIR, SETTINGS_PATH } from "./paths.js";
import { normalizeCompareOp, type CompareOp } from "./compareOp.js";

export type { CompareOp };

export type SnipeSettings = {
  /** 是否启用后台监控（关闭网页后仍由 Node 进程执行） */
  enabled: boolean;
  /** 监控的发币钱包地址，每行一个 */
  watchAddresses: string[];
  /** 代币名称/符号筛选（包含匹配，不区分大小写；留空表示不过滤） */
  nameFilter: string;
  /** 市值阈值（USD） */
  minMarketCapUsd: number;
  /** 市值与阈值比较：gt/lt/eq；未设时等价于 ≥ */
  marketCapCompareOp?: CompareOp;
  /** ETH/USD 估价，用于把池子价格换算成美元市值 */
  ethUsdPrice: number;
  /** 单笔买入 ETH 数量 */
  buyEthAmount: string;
  slippageBps: number;
  pollIntervalSec: number;
  /** 买入成功后是否停止监控 */
  stopAfterBuy: boolean;
  buyMaxRetries: number;
  rpcWsUrl: string;
  rpcHttpUrl: string;
  /** 可选：买入前检查链上持有人 */
  holderFilterEnabled: boolean;
  /** 监控的持有人钱包（与发币监控地址无关） */
  holderWatchAddresses: string[];
  /** any=任一地址达标；all=全部地址都要达标 */
  holderMode: "any" | "all";
  /** 监控地址持仓比例 % 与阈值比较；未设时等价于 ≥ */
  holderMinPct: number;
  holderMinPctCompareOp?: CompareOp;
  /** 可选：Top10 集中度 % 与阈值比较，0 表示不限制；未设时等价于 ≤ */
  holderMaxTop10Pct: number;
  holderMaxTop10CompareOp?: CompareOp;
  /** 监控地址必须出现在 holders 列表中 */
  holderRequireListed: boolean;
};

const DEFAULT: SnipeSettings = {
  enabled: false,
  watchAddresses: [],
  nameFilter: "",
  minMarketCapUsd: 10_000,
  ethUsdPrice: 3000,
  buyEthAmount: "0.01",
  slippageBps: 500,
  pollIntervalSec: 2,
  stopAfterBuy: false,
  buyMaxRetries: 20,
  rpcWsUrl: "wss://robinhood.api.pocket.network",
  rpcHttpUrl: "https://robinhood.api.pocket.network",
  holderFilterEnabled: false,
  holderWatchAddresses: [],
  holderMode: "any",
  holderMinPct: 0,
  holderMaxTop10Pct: 0,
  holderRequireListed: false,
};

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function loadSettings(): SnipeSettings {
  ensureDataDir();
  if (!existsSync(SETTINGS_PATH)) return { ...DEFAULT };
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Partial<SnipeSettings>;
    return normalizeSettings({ ...DEFAULT, ...raw });
  } catch {
    return { ...DEFAULT };
  }
}

export function saveSettings(input: Partial<SnipeSettings>): SnipeSettings {
  const next = normalizeSettings({ ...loadSettings(), ...input });
  ensureDataDir();
  writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}

function parseAddressLines(lines: string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines ?? []) {
    for (const part of line.split(/[\s,;\n\r]+/)) {
      const p = part.trim();
      if (!p) continue;
      try {
        const a = getAddress(p);
        const k = a.toLowerCase();
        if (!seen.has(k)) {
          seen.add(k);
          out.push(a);
        }
      } catch {
        /* skip invalid */
      }
    }
  }
  return out;
}

function normalizeSettings(s: SnipeSettings): SnipeSettings {
  const mode = s.holderMode === "all" ? "all" : "any";
  return {
    enabled: !!s.enabled,
    watchAddresses: parseAddressLines(s.watchAddresses),
    nameFilter: (s.nameFilter ?? "").trim(),
    minMarketCapUsd: Math.max(0, Number(s.minMarketCapUsd) || 0),
    marketCapCompareOp: normalizeCompareOp(s.marketCapCompareOp),
    ethUsdPrice: Math.max(1, Number(s.ethUsdPrice) || DEFAULT.ethUsdPrice),
    buyEthAmount: String(s.buyEthAmount ?? DEFAULT.buyEthAmount).trim() || DEFAULT.buyEthAmount,
    slippageBps: Math.min(5000, Math.max(0, Math.floor(Number(s.slippageBps) || 500))),
    pollIntervalSec: Math.min(60, Math.max(1, Math.floor(Number(s.pollIntervalSec) || 2))),
    stopAfterBuy: !!s.stopAfterBuy,
    buyMaxRetries: Math.min(999, Math.max(1, Math.floor(Number(s.buyMaxRetries) || 20))),
    rpcWsUrl: (s.rpcWsUrl ?? DEFAULT.rpcWsUrl).trim(),
    rpcHttpUrl: (s.rpcHttpUrl ?? DEFAULT.rpcHttpUrl).trim(),
    holderFilterEnabled: !!s.holderFilterEnabled,
    holderWatchAddresses: parseAddressLines(s.holderWatchAddresses),
    holderMode: mode,
    holderMinPct: Math.min(100, Math.max(0, Number(s.holderMinPct) || 0)),
    holderMinPctCompareOp: normalizeCompareOp(s.holderMinPctCompareOp),
    holderMaxTop10Pct: Math.min(100, Math.max(0, Number(s.holderMaxTop10Pct) || 0)),
    holderMaxTop10CompareOp: normalizeCompareOp(s.holderMaxTop10CompareOp),
    holderRequireListed: !!s.holderRequireListed,
  };
}

export function validateSettingsForRun(s: SnipeSettings): string | null {
  if (!s.enabled) return null;
  if (!s.watchAddresses.length) return "请填写至少一个发币监控地址";
  if (!s.rpcHttpUrl) return "请填写 HTTP RPC";
  const eth = Number.parseFloat(s.buyEthAmount);
  if (!Number.isFinite(eth) || eth <= 0) return "买入 ETH 数量无效";
  if (s.holderFilterEnabled && !parseAddressLines(s.holderWatchAddresses).length) {
    return "已启用持有人条件，请填写监控钱包地址";
  }
  return null;
}
