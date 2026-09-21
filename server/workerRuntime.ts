import { loadSettings, saveSettings } from "./settings.js";
import { patchState, pushLog } from "./state.js";
import { runWorker, requestBlockCursorReset } from "./worker.js";

let abortController = new AbortController();
let workerStarted = false;

function attachWorkerRun() {
  runWorker(abortController.signal).catch((error) => {
    if (abortController.signal.aborted) return;
    patchState({
      running: false,
      phase: "error",
      lastMessage: error instanceof Error ? error.message : String(error),
    });
  });
}

export function ensureWorkerStarted() {
  if (workerStarted) return;
  workerStarted = true;
  patchState({ running: true, lastMessage: "Worker 启动中…" });
  attachWorkerRun();
}

export function isWorkerThreadActive() {
  return workerStarted && !abortController.signal.aborted;
}

/** 暂停：关闭 enabled，Worker 空转，保留区块游标 */
export function pauseMonitoring() {
  const settings = saveSettings({ ...loadSettings(), enabled: false });
  patchState({ phase: "idle", lastMessage: "监控已暂停（可随时恢复）" });
  pushLog("info", "监控已暂停");
  return settings;
}

/** 停止：关闭 enabled，下次从最新区块重新对齐 */
export function stopMonitoring() {
  const settings = saveSettings({ ...loadSettings(), enabled: false });
  requestBlockCursorReset();
  patchState({ phase: "idle", lastMessage: "监控已停止", lastBlock: null });
  pushLog("info", "监控已停止，区块游标已重置");
  return settings;
}

/** 重启 Worker 线程并从最新区块重新监控 */
export function restartMonitoring() {
  abortController.abort();
  abortController = new AbortController();
  requestBlockCursorReset();
  const settings = saveSettings({ ...loadSettings(), enabled: true });
  patchState({
    running: true,
    phase: "idle",
    lastMessage: "监控已重启，将从最新区块开始",
    lastBlock: null,
  });
  pushLog("info", "监控已重启 · enabled=true · 区块游标已重置");
  attachWorkerRun();
  return settings;
}

/** 恢复监控（不重启线程） */
export function resumeMonitoring() {
  const settings = saveSettings({ ...loadSettings(), enabled: true });
  patchState({ lastMessage: "监控已恢复" });
  pushLog("info", "监控已恢复");
  return settings;
}
