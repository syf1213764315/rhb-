import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  webSocket,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinChain, ROBIN_CHAIN_ID } from "./chain.js";
import { loadSettings } from "./settings.js";
import { getPrivateKey } from "./secrets.js";

const chain = defineChain(robinChain);

let cachedKey = "";
let publicClient: PublicClient | null = null;
let walletClient: WalletClient | null = null;

function rpcCacheKey() {
  const s = loadSettings();
  return `${s.rpcHttpUrl}|${s.rpcWsUrl}`;
}

function buildPublicTransport() {
  const s = loadSettings();
  const httpUrl = s.rpcHttpUrl || "https://robinhood.api.pocket.network";
  const wsUrl = s.rpcWsUrl || "wss://robinhood.api.pocket.network";
  try {
    return webSocket(wsUrl);
  } catch {
    return http(httpUrl);
  }
}

export function resetClients() {
  const key = rpcCacheKey();
  if (key !== cachedKey) {
    cachedKey = key;
    publicClient = null;
    walletClient = null;
  }
}

export function getPublicClient(): PublicClient {
  resetClients();
  if (!publicClient) {
    publicClient = createPublicClient({ chain, transport: buildPublicTransport() });
  }
  return publicClient;
}

export function getWalletClient(): WalletClient {
  const pk = getPrivateKey();
  if (!pk) throw new Error("未配置私钥：在 robin/config.json 填写 privateKey 或设置环境变量 PRIVATE_KEY");
  resetClients();
  if (!walletClient) {
    walletClient = createWalletClient({
      chain,
      transport: http(loadSettings().rpcHttpUrl || "https://robinhood.api.pocket.network"),
      account: privateKeyToAccount(pk),
    });
  }
  return walletClient;
}

export function getWalletAddress(): `0x${string}` | null {
  const pk = getPrivateKey();
  if (!pk) return null;
  return privateKeyToAccount(pk).address;
}

export function getActiveRpcLabel() {
  return loadSettings().rpcHttpUrl;
}

export { ROBIN_CHAIN_ID };
