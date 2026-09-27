// background.js — translation service worker
// Routes cross-origin translation requests here so host_permissions apply
// and content scripts never hit page-CORS restrictions.

const CACHE = new Map();          // key: `${sl}\u0000${tl}\u0000${text}` -> translated string
const CACHE_MAX = 2000;           // simple LRU-ish cap

function cacheGet(key) {
  if (!CACHE.has(key)) return undefined;
  const v = CACHE.get(key);
  CACHE.delete(key);              // refresh recency
  CACHE.set(key, v);
  return v;
}

function cacheSet(key, val) {
  CACHE.set(key, val);
  if (CACHE.size > CACHE_MAX) {
    // drop oldest
    const firstKey = CACHE.keys().next().value;
    CACHE.delete(firstKey);
  }
}

// Unofficial, key-free Google Translate endpoint (same one most free tools use).
// Returns a nested array; translated chunks live at data[0][i][0].

// A request that never settles would hold one of the content script's few
// in-flight slots forever, so every attempt gets its own deadline. One retry
// covers a dropped connection; a rate-limit answer is never retried, because
// that only deepens the limit.
const REQUEST_TIMEOUT_MS = 8000;

async function fetchOnce(url) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
  try {
    return await fetch(url, { method: "GET", signal: controller ? controller.signal : undefined });
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function translate(text, targetLang, sourceLang) {
  // YouTube's track language is more reliable than automatic detection for a
  // short subtitle. Screen-caption fallback has no track and stays on auto.
  const sl = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(sourceLang || "")
    ? sourceLang : "auto";
  const key = `${sl}\u0000${targetLang}\u0000${text}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const url =
    "https://translate.googleapis.com/translate_a/single" +
    "?client=gtx&sl=" + encodeURIComponent(sl) +
    "&tl=" + encodeURIComponent(targetLang) +
    "&dt=t&q=" + encodeURIComponent(text);

  let res;
  try {
    res = await fetchOnce(url);
  } catch (err) {
    // Timeout or network failure: try exactly once more, then give up.
    res = await fetchOnce(url);
  }
  if (!res.ok) throw new Error("translate http " + res.status);
  const data = await res.json();

  let out = "";
  if (Array.isArray(data) && Array.isArray(data[0])) {
    for (const seg of data[0]) {
      if (seg && typeof seg[0] === "string") out += seg[0];
    }
  }
  out = out.trim();
  if (out) cacheSet(key, out);
  return out;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "translate") {
    translate(msg.text, msg.targetLang, msg.sourceLang)
      .then((translated) => sendResponse({ ok: true, translated }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep the message channel open for the async response
  }
});

// Keyboard shortcuts -> content.js. Each command maps to one message type; an
// unknown command (or a non-YouTube tab with no content script) is ignored.
const COMMAND_MESSAGES = {
  "toggle-translation": "toggleTranslation",
  "repeat-sentence": "repeatSentence",
  "reveal-translation": "revealTranslation"
};

chrome.commands.onCommand.addListener((command) => {
  const type = COMMAND_MESSAGES[command];
  if (!type) return;
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    if (chrome.runtime.lastError || !tabs || tabs[0]?.id == null) return;
    chrome.tabs.sendMessage(tabs[0].id, { type }, () => {
      // A non-YouTube tab has no content script to receive the command.
      void chrome.runtime.lastError;
    });
  });
});
