import { getAddress, type Address } from "viem";
import { fetchTokenHolders, type AgntHoldersResponse } from "./agntHolders.js";
import { getWatchBalancesPct } from "./chainHolders.js";
import { compareOpLabel, compareOpSymbol, matchesCompare } from "./compareOp.js";
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

export type HolderCheckOptions = {
  /** 发币区块，从该高度扫 Transfer（更准、更快） */
  fromBlock?: bigint;
};

export async function checkHolderFilter(
  token: Address,
  settings: SnipeSettings,
  options: HolderCheckOptions = {},
): Promise<HolderCheckResult> {
  if (!settings.holderFilterEnabled) {
    return { ok: true, reason: "持有人条件未启用" };
  }

  const watches = getHolderWatchAddresses(settings);
  if (!watches.length) {
    return { ok: false, reason: "已启用持有人条件，但未配置监控钱包地址" };
  }

  const data = await fetchTokenHolders(token, {
    fromBlock: options.fromBlock,
    watchAddresses: watches,
  });
  const minPct = Math.max(0, Number(settings.holderMinPct) || 0);
  const maxTop10 = settings.holderMaxTop10Pct;
  const mode = settings.holderMode ?? "any";

  if (maxTop10 != null && maxTop10 > 0 && data.distribution?.top10 != null) {
    const top10 = data.distribution.top10;
    const top10Ok = matchesCompare(top10, maxTop10, settings.holderMaxTop10CompareOp, "lte");
    if (!top10Ok) {
      const sym = compareOpSymbol(settings.holderMaxTop10CompareOp, "lte");
      const lab = compareOpLabel(settings.holderMaxTop10CompareOp, "lte");
      return {
        ok: false,
        reason: `Top10 持仓 ${top10}% 未满足 ${lab} ${maxTop10}%（需实际${sym}${maxTop10}%，链上 RPC）`,
        data,
      };
    }
  }

  const balanceRows = await getWatchBalancesPct(token, watches);
  const watched = balanceRows.map((r) => ({
    address: r.address as `0x${string}`,
    pct: r.pct,
  }));

  if (settings.holderRequireListed) {
    const missing = watched.filter((w) => w.pct == null || w.pct <= 0);
    if (missing.length) {
      return {
        ok: false,
        reason: `监控地址链上持仓为 0: ${missing.map((m) => m.address.slice(0, 10)).join(", ")}…`,
        data,
        watched,
      };
    }
  }

  const pctOk = (pct: number) => matchesCompare(pct, minPct, settings.holderMinPctCompareOp, "gte");
  const pctClause = `${compareOpLabel(settings.holderMinPctCompareOp, "gte")}${minPct}%`;

  if (mode === "all") {
    const fail = watched.filter((w) => !pctOk(w.pct ?? 0));
    if (fail.length) {
      const detail = fail
        .map((w) => `${w.address.slice(0, 8)}…=${w.pct ?? 0}%`)
        .join(", ");
      return {
        ok: false,
        reason: `需全部监控地址持仓 ${pctClause} · 未达标: ${detail}`,
        data,
        watched,
      };
    }
    return {
      ok: true,
      reason: `全部监控地址持仓 ${pctClause}`,
      data,
      watched,
    };
  }

  const hit = watched.find((w) => pctOk(w.pct ?? 0));
  if (!hit) {
    const detail = watched.map((w) => `${w.address.slice(0, 8)}…=${w.pct ?? "—"}%`).join(", ");
    return {
      ok: false,
      reason: `需任一监控地址持仓 ${pctClause} · 当前: ${detail}`,
      data,
      watched,
    };
  }

  return {
    ok: true,
    reason: `${hit.address.slice(0, 10)}… 持仓 ${hit.pct}% 满足 ${pctClause}`,
    data,
    watched,
  };
}
