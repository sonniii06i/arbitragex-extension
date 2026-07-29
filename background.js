// Arbitragex Service-Worker: proxyt API-Calls zur Arbitragex-Instanz mit der
// Login-Session (Cookie). Content-Scripts dürfen selbst nicht cross-origin.
const DEFAULT_BASE = "https://arbitrage.anwaltx.de";

async function base() {
  const { baseUrl } = await chrome.storage.sync.get("baseUrl");
  return (baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
