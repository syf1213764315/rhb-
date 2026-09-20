import { getAddress, type Address } from "viem";
import { fetchTokenHolders, findHolderPct, type AgntHoldersResponse } from "./agntHolders.js";
import type { SnipeSettings } from "./settings.js";

export type HolderCheckResult = {
  ok: boolean;
  reason: string;
  data?: AgntHoldersResponse;
  watched?: { address: string; pct: number | null }[];
};

function normalizeHolderWatchList(lines: string[]): Address[] {
  const out: Address[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
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
        /* skip */
      }
    }
  }
  return out;
}

export function getHolderWatchAddresses(settings: SnipeSettings): Address[] {
  return normalizeHolderWatchList(settings.holderWatchAddresses ?? []);
}

export async function checkHolderFilter(token: Address, settings: SnipeSettings): Promise<HolderCheckResult> {
  if (!settings.holderFilterEnabled) {
    return { ok: true, reason: "持有人条件未启用" };
  }

  const watches = getHolderWatchAddresses(settings);
  if (!watches.length) {
    return { ok: false, reason: "已启用持有人条件，但未配置监控钱包地址" };
  }

  const data = await fetchTokenHolders(token);
  const minPct = Math.max(0, Number(settings.holderMinPct) || 0);
  const maxTop10 = settings.holderMaxTop10Pct;
  const mode = settings.holderMode ?? "any";

  if (maxTop10 != null && maxTop10 > 0 && data.distribution?.top10 != null) {
    if (data.distribution.top10 > maxTop10) {
      return {
        ok: false,
        reason: `Top10 持仓 ${data.distribution.top10}% > 上限 ${maxTop10}%`,
        data,
      };
    }
  }

  const watched = watches.map((a) => ({
    address: a,
    pct: findHolderPct(data.holders, a),
  }));

  if (settings.holderRequireListed) {
    const missing = watched.filter((w) => w.pct == null);
    if (missing.length) {
      return {
        ok: false,
        reason: `监控地址未出现在 holders 列表: ${missing.map((m) => m.address.slice(0, 10)).join(", ")}…`,
        data,
        watched,
      };
    }
  }

  if (mode === "all") {
    const fail = watched.filter((w) => (w.pct ?? 0) < minPct);
    if (fail.length) {
      const detail = fail
        .map((w) => `${w.address.slice(0, 8)}…=${w.pct ?? 0}%`)
        .join(", ");
      return {
        ok: false,
        reason: `需全部监控地址持仓 ≥${minPct}% · 未达标: ${detail}`,
        data,
        watched,
      };
    }
    return {
      ok: true,
      reason: `全部监控地址持仓 ≥${minPct}%`,
      data,
      watched,
    };
  }

  // any：至少一个监控地址持仓 >= minPct
  const hit = watched.find((w) => (w.pct ?? 0) >= minPct);
  if (!hit) {
    const detail = watched.map((w) => `${w.address.slice(0, 8)}…=${w.pct ?? "—"}%`).join(", ");
    return {
      ok: false,
      reason: `需任一监控地址持仓 ≥${minPct}% · 当前: ${detail}`,
      data,
      watched,
    };
  }

  return {
    ok: true,
    reason: `${hit.address.slice(0, 10)}… 持仓 ${hit.pct}% ≥ ${minPct}%`,
    data,
    watched,
  };
}
