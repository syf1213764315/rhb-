import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { loadDotEnv } from "./loadEnv.js";
import { ROOT } from "./paths.js";
import { loadSettings, saveSettings, type SnipeSettings } from "./settings.js";
import { getState, patchState } from "./state.js";
import { runWorker } from "./worker.js";
import { privateKeyConfigured, getPrivateKey } from "./secrets.js";
import { getWalletAddress, getPublicClient, resetClients } from "./clients.js";
import { formatEther } from "viem";
import { getAddress } from "viem";
import { fetchTokenHolders } from "./agntHolders.js";
import { checkHolderFilter } from "./holderFilter.js";
import { lookupToken, runV4Test, type V4TestBody } from "./v4Test.js";

loadDotEnv();

const PORT = Number(process.env.PORT ?? 8795);
const HOST = process.env.HOST ?? "0.0.0.0";
const distDir = resolve(ROOT, "dist");
const workerAbort = new AbortController();

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

async function readJson<T>(req: import("node:http").IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as T) : ({} as T);
}

function normalizePath(pathname: string) {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = normalizePath(url.pathname);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (pathname === "/api/status" && req.method === "GET") {
      resetClients();
      const settings = loadSettings();
      let ethBalance: string | null = null;
      const wallet = getWalletAddress();
      if (wallet) {
        try {
          ethBalance = formatEther(await getPublicClient().getBalance({ address: wallet }));
        } catch {
          /* ignore */
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ...getState(),
          settings,
          privateKeyConfigured: privateKeyConfigured(),
          walletAddress: wallet,
          ethBalance,
          workerRunning: !workerAbort.signal.aborted,
        }),
      );
      return;
    }

    if (pathname === "/api/config" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ settings: loadSettings(), privateKeyConfigured: privateKeyConfigured() }));
      return;
    }

    if (pathname === "/api/config" && req.method === "PUT") {
      const body = await readJson<Partial<SnipeSettings>>(req);
      const saved = saveSettings(body);
      resetClients();
      patchState({ lastMessage: "配置已保存，Worker 自动读取" });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, settings: saved }));
      return;
    }

    if (
      (pathname === "/api/v4/pool" ||
        pathname === "/api/token/summary" ||
        pathname === "/api/token") &&
      req.method === "GET"
    ) {
      const token = url.searchParams.get("token") ?? "";
      if (!token.trim()) throw new Error("缺少 ?token=0x...");
      resetClients();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(await lookupToken(token)));
      return;
    }

    if (pathname === "/api/token/holders" && req.method === "GET") {
      const token = url.searchParams.get("token") ?? "";
      if (!token.trim()) throw new Error("缺少 ?token=0x...");
      const addr = getAddress(token.trim());
      const holders = await fetchTokenHolders(addr);
      const settings = loadSettings();
      const check = settings.holderFilterEnabled
        ? await checkHolderFilter(addr, settings)
        : { ok: true, reason: "持有人条件未启用" };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ holders, check }));
      return;
    }

    if (pathname === "/api/v4/test" && req.method === "POST") {
      const body = await readJson<V4TestBody>(req);
      if (!body.token?.trim()) throw new Error("缺少 token 地址");
      resetClients();
      const result = await runV4Test(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "请求失败";
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message }));
    return;
  }

  if (pathname.startsWith("/api/")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: `未知 API: ${pathname}` }));
    return;
  }

  if (existsSync(distDir)) {
    let filePath = resolve(distDir, pathname === "/" ? "index.html" : pathname.slice(1));
    if (!filePath.startsWith(distDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (!existsSync(filePath) || !extname(filePath)) filePath = resolve(distDir, "index.html");
    if (existsSync(filePath)) {
      res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
      res.end(readFileSync(filePath));
      return;
    }
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ message: "Not found — 请先 npm run build" }));
});

server.listen(PORT, HOST, () => {
  console.log(`Robin 狙击 · http://${HOST}:${PORT}`);
  if (!getPrivateKey()) {
    console.warn("  提示: 未配置 PRIVATE_KEY / config.json privateKey，将无法自动买入");
  }
  patchState({ running: true, lastMessage: "Worker 启动中…" });
  runWorker(workerAbort.signal).catch((error) => {
    if (workerAbort.signal.aborted) return;
    patchState({
      running: false,
      phase: "error",
      lastMessage: error instanceof Error ? error.message : String(error),
    });
  });
});

function shutdown() {
  workerAbort.abort();
  patchState({ running: false, lastMessage: "服务已停止" });
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
