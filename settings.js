// Shared preference storage. Local staging keeps live edits safe when a popup
// closes; the existing service worker batches writes to browser sync storage.
(() => {
  "use strict";
  const PENDING_KEY = "settingsPendingV1";
  const BRIDGE_KEY = "bridgeConfigV1";
  const BRIDGE_KEYS = new Set(["bridgeToken"]);
  const SYNC_INTERVAL_MS = 2500; // <= 24 writes/minute, <= 1440 writes/hour
  const DEBOUNCE_MS = 250;
  let pending = {};
  const seen = {};
  let record, ready, chain = Promise.resolve(), timer = null;
  function readArea(area, keys) {
    return new Promise((resolve, reject) => {
      try {
        const result = area.get(keys, (value) => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error("Settings storage read failed"));
          else resolve(value || {});
        });
        if (result && typeof result.then === "function") result.then((value) => resolve(value || {}), reject);
      } catch (error) { reject(error); }
    });
  }

  const ALLOWED_KEYS = new Set([
    "enabled", "targetLang", "backend", "order", "rowGap", "overlayWidthPct", "position",
    "offsetMs", "repeatCount", "studyRate", "autoPause", "karaoke", "karaokeApproximate", "timingMode",
    "karaokeBg", "karaokeTextColor", "karaokeOpacity", "karaokeStyleV2", "wordLookup", "revealMode", "autoCaptions",
    "posMode", "posXpct", "posYpct", "showOriginal", "origFont", "origSize", "origColor",
    "origBg", "origBgOpacity", "origStroke", "origStrokeOpacity", "showTranslation", "transFont",
    "transSize", "transColor", "transBg", "transBgOpacity", "transStroke", "transStrokeOpacity",
    "bbTrackId", "bbTracks", "bridgeBase", "bridgeToken", "recognitionLanguage", "bbEnabled", "bbTargetLang", "bbOrder",
    "bbGermanLayoutV1", "fontSizeRepair20260926"
  ]);
  const BOOLEAN_KEYS = new Set([
    "enabled", "autoPause", "karaoke", "karaokeApproximate", "wordLookup", "autoCaptions", "showOriginal",
    "showTranslation", "bbEnabled", "bbGermanLayoutV1", "fontSizeRepair20260926", "karaokeStyleV2"
  ]);
  const ENUM_KEYS = {
    recognitionLanguage: new Set(["auto", "zh", "de", "en"]),
    backend: new Set(["tlang", "gtx", "fast"]),
    order: new Set(["orig-top", "trans-top"]),
    position: new Set(["top", "center", "bottom"]),
    timingMode: new Set(["auto", "approximate", "audio"]),
    revealMode: new Set(["always", "hover", "manual"]),
    posMode: new Set(["preset", "custom"]),
    origFont: new Set(["system", "roboto", "noto", "arial", "georgia", "times", "mono", "cjk"]),
    transFont: new Set(["system", "roboto", "noto", "arial", "georgia", "times", "mono", "cjk"])
  };
  const COLOR_KEYS = new Set([
    "karaokeBg", "karaokeTextColor", "origColor", "origBg", "origStroke", "transColor", "transBg", "transStroke"
  ]);
  const NUMBER_RANGES = {
    rowGap: [0, 64], overlayWidthPct: [0, 96], offsetMs: [-120000, 120000], repeatCount: [-1, 20],
    studyRate: [0.25, 2], karaokeOpacity: [0, 1], origSize: [8, 96], transSize: [8, 96],
    origBgOpacity: [0, 1], origStrokeOpacity: [0, 1], transBgOpacity: [0, 1], transStrokeOpacity: [0, 1],
    posXpct: [0, 100], posYpct: [0, 100]
  };

  function isLoopbackBase(value) {
    const text = String(value || "").trim();
    if (!text) return true;
    const candidate = /^https?:\/\//i.test(text) ? text : "http://" + text;
    try {
      const u = new URL(candidate);
      const host = String(u.hostname || "").toLowerCase();
      return /^https?:$/.test(u.protocol) &&
        (host === "127.0.0.1" || host === "localhost") &&
        !u.username && !u.password && !u.search && !u.hash && u.pathname === "/";
    } catch (_e) {
      return /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/?$/i.test(candidate);
    }
  }

  function validValue(key, val) {
    if (!ALLOWED_KEYS.has(key)) return false;
    if (BOOLEAN_KEYS.has(key)) return typeof val === "boolean";
    if (ENUM_KEYS[key]) return typeof val === "string" && ENUM_KEYS[key].has(val);
    if (COLOR_KEYS.has(key)) return typeof val === "string" && /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(val);
    if (key === "targetLang" || key === "bbTargetLang") {
      return typeof val === "string" && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(val) && val.length <= 32;
    }
    if (key === "bridgeBase") return typeof val === "string" && val.length <= 256 && isLoopbackBase(val);
    if (key === "bridgeToken") return typeof val === "string" && val.length <= 512 && /^[\x21-\x7e]*$/.test(val);
    if (NUMBER_RANGES[key]) {
      const n = Number(val), range = NUMBER_RANGES[key];
      return typeof val === "number" && Number.isFinite(n) && n >= range[0] && n <= range[1] &&
        (key !== "repeatCount" || Number.isInteger(n));
    }
    if (key === "bbTracks") return typeof val === "string" && val.length <= 32768;
    if (key === "bbTrackId") return typeof val === "string" && val.length <= 256;
    return typeof val === "string" && val.length <= 2000;
  }

  function valuesOf(value) {
    const values = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return values;
    for (const [key, val] of Object.entries(value)) {
      if (validValue(key, val)) values[key] = val;
    }
    return values;
  }

  function syncValues(value) {
    const values = valuesOf(value);
    for (const key of BRIDGE_KEYS) delete values[key];
    return values;
  }

  function get(defaults, done) {
    const finish = (saved, local) => {
      pending = syncValues(local?.[PENDING_KEY]?.values);
      const result = { ...defaults, ...syncValues(saved), ...pending };
      let highlightRepair = null;
      if (Object.hasOwn(defaults, "karaokeStyleV2") && !result.karaokeStyleV2) {
        highlightRepair = { karaokeStyleV2: true };
        // Only replace the old complete default palette, once. Custom palettes
        // and later deliberate edits must keep their chosen foreground.
        if (result.karaokeBg?.toLowerCase() === "#ffd65c" &&
            result.karaokeTextColor?.toLowerCase() === "#161616" && result.karaokeOpacity === 0.95) {
          highlightRepair.karaokeTextColor = "#ffffff";
        }
        Object.assign(result, highlightRepair);
      }
      // The worker authenticates the actual popup sender before returning secrets.
      const complete = () => {
        Object.assign(seen, result);
        done(result);
        if (highlightRepair) set(highlightRepair).catch(() => {});
      };
      if (Object.hasOwn(defaults, "bridgeToken")) {
        chrome.runtime.sendMessage({ type: "getBridgeConfig" }, reply => {
          void chrome.runtime.lastError;
          result.bridgeToken = reply?.ok ? reply.bridgeToken : defaults.bridgeToken;
          complete();
        });
      } else complete();
    };
    try {
      chrome.storage.sync.get(defaults, (saved) => {
        if (chrome.runtime.lastError) saved = {};
        try {
          chrome.storage.local.get([PENDING_KEY, BRIDGE_KEY], (local) => {
            const error = chrome.runtime.lastError;
            finish(saved, error ? null : local);
          });
        } catch (_e) { finish(saved, null); }
      });
    } catch (_e) { finish({}, null); }
  }

  function onChanged(listener) {
    chrome.storage.onChanged.addListener((changes, area) => {
      const applied = {};
      const accept = (key, value) => {
        if (!validValue(key, value)) return;
        if (Object.is(seen[key], value)) return;
        applied[key] = { oldValue: seen[key], newValue: value };
        seen[key] = value;
      };
      if (area === "local" && changes[PENDING_KEY]) {
        pending = syncValues(changes[PENDING_KEY].newValue?.values);
        for (const [key, value] of Object.entries(pending)) accept(key, value);
      } else if (area === "sync") {
        for (const [key, change] of Object.entries(changes)) {
          if (!BRIDGE_KEYS.has(key) && !Object.hasOwn(pending, key)) accept(key, change.newValue);
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
      ready = (async () => {
        const saved = await readArea(chrome.storage.local, [PENDING_KEY, BRIDGE_KEY]);
        const synced = await readArea(chrome.storage.sync, ["bridgeBase", "bridgeToken"]);
        const staged = saved[PENDING_KEY];
        // Preserve newer local edits before removing the legacy synchronized copy.
        // An existing local record (including an empty token) prevents re-import.
        const existing = await YtdsBridgeVault.read();
        const legacy = { ...valuesOf(synced), ...valuesOf(staged?.values) };
        const localToken = valuesOf(saved[BRIDGE_KEY]).bridgeToken;
        const token = existing ?? localToken ?? legacy.bridgeToken ?? "";
        await YtdsBridgeVault.write(token);
        record = { values: syncValues(staged?.values),
          nextSyncAt: Number.isFinite(staged?.nextSyncAt) ? staged.nextSyncAt : 0 };
        // Overwrite the old record only after the private transaction commits.
        await chrome.storage.local.set({ [BRIDGE_KEY]: {}, [PENDING_KEY]: record });
        if ([...BRIDGE_KEYS].some((key) => Object.hasOwn(synced, key))) {
          if (typeof chrome.storage.sync.remove === "function") {
            await chrome.storage.sync.remove([...BRIDGE_KEYS]);
          }
        }
        schedule();
      })();
      ready.catch(() => { ready = null; }); // later worker messages may retry
    }
    return ready;
  }

  async function getBridgeConfig() {
    await startSync();
    const token = await YtdsBridgeVault.read();
    const synced = await readArea(chrome.storage.sync, ["bridgeBase"]);
    return { bridgeBase: record.values.bridgeBase ?? synced.bridgeBase ?? "", bridgeToken: token || "" };
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
    const input = patch && typeof patch === "object" && !Array.isArray(patch) ? Object.keys(patch) : [];
    if (!Object.keys(values).length || input.length !== Object.keys(values).length) {
      return Promise.reject(new Error("Invalid settings patch"));
    }
    return serialize(async () => {
      const next = { ...record, values: { ...record.values, ...syncValues(values) } };
      const local = { [PENDING_KEY]: next };
      if ([...BRIDGE_KEYS].some((key) => Object.hasOwn(values, key))) {
        await YtdsBridgeVault.write(values.bridgeToken);
      }
      await chrome.storage.local.set(local);
      record = next;
      schedule();
    });
  }

  globalThis.YtdsSettings = { get, set, onChanged, startSync, enqueue, getBridgeConfig };
})();
