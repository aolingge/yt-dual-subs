// Every mutation is serialized in the worker, so multiple study windows cannot
// overwrite another window's new sentences with a stale copy of the collection.
(() => {
  "use strict";
  const KEY = "studyCardsV1", MAX_CARDS = 1000;
  let pending = Promise.resolve();
  async function update(message) {
    const stored = await chrome.storage.local.get(KEY);
    const cards = new Map();
    for (const value of Array.isArray(stored[KEY]) ? stored[KEY] : []) {
      const card = YtdsStudyExport.readCard(value);
      if (card) cards.set(card.id, card);
    }
    let added = 0;
    if (message.operation === "save" || message.operation === "import") {
      const input = message.operation === "save" ? [message.card] : message.cards;
      if (!Array.isArray(input) || !input.length || input.length > MAX_CARDS) throw new Error("invalid");
      const normalized = input.map(YtdsStudyExport.readCard);
      if (normalized.some(card => !card)) throw new Error("invalid");
      for (const card of normalized) {
        const old = cards.get(card.id);
        if (!old) { cards.set(card.id, card); added++; }
        else if (message.operation === "save") cards.set(card.id, {
          ...card, known: old.known, savedAt: old.savedAt, trans: card.trans || old.trans
        });
      }
      if (cards.size > MAX_CARDS) throw new Error("full");
    } else if (message.operation === "known") {
      if (typeof message.known !== "boolean" || typeof message.id !== "string") throw new Error("invalid");
      const card = cards.get(message.id);
      if (card) cards.set(card.id, { ...card, known: message.known });
    } else if (message.operation === "remove") {
      if (typeof message.id !== "string") throw new Error("invalid");
      cards.delete(message.id);
    } else if (message.operation !== "read") throw new Error("invalid");
    const values = [...cards.values()];
    if (message.operation !== "read") await chrome.storage.local.set({ [KEY]: values });
    return { ok: true, cards: values, added };
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type !== "studyCards") return;
    if (!extensionSender(sender, ["popup.html"])) { reply({ ok: false, code: "forbidden" }); return; }
    const task = pending.then(() => update(message));
    pending = task.catch(() => {});
    task.then(reply, error => reply({ ok: false, code: ["invalid", "full"].includes(error.message) ? error.message : "storage" }));
    return true;
  });
})();
