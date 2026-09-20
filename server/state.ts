export type LogLine = { time: string; level: "info" | "ok" | "warn" | "err"; message: string };

export type Hit = {
  id: string;
  at: string;
  creator: string;
  token: string;
  name: string;
  symbol: string;
  marketCapUsd: number;
  createTx: string;
  buyTx?: string;
  buyError?: string;
};

export type WorkerState = {
  running: boolean;
  phase: string;
  lastMessage: string;
  lastBlock: number | null;
  walletAddress: string | null;
  ethBalance: string | null;
  hits: Hit[];
  logs: LogLine[];
};

const MAX_LOGS = 200;
const MAX_HITS = 40;

const state: WorkerState = {
  running: false,
  phase: "idle",
  lastMessage: "等待配置",
  lastBlock: null,
  walletAddress: null,
  ethBalance: null,
  hits: [],
  logs: [],
};

export function getState(): WorkerState {
  return { ...state, hits: [...state.hits], logs: [...state.logs] };
}

export function patchState(partial: Partial<WorkerState>) {
  Object.assign(state, partial);
}

export function pushLog(level: LogLine["level"], message: string) {
  const line = { time: new Date().toISOString(), level, message };
  state.logs.unshift(line);
  if (state.logs.length > MAX_LOGS) state.logs.length = MAX_LOGS;
  console.log(`[robin/${level}] ${message}`);
}

export function pushHit(hit: Hit) {
  state.hits.unshift(hit);
  if (state.hits.length > MAX_HITS) state.hits.length = MAX_HITS;
}
