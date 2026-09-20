export async function fetchApiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const ct = res.headers.get("content-type") ?? "";
  const raw = await res.text();
  if (!ct.includes("application/json") && raw.trimStart().startsWith("<")) {
    throw new Error(
      `接口返回了网页而不是 JSON（${res.status}）。请用 npm run dev 同时启动 API(8795) 和前端(5176)，或访问 http://127.0.0.1:8795`,
    );
  }
  let data: T & { message?: string };
  try {
    data = JSON.parse(raw) as T & { message?: string };
  } catch {
    throw new Error(`JSON 解析失败: ${raw.slice(0, 120)}`);
  }
  if (!res.ok) throw new Error(data.message ?? `HTTP ${res.status}`);
  return data;
}
