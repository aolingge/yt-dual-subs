// Persistent credentials belong to the extension origin. Content scripts use
// the video site's IndexedDB origin and cannot open this database.
(() => {
  "use strict";
  let database;
  function open() {
    if (!database) {
      database = new Promise((resolve, reject) => {
        const request = indexedDB.open("ytds-private", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("credentials");
        request.onerror = () => reject(new Error("Credential storage unavailable"));
        request.onblocked = () => reject(new Error("Credential storage blocked"));
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); database = null; };
          resolve(db);
        };
      });
      database.catch(() => { database = null; });
    }
    return database;
  }
  async function transaction(mode, operation) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("credentials", mode);
      let value;
      const request = operation(tx.objectStore("credentials"));
      request.onsuccess = () => { value = request.result; };
      tx.oncomplete = () => resolve(value);
      tx.onabort = tx.onerror = () => reject(new Error("Credential storage failed"));
    });
  }
  globalThis.YtdsBridgeVault = {
    read: () => transaction("readonly", store => store.get("bridgeToken")),
    write: token => transaction("readwrite", store => store.put(token, "bridgeToken"))
  };
})();
