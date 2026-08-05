// Arbitragex Service-Worker: proxyt API-Calls zur Arbitragex-Instanz mit der
// Login-Session (Cookie). Content-Scripts dürfen selbst nicht cross-origin.
const DEFAULT_BASE = "https://arbitragex.de";
// Bis v1.6.4 lief alles auf arbitrage.anwaltx.de. Wer die Adresse damals im
// Popup gesetzt hat, hat sie noch in storage.sync stehen — die wuerde den neuen
// Default ueberschreiben und die Extension auf der alten Domain festnageln
// (dort laeuft nach dem Umzug keine Login-Session mehr). Einmalig ausraeumen.
const LEGACY_BASES = ["https://arbitrage.anwaltx.de", "http://arbitrage.anwaltx.de"];

async function base() {
  const { baseUrl } = await chrome.storage.sync.get("baseUrl");
  const stored = (baseUrl || "").replace(/\/+$/, "");
  if (stored && LEGACY_BASES.includes(stored)) {
    await chrome.storage.sync.remove("baseUrl");
    return DEFAULT_BASE;
  }
  return (stored || DEFAULT_BASE).replace(/\/+$/, "");
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Der AX-Knopf auf der Seite oeffnet das Popup oben rechts. openPopup() gibt
  // es erst ab Chrome 127 und nur hier im Service-Worker — schlaegt es fehl,
  // meldet die Antwort das, und der Chip oeffnet stattdessen arbitragex.de.
  if (msg && msg.type === "axx-open-popup") {
    try {
      chrome.action.openPopup()
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
    } catch (e) { sendResponse({ ok: false }); }
    return true;
  }
  if (!msg || !msg.path) return;   // nicht fuer uns (z. B. Nachrichten ans Content-Script)

  (async () => {
    try {
      const b = await base();
      const opts = { method: msg.method || "GET", credentials: "include", headers: {} };
      if (msg.body) {
        opts.headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(msg.body);
      }
      const r = await fetch(b + msg.path, opts);
      let data = {};
      try { data = await r.json(); } catch (e) { /* leer */ }
      sendResponse({ ok: r.ok, status: r.status, data });
    } catch (e) {
      sendResponse({ ok: false, status: 0, error: String(e && e.message || e) });
    }
  })();
  return true; // async
});
