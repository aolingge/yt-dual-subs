// Shared preference storage. Local staging keeps live edits safe when a popup
// closes; the existing service worker batches writes to browser sync storage.
(() => {
  "use strict";
  const PENDING_KEY = "settingsPendingV1";
  const SYNC_INTERVAL_MS = 2500; // <= 24 writes/minute, <= 1440 writes/hour
  const DEBOUNCE_MS = 250;
  let pending = {};
  const seen = {};
  let record, ready, chain = Promise.resolve(), timer = null;

  function valuesOf(value) {
    const values = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return values;
    for (const [key, val] of Object.entries(value)) {
      if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key) || key.length > 64) continue;
      if (typeof val === "boolean" || (typeof val === "number" && Number.isFinite(val)) ||
          (typeof val === "string" && val.length <= 2000)) values[key] = val;
    }
    return values;
  }

  function get(defaults, done) {
    const finish = (saved, staged) => {
      pending = valuesOf(staged?.values);
      const result = { ...defaults, ...saved, ...pending };
      Object.assign(seen, result);
      done(result);
    };
    try {
      chrome.storage.sync.get(defaults, (saved) => {
        if (chrome.runtime.lastError) saved = {};
        try {
          chrome.storage.local.get(PENDING_KEY, (local) => {
            const error = chrome.runtime.lastError;
            finish(saved, error ? null : local?.[PENDING_KEY]);
          });
        } catch (_e) { finish(saved, null); }
      });
    } catch (_e) { finish({}, null); }
  }

  function onChanged(listener) {
    chrome.storage.onChanged.addListener((changes, area) => {
      const applied = {};
      const accept = (key, value) => {
        if (Object.is(seen[key], value)) return;
        applied[key] = { oldValue: seen[key], newValue: value };
        seen[key] = value;
      };
      if (area === "local" && changes[PENDING_KEY]) {
        pending = valuesOf(changes[PENDING_KEY].newValue?.values);
        for (const [key, value] of Object.entries(pending)) accept(key, value);
      } else if (area === "sync") {
        for (const [key, change] of Object.entries(changes)) {
          if (!Object.hasOwn(pending, key)) accept(key, change.newValue);
        }
      }
      if (Object.keys(applied).length) listener(applied, "sync");
    });
  }

  function set(patch) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: "saveSettings", patch }, (reply) => {
          const error = chrome.runtime.lastError;
          if (error || !reply?.ok) reject(new Error(error?.message || reply?.error || "Settings were not saved"));
          else resolve();
        });
      } catch (error) { reject(error); }
    });
  }

  function schedule() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (!record || !Object.keys(record.values).length) return;
    timer = setTimeout(() => {
      timer = null;
      serialize(flush).catch(() => { /* staging stays durable; resume on next worker start */ });
    }, Math.max(DEBOUNCE_MS, record.nextSyncAt - Date.now()));
  }

  function startSync() {
    if (!ready) {
      ready = chrome.storage.local.get(PENDING_KEY).then((saved) => {
        const staged = saved[PENDING_KEY];
        record = { values: valuesOf(staged?.values),
          nextSyncAt: Number.isFinite(staged?.nextSyncAt) ? staged.nextSyncAt : 0 };
        schedule();
      });
      ready.catch(() => {}); // report initialization failure to callers, never unhandled
    }
    return ready;
  }

  function serialize(operation) {
    const task = chain.then(() => startSync()).then(operation);
    chain = task.catch(() => {});
    return task;
  }

  async function flush() {
    if (!Object.keys(record.values).length) return;
    if (Date.now() < record.nextSyncAt) { schedule(); return; }
    const values = { ...record.values };
    try {
      await chrome.storage.sync.set(values);
      record = { values: {}, nextSyncAt: Date.now() + SYNC_INTERVAL_MS };
    } catch (error) {
      // Keep local edits visible. The timer retries while the worker is awake;
      // a suspended worker resumes the durable queue on its next activation.
      const wait = /MAX_WRITE_OPERATIONS_PER_HOUR/.test(String(error)) ? 3601000
        : /MAX_WRITE_OPERATIONS_PER_MINUTE/.test(String(error)) ? 61000 : 5000;
      record = { values, nextSyncAt: Date.now() + wait };
    }
    await chrome.storage.local.set({ [PENDING_KEY]: record });
    schedule();
  }

  function enqueue(patch) {
    const values = valuesOf(patch);
    if (!Object.keys(values).length) return Promise.reject(new Error("Invalid settings patch"));
    return serialize(async () => {
      const next = { ...record, values: { ...record.values, ...values } };
      await chrome.storage.local.set({ [PENDING_KEY]: next });
      record = next;
      schedule();
    });
  }

  globalThis.YtdsSettings = { get, set, onChanged, startSync, enqueue };
})();
