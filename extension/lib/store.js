/**
 * store.js — the extension's data layer.
 *
 * Everything lives in chrome.storage.local (nothing leaves the browser). The store is
 * written against a two-method adapter so the same code runs on chrome.storage.local in
 * the extension and on an in-memory Map in tests and in the dashboard's demo mode.
 *
 * Keys:
 *   sheet            { fileName, importedAt, csvText, columns }   last imported spreadsheet
 *   mapping          { [storeCode]: pageUrl }                    user overrides
 *   settings         { horizonDays }
 *   history:<code>   Array<ScanSummary>, newest first, at most HISTORY_LIMIT
 *   latest:<code>    full audit result of the newest scan
 */

export const HISTORY_LIMIT = 10;

/** In-memory adapter with the chrome.storage.local promise API shape. */
export function memoryAdapter(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    async get(keys) {
      const list = keys === null || keys === undefined ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      const out = {};
      list.forEach((k) => { if (data.has(k)) out[k] = structuredClone(data.get(k)); });
      return out;
    },
    async set(obj) {
      Object.entries(obj).forEach(([k, v]) => data.set(k, structuredClone(v)));
    },
    async remove(keys) {
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => data.delete(k));
    },
  };
}

/** Summary row kept in history (small enough to keep ten per location). */
export function summarize(result, scannedAt) {
  return {
    scannedAt,
    pageUrl: result.pageUrl,
    status: result.status,
    counts: result.counts,
    driftDays: result.metrics.driftDays,
    comparedDays: result.metrics.comparedDays,
    visibleDriftDays: result.metrics.visibleDriftDays,
  };
}

export function createStore(adapter) {
  return {
    async saveSheet(sheet) {
      await adapter.set({ sheet });
    },
    async getSheet() {
      return (await adapter.get('sheet')).sheet ?? null;
    },
    async getMapping() {
      return (await adapter.get('mapping')).mapping ?? {};
    },
    async setMapping(storeCode, url) {
      const mapping = await this.getMapping();
      if (url) mapping[storeCode] = url;
      else delete mapping[storeCode];
      await adapter.set({ mapping });
      return mapping;
    },
    async getSettings() {
      return { horizonDays: 45, ...((await adapter.get('settings')).settings ?? {}) };
    },
    async saveSettings(settings) {
      await adapter.set({ settings });
    },
    /** Store a full result and append its summary to the location's history. */
    async saveScan(result, scannedAt) {
      const hKey = `history:${result.storeCode}`;
      const history = (await adapter.get(hKey))[hKey] ?? [];
      const next = [summarize(result, scannedAt), ...history].slice(0, HISTORY_LIMIT);
      await adapter.set({ [hKey]: next, [`latest:${result.storeCode}`]: result });
      return next;
    },
    async getHistory(storeCode) {
      const k = `history:${storeCode}`;
      return (await adapter.get(k))[k] ?? [];
    },
    async getLatest(storeCode) {
      const k = `latest:${storeCode}`;
      return (await adapter.get(k))[k] ?? null;
    },
    async getAllLatest(storeCodes) {
      const got = await adapter.get(storeCodes.map((c) => `latest:${c}`));
      return storeCodes.map((c) => got[`latest:${c}`] ?? null);
    },
    async clearScans(storeCodes) {
      await adapter.remove(storeCodes.flatMap((c) => [`history:${c}`, `latest:${c}`]));
    },
  };
}
