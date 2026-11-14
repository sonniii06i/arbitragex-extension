// Arbitragex Service-Worker: proxyt API-Calls zur Arbitragex-Instanz mit der
// Login-Session (Cookie). Content-Scripts dürfen selbst nicht cross-origin.
const DEFAULT_BASE = "https://arbitragex.de";
// 1.9.13: Freischaltungs- und Auszahlungs-Automat (automat.js) – läuft hier im Service-Worker mit der
// Seller-Central-Sitzung des Nutzers, alle 6 h per chrome.alarms oder auf Klick im Popup.
importScripts("automat.js");
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

// Nur diese API-Pfade darf der Proxy aufrufen (Methode + Pfad ohne Query).
// Vorher reichte er JEDEN Pfad mit Login-Cookie weiter — ein manipuliertes
// Content-Script haette so beliebige Konto-Endpunkte bedienen koennen.
// Neuer Endpunkt in content.js/popup.js => hier eintragen.
const ALLOWED = {
  GET: ["/api/ext/me", "/api/ext/ean", "/api/ext/analyze", "/api/ext/skus", "/api/ext/profit",   // profit
        "/api/ext/ean-suche",                                                                    // Shop -> Amazon
        "/api/ext/automat"],                                                                     // Automat-Stand
  POST: ["/api/purchases", "/api/purchases/export",
         "/api/ext/beobachtung", "/api/ext/einstellungen",                   // Profit-Panel
         "/api/ext/automat"],                                                // Automat-Schalter
};

function allowed(method, path) {
  if (typeof path !== "string" || !path.startsWith("/api/")) return false;
  if (path.includes("..") || path.includes("//") || path.includes("\\")) return false;
  const p = path.split("?")[0].split("#")[0];
  return (ALLOWED[method] || []).includes(p);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Nur Nachrichten aus dieser Extension (Content-Script/Popup) annehmen.
  if (!sender || sender.id !== chrome.runtime.id) return;
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
  // Angebotsliste (AOD) eines Amazon-Markts fuer das Profit-Panel: Namen und
  // angebotene Menge je Verkaeufer. Hier statt im Content-Script, weil amazon.de nicht
  // per fetch an amazon.fr darf (CORS). Mit der normalen Amazon-Sitzung des Nutzers,
  // ein Abruf je Markt und Seitenbesuch — wie ein Klick auf „Alle Angebote“.
  if (msg && msg.type === "axx-aod") {
    const tld = { de: "de", fr: "fr", it: "it", es: "es" }[msg.mk];
    if (!tld || !/^[A-Z0-9]{10}$/.test(String(msg.asin || ""))) { sendResponse({ ok: false, error: "ungültig" }); return; }
    fetch("https://www.amazon." + tld + "/gp/product/ajax/aodAjaxMain/?asin=" + msg.asin + "&pc=dp&experienceId=aodAjaxMain",
          { credentials: "include" })
      .then(async (r) => {
        const html = await r.text();
        // Captcha-/Sperrseite ist ein Fehler, keine leere Angebotsliste (Kodex)
        if (!r.ok || /captcha|api-services-support/i.test(html.slice(0, 4000)) && !/aod-offer/.test(html)) {
          sendResponse({ ok: false, status: r.status, error: r.ok ? "Amazon-Prüfseite" : "HTTP " + r.status });
        } else sendResponse({ ok: true, status: r.status, html: html.slice(0, 900000) });
      })
      .catch((e) => sendResponse({ ok: false, status: 0, error: String(e && e.message || e) }));
    return true;
  }
  // Automat: Lauf auf Klick im Popup bzw. Alarm anlegen
  if (msg && msg.type === "axx-automat-jetzt") {
    automatLauf("popup").then((st) => sendResponse({ ok: true, stand: st })).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  if (msg && msg.type === "axx-automat-alarm") {
    automatAlarm().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  // 1.9.20: Klick auf „AX“ im Chip einer Shop-Seite -> Profit-Panel auf dieser Seite (wie das Rechtsklick-Menü)
  if (msg && msg.type === "axx-panel-hier") {
    const e = String(msg.ean || "").replace(/\D/g, "");
    const k = [8, 12, 13, 14].includes(e.length) ? { art: "ean", wert: e } : axxKennung(msg.titel);
    if (!k || !sender.tab || sender.tab.id == null) { sendResponse({ ok: false }); return; }
    axxPanelZeigen(sender.tab, k).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (!msg || !msg.path) return;   // nicht fuer uns (z. B. Nachrichten ans Content-Script)

  const method = String(msg.method || "GET").toUpperCase();
  if (!allowed(method, msg.path)) {
    sendResponse({ ok: false, status: 403, error: "Pfad nicht erlaubt" });
    return;
  }

  (async () => {
    try {
      const b = await base();
      const opts = { method, credentials: "include", headers: {} };
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


/* --- EAN-Chip auf allen Shop-Seiten (optionale Berechtigung) -------------------
 * Ohne <all_urls> bei der Installation (keine Warnung „alle Websites“). Erteilt der
 * Nutzer sie im Popup (ein Klick), registrieren wir content.js dauerhaft für alle Seiten
 * außer Amazon (dort läuft es fest über das Manifest). Entzieht er sie, entfällt das. */
const CHIP_SKRIPT = "axx-chip-alle-shops";
const PANEL_SKRIPT = "axx-panel-alle-shops";
const AMAZON_MUSTER = ["https://www.amazon.de/*", "https://www.amazon.fr/*", "https://www.amazon.it/*", "https://www.amazon.es/*"];

async function chipAbgleichen() {
  try {
    const hat = await chrome.permissions.contains({ origins: ["<all_urls>"] });
    const da = (await chrome.scripting.getRegisteredContentScripts({ ids: [CHIP_SKRIPT, PANEL_SKRIPT] })).map((x) => x.id);
    if (hat) {
      // Chip (EAN) und Rechner-Panel wie auf Amazon-Produktseiten (ab 1.9.3)
      const neu = [];
      if (!da.includes(CHIP_SKRIPT)) neu.push({ id: CHIP_SKRIPT, matches: ["<all_urls>"], excludeMatches: AMAZON_MUSTER,
        js: ["content.js"], css: ["chip.css"], runAt: "document_start", persistAcrossSessions: true });
      if (!da.includes(PANEL_SKRIPT)) neu.push({ id: PANEL_SKRIPT, matches: ["<all_urls>"], excludeMatches: AMAZON_MUSTER,
        js: ["rechner.js", "panel.js"], runAt: "document_idle", persistAcrossSessions: true });
      if (neu.length) await chrome.scripting.registerContentScripts(neu);
    } else if (da.length) {
      await chrome.scripting.unregisterContentScripts({ ids: da });
    }
  } catch (e) { /* ältere Chrome-Version: Chip nur per Klick */ }
}
chrome.runtime.onInstalled.addListener(chipAbgleichen);
chrome.runtime.onStartup.addListener(chipAbgleichen);
// Automat: Alarm alle 6 h; läuft nur, wenn der Nutzer ihn im Popup eingeschaltet hat (axxAutomatAn)
chrome.runtime.onInstalled.addListener(automatAlarm);
chrome.runtime.onStartup.addListener(automatAlarm);
if (chrome.alarms) chrome.alarms.onAlarm.addListener((a) => { if (a && a.name === AXA.ALARM) automatLauf("alarm"); });
chrome.permissions.onAdded.addListener(chipAbgleichen);
chrome.permissions.onRemoved.addListener(chipAbgleichen);

/* --- Bestand nachmessen (1.9.24, 14.11.2026) -------------------------------------------------
 * Sales anderer Verkäufer erkennt Arbitragex an sinkendem Bestand – dafür braucht jedes Listing
 * mehrere Messungen. Bisher entstand eine nur beim Besuch der Produktseite. Hat der Nutzer es in
 * Arbitragex eingeschaltet (Opt-in je Konto, Standard aus), holt dieser Takt Aufträge
 * {asin, mk} vom Server (nur eigene Lager-ASINs und zuletzt geöffnete Produkte, das Älteste
 * zuerst) und lässt einen offenen Amazon-Tab die Angebotsliste lesen und melden – derselbe Abruf
 * wie beim Seitenbesuch, mit der Amazon-Sitzung des Nutzers. Tempo, Tageslimit und Pausen gibt
 * der Server vor. Zeigt Amazon eine Prüfseite, meldet die Extension das und der Server pausiert
 * das Konto; nichts wird umgangen. Ohne offenen Amazon-Tab passiert nichts (gemeldet als kein_tab). */
const AXN = { ALARM: "axx-nachmessen", SPEICHER: "axxNm", laeuft: false };

function nmTabFragen(tabId, msg, ms) {
  return new Promise((res) => {
    let fertig = false;
    const ende = (x) => { if (!fertig) { fertig = true; clearTimeout(t); res(x || null); } };
    const t = setTimeout(() => ende(null), ms);
    try { chrome.tabs.sendMessage(tabId, msg, (x) => { void chrome.runtime.lastError; ende(x); }); }
    catch (e) { ende(null); }
  });
}

async function nmTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: AMAZON_MUSTER });
    return tabs.filter((t) => t.id != null && !t.discarded && t.status === "complete").slice(0, 4);
  } catch (e) { return []; }
}

async function nmTick() {
  if (AXN.laeuft) return;
  AXN.laeuft = true;
  try {
    const st = (await chrome.storage.local.get(AXN.SPEICHER))[AXN.SPEICHER] || {};
    if (st.warten_bis && Date.now() < st.warten_bis) return;
    const version = chrome.runtime.getManifest().version;
    let liste = Array.isArray(st.liste) && st.geholt && Date.now() - st.geholt < 45 * 60000 ? st.liste : [];
    let pause = Math.max(60, Number(st.pause_s) || 120);
    let an = st.an === true, geholt = st.geholt || 0, keinTabTs = st.kein_tab_ts || 0;
    const merken = (sek) => chrome.storage.local.set({ [AXN.SPEICHER]: {
      liste, pause_s: pause, an, geholt, kein_tab_ts: keinTabTs, warten_bis: Date.now() + Math.round(sek * 1000) } });

    // eingeschaltet, aber kein Amazon-Tab (oder keiner antwortet): höchstens einmal je Stunde melden, dann warten
    const keinTab = async () => {
      if (Date.now() - keinTabTs > 3600000) {
        keinTabTs = Date.now();
        const m = await axaApi("/api/ext/nachmessen/ergebnis", "POST", { art: "kein_tab", version }).catch(() => null);
        if (m && m.ok && m.data && m.data.an === false) { an = false; liste = []; }
      }
      await merken(300);
    };
    const tabs = await nmTabs();
    if (an && !tabs.length) { await keinTab(); return; }
    if (!liste.length) {
      const r = await axaApi("/api/ext/nachmessen/auftraege");
      const d = r.data || {};
      an = !!(r.ok && d.an);
      if (!an) { liste = []; await merken(r.ok ? (Number(d.naechste_s) || 3600) : 3600); return; }
      pause = Math.max(60, Number(d.pause_s) || 120);
      liste = (d.auftraege || []).filter((j) => j && /^[A-Z0-9]{10}$/.test(String(j.asin || "")) &&
                                                ["de", "fr", "it", "es"].includes(j.mk)).slice(0, 20);
      geholt = Date.now();
      if (!liste.length || !tabs.length) { await merken(liste.length ? 300 : (Number(d.naechste_s) || 900)); return; }
    }
    const job = liste[0];
    let x = null;
    for (const t of tabs) {
      x = await nmTabFragen(t.id, { type: "axx-nachmessen", asin: job.asin, mk: job.mk }, 25000);
      if (x && x.nachmessen) break;
      x = null;
    }
    if (!x) { await keinTab(); return; }             // Tabs offen, aber keiner antwortet (z. B. vor dem Update geladen)
    liste = liste.slice(1);
    const m = await axaApi("/api/ext/nachmessen/ergebnis", "POST", {
      art: "messung", asin: job.asin, mk: job.mk, ok: !!x.ok, angebote: x.angebote || 0, mit_menge: x.mit_menge || 0,
      zeilen: x.zeilen || 0, fehler: x.ok ? "" : String(x.fehler || "").slice(0, 200), status: x.status || 0, version });
    const md = (m && m.data) || {};
    if (m && m.ok && md.an === false) { an = false; liste = []; }
    if (md.pause) liste = [];                        // Amazon-Prüfseite: Server pausiert das Konto
    // Streuung nur nach oben: nie mehr als ein Abruf je Minute, auch nicht im festen Raster
    await merken(md.pause ? (Number(md.naechste_s) || 3600) : pause * (1 + Math.random() * 0.4));
  } catch (e) {
    try { await chrome.storage.local.set({ [AXN.SPEICHER]: { liste: [], warten_bis: Date.now() + 600000 } }); } catch (_) { /* leer */ }
  } finally { AXN.laeuft = false; }
}

async function nmAlarm(neu) {
  try {
    if (!chrome.alarms) return;
    // nach Installation, Update oder Chrome-Start sofort nachfragen (der Schalter kann inzwischen umgelegt sein)
    if (neu) await chrome.storage.local.remove(AXN.SPEICHER);
    const a = await chrome.alarms.get(AXN.ALARM);
    if (!a) await chrome.alarms.create(AXN.ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
  } catch (e) { /* ohne Alarm kein Nachmessen */ }
}
chrome.runtime.onInstalled.addListener(() => nmAlarm(true));
chrome.runtime.onStartup.addListener(() => nmAlarm(true));
if (chrome.alarms) chrome.alarms.onAlarm.addListener((a) => { if (a && a.name === AXN.ALARM) nmTick(); });


/* --- Rechtsklick-Menü (1.9.18) -------------------------------------------------
 * Rechtsklick auf markierten Text, einen Produktlink, ein Bild oder die Seite -> „Arbitragex: … prüfen“.
 * Das Profit-Panel klappt auf DER AKTUELLEN Seite auf (kein neuer Tab) und sucht das Amazon-Listing:
 * ASIN -> direkt, EAN/Titel -> Katalogsuche über das eigene Konto (mehrere Treffer -> Auswahl).
 * Der Klick gibt activeTab für genau diesen Tab frei; damit wird das Panel nachgeladen, wo es noch fehlt.
 * Gelesen wird nur die Markierung bzw. das angeklickte Element, sonst Kennung/Titel der Seite. */
const MENU_SUCHE = "axx-suche", MENU_SEITE = "axx-seite";

function axxKennung(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const asin = t.toUpperCase().match(/(?:^|[^A-Z0-9])(B0[A-Z0-9]{8})(?![A-Z0-9])/);
  if (asin) return { art: "asin", wert: asin[1] };
  if (/^[0-9][0-9 \-]{6,20}[0-9]$/.test(t)) {
    const z = t.replace(/[ \-]/g, "");
    if ([8, 12, 13, 14].includes(z.length)) return { art: "ean", wert: z };
  }
  if (t.length < 3) return null;
  return { art: "text", wert: t.slice(0, 200) };
}

function axxAsinAusUrl(url) {
  const m = String(url || "").match(/amazon\.[a-z.]+\/(?:.*\/)?(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?#]|$)/i);
  return m ? m[1].toUpperCase() : "";
}

// Läuft IN der Seite (executeScript): Rohdaten zum angeklickten Element und zum Produkt der Seite
function axxSeiteLesen(linkUrl, srcUrl) {
  const kurz = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 300);
  const out = { rkAsin: "", rkText: "", rkHref: "", linkText: "", bildText: "", ean: "", titel: "" };
  const rk = window.__axxRk && Date.now() - window.__axxRk.t < 15000 ? window.__axxRk : null;
  if (rk) { out.rkAsin = rk.asin || ""; out.rkText = rk.text || ""; out.rkHref = rk.href || ""; }
  if (linkUrl) {
    for (const a of document.querySelectorAll("a[href]")) {
      if (a.href !== linkUrl) continue;
      const img = a.querySelector("img[alt]");
      out.linkText = kurz(a.innerText || a.getAttribute("title") || a.getAttribute("aria-label") || (img && img.alt));
      if (out.linkText) break;
    }
  }
  if (srcUrl) {
    for (const i of document.images) { if (i.currentSrc === srcUrl || i.src === srcUrl) { out.bildText = kurz(i.alt || i.title); break; } }
  }
  try { const sx = window.__axxSeite; if (sx && sx.produkt()) out.ean = String(sx.ean() || ""); } catch (e) { }
  if (!out.ean) {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      const m = (s.textContent || "").match(/"gtin(?:13|14|12|8)?"\s*:\s*"?(\d{8,14})"?/);
      if (m) { out.ean = m[1]; break; }
    }
  }
  const og = document.querySelector('meta[property="og:title"]');
  const h1 = document.querySelector("h1");
  out.titel = kurz((h1 && h1.innerText) || (og && og.content) || document.title);
  return out;
}

// Reihenfolge: Markierung > ASIN im Link > angeklicktes Element (ASIN/EAN) > Link-/Bildtext > Produkt der Seite
function axxEntscheiden(info, tabUrl, s) {
  if (info.selectionText) return axxKennung(info.selectionText);
  s = s || {};
  const asinOk = (a) => /^[A-Z0-9]{10}$/.test(a || "");
  const eanOk = (e) => /^\d+$/.test(e || "") && [8, 12, 13, 14].includes(e.length);
  const a1 = axxAsinAusUrl(info.linkUrl) || axxAsinAusUrl(s.rkHref);
  if (a1) return { art: "asin", wert: a1 };
  if (asinOk(s.rkAsin)) return { art: "asin", wert: s.rkAsin };
  const rk = axxKennung(s.rkText);
  if (rk && rk.art !== "text" && s.rkText.length <= 40) return rk;         // ASIN/EAN direkt angeklickt
  if (info.linkUrl || info.srcUrl) {
    const t = axxKennung(s.linkText || s.bildText);
    if (t) return t;
  }
  const a2 = axxAsinAusUrl(tabUrl);
  if (a2) return { art: "asin", wert: a2 };
  if (eanOk(s.ean)) return { art: "ean", wert: s.ean };
  if (rk && s.rkText.length >= 12 && s.rkText.length <= 200 && !(info.linkUrl || info.srcUrl)) return rk;   // Titel angeklickt
  return axxKennung(s.titel);
}

async function axxKennungFinden(info, tab) {
  if (info.selectionText) return axxEntscheiden(info, tab.url, null);
  let s = null;
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: axxSeiteLesen,
      args: [info.linkUrl || "", info.srcUrl || ""] });
    s = r && r[0] && r[0].result;
  } catch (e) { /* Seite nicht lesbar (chrome://, PDF, Store) */ }
  return axxEntscheiden(info, tab.url, s);
}

async function axxPanelZeigen(tab, k) {
  const ziel = { tabId: tab.id };
  const nachricht = { type: "axx-menue", art: k.art, wert: k.wert };
  // 1.9.21: Zuerst das Panel direkt ansprechen. Ist es schon auf der Seite (Amazon, Shop-Seiten mit festem oder
  // freigegebenem Skript), braucht es keine Skript-Berechtigung – der Klick auf „AX“ in der Leiste gibt nämlich,
  // anders als das Rechtsklick-Menü, kein activeTab frei (gemessen 11.11.: executeScript scheiterte, Rückfall ins Web).
  try {
    const a = await chrome.tabs.sendMessage(tab.id, nachricht);
    if (a && a.panel) return;
  } catch (e) { /* kein Panel auf der Seite -> nachladen */ }
  await chrome.scripting.executeScript({ target: ziel, files: ["rechner.js", "panel.js"] });
  await chrome.tabs.sendMessage(tab.id, nachricht);
}

function menueAnlegen() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    const ok = () => void chrome.runtime.lastError;
    chrome.contextMenus.create({ id: MENU_SUCHE, title: "Arbitragex: „%s“ prüfen", contexts: ["selection"] }, ok);
    chrome.contextMenus.create({ id: MENU_SEITE, title: "Arbitragex: Produkt prüfen", contexts: ["link", "image", "page"] }, ok);
  });
}

async function menueKlick(info, tab) {
  if (!info || (info.menuItemId !== MENU_SUCHE && info.menuItemId !== MENU_SEITE) || !tab || tab.id == null) return;
  const k = await axxKennungFinden(info, tab);
  if (!k) return;
  try {
    await axxPanelZeigen(tab, k);
  } catch (e) {
    // Seite lässt keine Erweiterung zu (chrome://, PDF-Anzeige, Web Store): nur dann Amazon in neuem Tab
    const url = "https://www.amazon.de/" + (k.art === "asin" ? "dp/" + k.wert : "s?k=" + encodeURIComponent(k.wert));
    await chrome.tabs.create({ url, index: tab.index + 1, openerTabId: tab.id });
  }
}

chrome.runtime.onInstalled.addListener(menueAnlegen);
chrome.runtime.onStartup.addListener(menueAnlegen);
if (chrome.contextMenus) chrome.contextMenus.onClicked.addListener(menueKlick);
