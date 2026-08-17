import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestPerformanceStore {
  dbDurationSumMs: number;
  dbQueryCount: number;
  maxDbQueryMs: number;
  slowDbQueryCount: number;
}

const storage = new AsyncLocalStorage<RequestPerformanceStore>();

export const requestPerformance = {
  createStore(): RequestPerformanceStore {
    return {
      dbDurationSumMs: 0,
      dbQueryCount: 0,
      maxDbQueryMs: 0,
      slowDbQueryCount: 0,
    };
  },

  run<T>(store: RequestPerformanceStore, callback: () => T): T {
    return storage.run(store, callback);
  },

  recordQuery(durationMs: number, slowThresholdMs: number): void {
    const store = storage.getStore();
    if (!store) return;
    store.dbDurationSumMs += durationMs;
    store.dbQueryCount += 1;
    store.maxDbQueryMs = Math.max(store.maxDbQueryMs, durationMs);
    if (durationMs >= slowThresholdMs) store.slowDbQueryCount += 1;
  },
};
