export type CompareOp = "gt" | "lt" | "eq";

export const COMPARE_OP_OPTIONS: { value: CompareOp; label: string }[] = [
  { value: "gt", label: "大于" },
  { value: "lt", label: "小于" },
  { value: "eq", label: "等于" },
];

export function normalizeCompareOp(v: unknown): CompareOp | undefined {
  if (v === "gt" || v === "lt" || v === "eq") return v;
  return undefined;
}

/** 未配置 op 时用 legacy（兼容旧配置：市值 ≥、Top10 ≤、持仓 ≥） */
export function matchesCompare(
  actual: number,
  target: number,
  op: CompareOp | undefined,
  legacy: "gte" | "lte" = "gte",
): boolean {
  if (op === "gt") return actual > target;
  if (op === "lt") return actual < target;
  if (op === "eq") {
    const eps = Math.max(0.01, Math.abs(target) * 0.001);
    return Math.abs(actual - target) <= eps;
  }
  return legacy === "gte" ? actual >= target : actual <= target;
}

export function compareOpSymbol(op: CompareOp | undefined, legacy: "gte" | "lte" = "gte"): string {
  if (op === "gt") return ">";
  if (op === "lt") return "<";
  if (op === "eq") return "=";
  return legacy === "gte" ? "≥" : "≤";
}

export function compareOpLabel(op: CompareOp | undefined, legacy: "gte" | "lte" = "gte"): string {
  if (op === "gt") return "大于";
  if (op === "lt") return "小于";
  if (op === "eq") return "等于";
  return legacy === "gte" ? "大于等于" : "小于等于";
}
