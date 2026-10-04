// Shared, dependency-free study links and Anki text export.
(() => {
  "use strict";
  function videoInfo(key) {
    if (typeof key !== "string") return null;
    const match = key.match(/^(BV[0-9A-Za-z]+|av\d+)#p([1-9]\d{0,6})$/);
    if (match) return { platform: "bilibili", id: match[1], part: Number(match[2]) };
    if (/^[A-Za-z0-9_-]{8,20}$/.test(key)) return { platform: "youtube", id: key, part: 1 };
    return null;
  }

  function videoLink(key, start) {
    const info = videoInfo(key);
    if (!info || !Number.isFinite(start) || start < 0) return "";
    const seconds = Math.floor(start / 1000);
    return info.platform === "bilibili"
      ? "https://www.bilibili.com/video/" + info.id + "/?p=" + info.part + "&t=" + seconds
      : "https://www.youtube.com/watch?v=" + info.id + "&t=" + seconds + "s";
  }

  function field(value) {
    return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\t/g, "&#9;")
      .replace(/\r\n?|\n/g, "<br>").replace(/\0/g, "");
  }

  const ID_RE = /^ytds:[A-Za-z0-9._#:-]{1,180}$/;
  function stableId(value) {
    if (typeof value?.id === "string" && ID_RE.test(value.id)) return value.id;
    // Legacy cards keep their old text-derived identity until explicitly migrated.
    return value.videoId + ":" + value.start + ":" + value.text;
  }

  function boundedText(value, limit) {
    return typeof value === "string" ? value.slice(0, limit) : "";
  }

  function readCard(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const info = videoInfo(value.videoId);
    if (!info || typeof value.text !== "string" || !value.text.trim() || value.text.length > 2000 ||
        !Number.isFinite(value.start) || value.start < 0 || value.start > 1e12 ||
        !Number.isInteger(value.index) || value.index < 0) return null;
    return {
      id: stableId(value),
      videoId: value.videoId, platform: info.platform,
      title: typeof value.title === "string" ? value.title.slice(0, 300) : value.videoId,
      sourceLang: /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(value.sourceLang || "") ? value.sourceLang : "auto",
      index: value.index, start: value.start, text: value.text,
      trans: typeof value.trans === "string" ? value.trans.slice(0, 2000) : "",
      known: value.known === true,
      rawOriginal: boundedText(value.rawOriginal, 2000),
      uncertain: value.uncertain === true,
      uncertaintyReasons: Array.isArray(value.uncertaintyReasons)
        ? value.uncertaintyReasons.filter(reason => typeof reason === "string").slice(0, 8)
          .map(reason => reason.slice(0, 120))
        : [],
      corrected: value.corrected === true,
      savedAt: Number.isFinite(value.savedAt) && value.savedAt > 0 ? value.savedAt : Date.now()
    };
  }

  function toAnkiTsv(cards) {
    const rows = ["#separator:Tab", "#html:true", "#tags column:9",
      "#columns:CardId\tOriginal\tTranslation\tTitle\tVideoId\tTimeSeconds\tURL\tSourceLanguage\tTags"];
    const seen = new Set();
    for (const card of cards) {
      const info = videoInfo(card?.videoId), url = videoLink(card?.videoId, card?.start);
      if (!info || !url || typeof card.text !== "string" || !card.text.trim()) {
        throw new Error("Invalid study card");
      }
      const id = stableId(card);
      if (seen.has(id)) continue;
      seen.add(id);
      const lang = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(card.sourceLang || "") ? card.sourceLang : "auto";
      const tags = ["yt_dual_subs", info.platform, "lang_" + lang.replace(/-/g, "_"),
        card.known ? "known" : "review"].join(" ");
      rows.push([id, card.text, card.trans, card.title, card.videoId,
        Math.floor(card.start / 1000), url, lang, tags].map(field).join("\t"));
    }
    return rows.join("\n") + "\n";
  }
  globalThis.YtdsStudyExport = { videoInfo, videoLink, toAnkiTsv, readCard };
})();
