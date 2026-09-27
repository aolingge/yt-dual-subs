// Video study workspace in the popup. Sentence data comes from the active
// YouTube tab; saved sentences live only in this browser's storage.local.
(() => {
  "use strict";

  const STORE_KEY = "studyCardsV1";
  const MAX_CARDS = 1000;
  const $study = (id) => document.getElementById(id);
  let cards = [];
  let cardsReady = false;
  let sourceVideoId = "";
  let transcriptVideoId = "";
  let transcriptTitle = "";
  let transcriptLang = "auto";
  let transcriptOffset = 0;
  let transcriptTotal = 0;
  let listSerial = 0;
  let searchTimer = 0;

  function say(message, kind) {
    const el = $study("studyMsg");
    el.textContent = message || "";
    el.className = "study-msg" + (kind ? " " + kind : "");
    el.hidden = !message;
  }

  function timeLabel(ms) {
    const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const minutes = Math.floor(seconds / 60);
    const parts = [String(minutes).padStart(2, "0"), String(seconds % 60).padStart(2, "0")];
    return parts.join(":");
  }

  function button(label, onClick) {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = label;
    el.addEventListener("click", onClick);
    return el;
  }

  async function activeMessage(message) {
    const tab = await getActiveTab();
    return tab && tab.id != null ? sendToTab(tab.id, message) : null;
  }

  function showSource(status) {
    const el = $study("studySource");
    el.className = "study-source";
    if (!status || status.mode === "off") {
      el.textContent = t("studyNoTrack", "等待视频");
      return;
    }
    if (status.mode === "scrape") {
      el.textContent = t("studyFallback", "画面字幕，语言未确认");
      el.classList.add("warn");
      return;
    }
    const lang = String(status.sourceLang || "auto");
    const target = String(status.targetLang || "");
    if (status.mode !== "cues" || lang === "auto") {
      el.textContent = t("studyUnknownTrack", "字幕语言未确认");
    } else {
      el.textContent = t("studySourceTrack", "原文轨") + " " + lang +
        (target ? " → " + target : "");
      el.classList.add("good");
    }
  }

  async function refreshSource() {
    const status = await activeMessage({ type: "status" });
    showSource(status);
    const nextId = status && status.videoId ? status.videoId : "";
    if (nextId !== sourceVideoId) {
      sourceVideoId = nextId;
      if ($study("transcriptPanel").open) loadTranscript(true);
    }
  }

  async function loadCards() {
    if (cardsReady) return;
    const stored = await chrome.storage.local.get(STORE_KEY);
    cards = Array.isArray(stored[STORE_KEY])
      ? stored[STORE_KEY].filter((card) => card && typeof card.id === "string" &&
          typeof card.videoId === "string" && typeof card.text === "string")
      : [];
    cardsReady = true;
    renderSaved();
  }

  async function storeCards(next) {
    await chrome.storage.local.set({ [STORE_KEY]: next });
    cards = next;
    renderSaved();
  }

  async function exportCards() {
    try {
      await loadCards();
      if (!cards.length) {
        say(t("studyExportEmpty", "没有可导出的收藏。"), "err");
        return;
      }
      const payload = { format: "yt-dual-subs-study", version: 1, cards };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json;charset=utf-8"
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "yt-dual-subs-study-" + new Date().toISOString().slice(0, 10) + ".json";
      document.body.appendChild(link);
      link.click();
      setTimeout(() => { URL.revokeObjectURL(url); link.remove(); }, 2000);
      say(t("studyExportDone", "收藏备份已下载。"), "ok");
    } catch (_e) {
      say(t("studyExportFailed", "导出收藏失败，请重试。"), "err");
    }
  }

  function readImportedCard(value) {
    if (!value || typeof value !== "object") return null;
    const videoId = value.videoId;
    const text = value.text;
    const start = Number(value.start);
    const index = Number(value.index);
    if (typeof videoId !== "string" || !/^[A-Za-z0-9_-]{8,20}$/.test(videoId) ||
        typeof text !== "string" || !text.trim() || text.length > 1000 ||
        typeof value.index !== "number" ||
        !Number.isFinite(start) || start < 0 || !Number.isInteger(index) ||
        index < 0) return null;
    const title = typeof value.title === "string" ? value.title.slice(0, 300) : videoId;
    const trans = typeof value.trans === "string" ? value.trans.slice(0, 2000) : "";
    const savedAt = Number(value.savedAt);
    return {
      id: videoId + ":" + start + ":" + text,
      videoId, title, sourceLang: typeof value.sourceLang === "string"
        ? value.sourceLang.slice(0, 30) : "auto",
      index, start, text, trans, known: value.known === true,
      savedAt: Number.isFinite(savedAt) && savedAt > 0 ? savedAt : Date.now()
    };
  }

  async function importCards(file) {
    if (!file) return;
    try {
      if (file.size > 8 * 1024 * 1024) {
        say(t("studyImportTooLarge", "备份文件过大，已停止导入。"), "err");
        return;
      }
      const data = JSON.parse(await file.text());
      if (!data || data.format !== "yt-dual-subs-study" ||
          data.version !== 1 || !Array.isArray(data.cards) ||
          data.cards.length > MAX_CARDS) {
        say(t("studyImportInvalid", "这不是有效的收藏备份。"), "err");
        return;
      }
      const imported = data.cards.map(readImportedCard);
      if (!imported.length || imported.some((card) => !card)) {
        say(t("studyImportInvalid", "这不是有效的收藏备份。"), "err");
        return;
      }
      await loadCards();
      const merged = new Map(cards.map((card) => [card.id, card]));
      for (const card of imported) if (!merged.has(card.id)) merged.set(card.id, card);
      if (merged.size > MAX_CARDS) {
        say(t("studyImportFull", "导入后会超过收藏上限，未修改现有收藏。"), "err");
        return;
      }
      const added = merged.size - cards.length;
      await storeCards([...merged.values()]);
      say(t("studyImportDone", "已导入收藏") + " (" + added + ")", "ok");
    } catch (_e) {
      say(t("studyImportInvalid", "这不是有效的收藏备份。"), "err");
    }
  }

  function cardFromCue(cue, videoId, title, sourceLang) {
    return {
      id: videoId + ":" + cue.start + ":" + cue.text,
      videoId, title: title || videoId, sourceLang: sourceLang || "auto",
      index: cue.index, start: cue.start, text: cue.text,
      trans: cue.trans || "", known: false, savedAt: Date.now()
    };
  }

  async function saveCue(cue, videoId, title, sourceLang) {
    await loadCards();
    const card = cardFromCue(cue, videoId, title, sourceLang);
    const old = cards.find((item) => item.id === card.id);
    if (!old && cards.length >= MAX_CARDS) {
      say(t("studyLibraryFull", "收藏已满，请整理后再保存。"), "err");
      return;
    }
    const next = old
      ? cards.map((item) => item.id === card.id
        ? { ...card, known: item.known, savedAt: item.savedAt,
            trans: card.trans || item.trans } : item)
      : [card, ...cards];
    await storeCards(next);
    say(t("studySavedDone", "已收藏，稍后可以回听复习。"), "ok");
  }

  async function saveCurrent() {
    const el = $study("saveSentence");
    el.disabled = true;
    try {
      const result = await activeMessage({ type: "studyCurrent" });
      if (!result || !result.ok || !result.cue) {
        say(t("studyNoSentence", "当前没有可收藏的字幕句，请先播放有字幕的视频。"), "err");
        return;
      }
      await saveCue(result.cue, result.videoId, result.title, result.sourceLang);
    } catch (_e) {
      say(t("studyStoreFailed", "收藏失败，请检查浏览器存储后重试。"), "err");
    } finally {
      el.disabled = false;
    }
  }

  async function seekCue(videoId, index) {
    const result = await activeMessage({ type: "studySeek", videoId, index });
    if (result && result.ok) {
      window.close();
      return true;
    }
    say(t("studySeekFailed", "跳转失败，请刷新视频页面后重试。"), "err");
    return false;
  }

  function appendTranscript(entry) {
    const row = document.createElement("div");
    row.className = "study-item";
    const head = document.createElement("div");
    head.className = "study-item-head";
    head.textContent = timeLabel(entry.start) + "  ·  " + (entry.index + 1);
    const text = document.createElement("p");
    text.className = "study-item-text";
    text.textContent = entry.text;
    const actions = document.createElement("div");
    actions.className = "study-item-actions";
    actions.appendChild(button(t("studyPlay", "播放"), () =>
      seekCue(transcriptVideoId, entry.index)));
    actions.appendChild(button(t("studySaveShort", "收藏"), () => {
      saveCue(entry, transcriptVideoId, transcriptTitle, transcriptLang)
        .catch(() => say(t("studyStoreFailed", "收藏失败，请检查浏览器存储后重试。"), "err"));
    }));
    row.appendChild(head);
    row.appendChild(text);
    if (entry.trans) {
      const translation = document.createElement("p");
      translation.className = "study-item-trans";
      translation.textContent = entry.trans;
      row.appendChild(translation);
    }
    row.appendChild(actions);
    $study("transcriptList").appendChild(row);
  }

  async function loadTranscript(reset) {
    const serial = ++listSerial;
    if (reset) {
      transcriptOffset = 0;
      $study("transcriptList").textContent = "";
    }
    const result = await activeMessage({
      type: "studyCues", query: $study("transcriptSearch").value,
      offset: transcriptOffset, limit: 40
    });
    if (serial !== listSerial) return;
    if (!result || !result.ok) {
      $study("transcriptList").textContent = t("studyNoTranscript",
        "暂无逐句字幕。请确认视频有字幕并播放几秒。");
      $study("transcriptCount").textContent = "";
      $study("transcriptMore").hidden = true;
      return;
    }
    transcriptVideoId = result.videoId;
    transcriptTitle = result.title;
    transcriptLang = result.sourceLang;
    transcriptTotal = result.total;
    for (const entry of result.entries) appendTranscript(entry);
    transcriptOffset += result.entries.length;
    $study("transcriptCount").textContent = String(transcriptTotal);
    $study("transcriptMore").hidden = transcriptOffset >= transcriptTotal;
    if (reset && transcriptTotal === 0) {
      $study("transcriptList").textContent = t("studyNoMatches", "没有匹配的句子。");
    }
  }

  async function playSaved(card) {
    if (sourceVideoId === card.videoId && Number.isInteger(card.index)) {
      const result = await activeMessage({
        type: "studySeek", videoId: card.videoId, index: card.index,
        expectedStart: card.start
      });
      if (result && result.ok) { window.close(); return; }
    }
    const url = "https://www.youtube.com/watch?v=" +
      encodeURIComponent(card.videoId) + "&t=" +
      Math.max(0, Math.floor(card.start / 1000)) + "s";
    chrome.tabs.create({ url });
    window.close();
  }

  function renderSaved() {
    const list = $study("savedList");
    list.textContent = "";
    $study("savedCount").textContent = String(cards.length);
    if (!cards.length) {
      list.textContent = t("studyNothingSaved", "还没有收藏的句子。");
      list.classList.add("study-empty");
      return;
    }
    list.classList.remove("study-empty");
    const sorted = cards.slice().sort((a, b) =>
      Number(a.known) - Number(b.known) || b.savedAt - a.savedAt);
    for (const card of sorted) {
      const row = document.createElement("div");
      row.className = "study-item" + (card.known ? " known" : "");
      const head = document.createElement("div");
      head.className = "study-item-head";
      const title = document.createElement("span");
      title.textContent = card.title || card.videoId;
      const time = document.createElement("span");
      time.textContent = timeLabel(card.start);
      head.appendChild(title);
      head.appendChild(time);
      const original = document.createElement("p");
      original.className = "study-item-text";
      original.textContent = card.text;
      const translation = document.createElement("p");
      translation.className = "study-item-trans";
      translation.textContent = card.trans || t("studyNoTranslation", "译文暂不可用");
      translation.hidden = true;
      const actions = document.createElement("div");
      actions.className = "study-item-actions";
      actions.appendChild(button(t("studyPlay", "播放"), () => playSaved(card)));
      const reveal = button(t("studyReveal", "显示译文"), () => {
        translation.hidden = !translation.hidden;
        reveal.textContent = translation.hidden
          ? t("studyReveal", "显示译文") : t("studyHide", "隐藏译文");
        reveal.setAttribute("aria-expanded", String(!translation.hidden));
      });
      reveal.setAttribute("aria-expanded", "false");
      actions.appendChild(reveal);
      actions.appendChild(button(card.known
        ? t("studyReviewAgain", "重新复习") : t("studyMarkKnown", "标记掌握"), () => {
        storeCards(cards.map((item) => item.id === card.id
          ? { ...item, known: !item.known } : item))
          .catch(() => say(t("studyStoreFailed", "保存失败，请重试。"), "err"));
      }));
      const remove = button(t("studyRemove", "移除"), () => {
        if (remove.dataset.confirm !== "yes") {
          remove.dataset.confirm = "yes";
          remove.textContent = t("studyConfirmRemove", "再次点击移除");
          return;
        }
        storeCards(cards.filter((item) => item.id !== card.id))
          .catch(() => say(t("studyStoreFailed", "保存失败，请重试。"), "err"));
      });
      actions.appendChild(remove);
      row.appendChild(head);
      row.appendChild(original);
      row.appendChild(translation);
      row.appendChild(actions);
      list.appendChild(row);
    }
  }

  async function applyStudyPreset() {
    const preset = {
      backend: "tlang", showOriginal: true,
      showTranslation: true, revealMode: "hover", karaoke: true,
      wordLookup: true,
      studyRate: 0.75, repeatCount: 0
    };
    try {
      await chrome.storage.sync.set(preset);
      Object.assign(state, preset);
      bindUI();
      say(t("studyPresetDone", "学习预设已启用，目标语言保持不变；请确认原文字幕轨。"), "ok");
    } catch (_e) {
      say(t("studyStoreFailed", "保存失败，请重试。"), "err");
    }
  }

  $study("transcriptSearch").placeholder = t("studySearch", "搜索这段视频的句子");
  $study("studyPreset").addEventListener("click", applyStudyPreset);
  $study("saveSentence").addEventListener("click", saveCurrent);
  $study("transcriptPanel").addEventListener("toggle", () => {
    if ($study("transcriptPanel").open) loadTranscript(true);
  });
  $study("transcriptSearch").addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadTranscript(true), 180);
  });
  $study("transcriptMore").addEventListener("click", () => loadTranscript(false));
  $study("studyExport").addEventListener("click", exportCards);
  $study("studyImportButton").addEventListener("click", () =>
    $study("studyImportFile").click());
  $study("studyImportFile").addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    importCards(file);
    event.target.value = "";
  });
  loadCards().catch(() => say(t("studyStoreFailed", "读取收藏失败，请重试。"), "err"));
  refreshSource();
  const statusTimer = setInterval(refreshSource, 3000);
  window.addEventListener("unload", () => clearInterval(statusTimer));
})();
