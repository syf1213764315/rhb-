import { formatUnits, getAddress, parseEther, type Address, type Hash, type Hex } from "viem";
import { ROBIN_CHAIN_ID, ROBIN_CONTRACTS } from "./chain.js";
import { getPublicClient, getWalletClient, getWalletAddress } from "./clients.js";

const AGNT_API = (process.env.AGNT_API_BASE ?? "https://agnt.social/api").replace(/\/$/, "");
const NATIVE_ETH = "0x0000000000000000000000000000000000000000" as Address;

export type AgntTxItem = {
  status?: string;
  data?: {
    from?: Address;
    to?: Address;
    data?: Hex;
    value?: string;
    chainId?: number;
    gas?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
  };
  check?: { endpoint?: string; method?: string };
};

export type AgntSwapQuoteV2 = {
  requestId: string;
  steps?: {
    id?: string;
    kind?: string;
    items?: AgntTxItem[];
    requestId?: string;
  }[];
  details?: {
    currencyIn?: { amountFormatted?: string; amount?: string };
    currencyOut?: {
      amount?: string;
      amountFormatted?: string;
      minimumAmount?: string;
      currency?: { symbol?: string; decimals?: number };
    };
    rate?: string;
    route?: unknown;
  };
  fees?: unknown;
  protocol?: unknown;
};

function sellAmountParam(ethAmount: string): string {
  const wei = parseEther(ethAmount);
  return formatUnits(wei, 18);
}

export function buildQuoteV2Url(params: {
  buyToken: Address;
  sellAmountEth: string;
  taker: Address;
  slippageBps: number;
}) {
  const q = new URLSearchParams({
    sellToken: NATIVE_ETH,
    buyToken: getAddress(params.buyToken),
    sellAmount: sellAmountParam(params.sellAmountEth),
    chain: "robinhood",
    chainId: String(ROBIN_CHAIN_ID),
    originChainId: String(ROBIN_CHAIN_ID),
    sellDecimals: "18",
    slippageBps: String(params.slippageBps),
    side: "buy",
    taker: getAddress(params.taker),
  });
  return `${AGNT_API}/swap/quote_v2?${q.toString()}`;
}

export async function fetchAgntQuoteV2(params: {
  buyToken: Address;
  sellAmountEth: string;
  taker: Address;
  slippageBps: number;
}): Promise<AgntSwapQuoteV2> {
  const url = buildQuoteV2Url(params);
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`agnt quote_v2 HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const json = (await res.json()) as AgntSwapQuoteV2 & { message?: string; error?: string };
  if (!json.requestId) {
    throw new Error(json.message ?? json.error ?? "quote_v2 无 requestId");
  }
  return json;
}

function resolveStatusUrl(endpoint: string): string {
  if (endpoint.startsWith("http")) return endpoint;
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${AGNT_API}${path}`;
}

async function pollIntentComplete(checkEndpoint: string, maxWaitMs = 120_000): Promise<unknown> {
  const url = resolveStatusUrl(checkEndpoint);
  const deadline = Date.now() + maxWaitMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      await sleep(2000);
      continue;
    }
    last = await res.json();
    const status = extractIntentStatus(last);
    if (status === "success" || status === "complete" || status === "completed") return last;
    if (status === "failed" || status === "refunded" || status === "error") {
      throw new Error(`agnt intent 失败: ${status} · ${JSON.stringify(last).slice(0, 300)}`);
    }
    await sleep(2000);
  }
  throw new Error(`agnt intent 超时 · 末次状态: ${JSON.stringify(last).slice(0, 300)}`);
}

function extractIntentStatus(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  for (const key of ["status", "state", "intentStatus"]) {
    if (typeof o[key] === "string") return o[key] as string;
  }
  if (o.data && typeof o.data === "object") {
    const d = o.data as Record<string, unknown>;
    if (typeof d.status === "string") return d.status;
  }
  return null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function executeAgntSwapQuote(quote: AgntSwapQuoteV2): Promise<{
  requestId: string;
  txHashes: Hash[];
  intentStatus: unknown;
}> {
  const wallet = getWalletClient();
  const account = wallet.account!;
  const txHashes: Hash[] = [];
  let checkEndpoint: string | null = null;

  for (const step of quote.steps ?? []) {
    if (step.kind !== "transaction") continue;
    for (const item of step.items ?? []) {
      const tx = item.data;
      if (!tx?.to || !tx.data) continue;
      if (item.check?.endpoint) checkEndpoint = item.check.endpoint;

      const hash = await wallet.sendTransaction({
        account,
        chain: wallet.chain,
        to: getAddress(tx.to),
        data: tx.data,
        value: tx.value ? BigInt(tx.value) : 0n,
        gas: tx.gas ? BigInt(tx.gas) : undefined,
        maxFeePerGas: tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : undefined,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas ? BigInt(tx.maxPriorityFeePerGas) : undefined,
      });
      txHashes.push(hash);
      const client = getPublicClient();
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error(`链上交易 revert · ${hash}`);
      }
    }
  }

  if (!txHashes.length) throw new Error("quote_v2 无待签名交易");
  if (!checkEndpoint) checkEndpoint = `/intents/status/v3?requestId=${quote.requestId}`;

  const intentStatus = await pollIntentComplete(checkEndpoint);
  return { requestId: quote.requestId, txHashes, intentStatus };
}

export async function quoteAndExecuteAgntBuy(params: {
  buyToken: Address;
  ethAmount: string;
  slippageBps: number;
  execute: boolean;
}) {
  const taker = getWalletAddress();
  if (!taker) throw new Error("未配置钱包私钥");

  const quote = await fetchAgntQuoteV2({
    buyToken: params.buyToken,
    sellAmountEth: params.ethAmount,
    taker,
    slippageBps: params.slippageBps,
  });

  const out = quote.details?.currencyOut;
  const base = {
    quoteSource: "agnt.social/swap/quote_v2",
    quoteUrl: buildQuoteV2Url({
      buyToken: params.buyToken,
      sellAmountEth: params.ethAmount,
      taker,
      slippageBps: params.slippageBps,
    }),
    requestId: quote.requestId,
    ethAmount: params.ethAmount,
    slippageBps: params.slippageBps,
    amountOut: out?.amount,
    amountOutFormatted: out?.amountFormatted,
    minOut: out?.minimumAmount,
    buySymbol: out?.currency?.symbol,
    rate: quote.details?.rate,
    fees: quote.fees,
    route: quote.details?.route,
    steps: quote.steps?.map((s) => ({ id: s.id, kind: s.kind, itemCount: s.items?.length ?? 0 })),
  };

  if (!params.execute) {
    return { mode: "quote" as const, ok: true, ...base };
  }

  const executed = await executeAgntSwapQuote(quote);
  const depositTx = executed.txHashes[0]!;
  return {
    mode: "swap" as const,
    ok: true,
    ...base,
    txHash: depositTx,
    txHashes: executed.txHashes,
    explorerUrl: ROBIN_CONTRACTS.explorerTx(depositTx),
    intentStatus: executed.intentStatus,
  };
}
