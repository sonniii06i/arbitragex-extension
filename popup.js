/* Arbitragex Popup — Kalkulation und "Einkauf registrieren" (v1.8.6)
 *
 * Bis v1.7 lief das alles in einem eingeblendeten Drawer auf der Amazon-Seite.
 * Der verdeckte die halbe Produktseite und ging nur ueber sein eigenes Kreuz
 * wieder zu. Jetzt sitzt es hier: ein Klick aufs Extension-Icon oben rechts,
 * ein Klick daneben schliesst wieder.
 *
 * Grundsaetze aus dem Panel bleiben:
 *  - Die Daten kommen aus dem Vorabladen im Content-Script — das laeuft schon
 *    seit dem Seitenaufruf, deshalb steht das Popup meist sofort.
 *  - Alles auf einen Blick: kein Ausklappen, EIN Button.
 *  - Preise sind ANZEIGE, keine Eingabe: Das Backend rechnet den Listing-Preis
 *    beim Anlegen aus Aufschlag + tagesaktueller Buy-Box neu. Deshalb steuert
 *    nur der Aufschlag, und das Ergebnis ist sichtbar.
 */
const BASE = "https://arbitragex.de";
const MPS = ["de", "fr", "it", "es"];
const FLAG = { de: "🇩🇪", fr: "🇫🇷", it: "🇮🇹", es: "🇪🇸" };

const state = { tabId: null, page: null, data: null, prices: {}, markup: 30, saving: false };

function api(path, method, body) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ path, method, body }, (r) => resolve(r || { ok: false, status: 0 }));
  });
}
/* Ans Content-Script der aktiven Seite. Faellt sauber auf null zurueck, wenn
   dort keins laeuft (chrome://, Web Store, frisch installiert ohne Reload). */
function page(type) {
  return new Promise((resolve) => {
    if (state.tabId == null) return resolve(null);
    try {
      chrome.tabs.sendMessage(state.tabId, { type }, (r) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(r || null);
      });
    } catch (e) { resolve(null); }
  });
}
function eur(n) {
  if (n == null || isNaN(n)) return "—";
  // Kurz wie im Panel: ab 1.000 € ohne Cent, sonst ohne „,00“
  const ganz = Math.abs(n) >= 1000 || Math.abs(n - Math.round(n)) < 0.005;
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR",
    minimumFractionDigits: ganz ? 0 : 2, maximumFractionDigits: ganz ? 0 : 2 }).format(n);
}
function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function num(v) {
  const n = parseFloat(String(v == null ? "" : v).replace(",", "."));
  return isNaN(n) ? null : n;
}
function shopName(url) {
  // Vollstaendige Domain inkl. Laenderendung: "amazon.de" statt "amazon" —
  // amazon.de und amazon.fr sind verschiedene Quellen.
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch (e) { return ""; }
}
function body() { return document.getElementById("axx-body"); }
function loading(t) { return '<div class="axx-load"><span class="axx-spin"></span>' + esc(t || "Lade…") + "</div>"; }
function setSub(t) { document.getElementById("axx-sub").textContent = t; }
function renderMsg(title, sub, extra) {
  body().innerHTML = '<div class="axx-msg"><b>' + esc(title) + "</b><p>" + esc(sub || "") + "</p>" +
    (extra || "") + "</div>";
}
function renderLogin() {
  renderMsg("Kostenlos anmelden", "Der Profit-Rechner ist kostenlos. E-Mail bestätigen, Amazon-Konto verbinden – danach rechnet er hier.",
    '<a class="axx-btn primary" href="' + BASE + '/amazon-profit-rechner#start" target="_blank" rel="noopener">Kostenlos registrieren</a>' +
    '<a class="axx-btn" style="margin-top:8px" href="' + BASE + '/login" target="_blank" rel="noopener">Ich habe ein Konto – anmelden</a>');
}

/* --- Start ---------------------------------------------------------------- */
(async function init() {
  // Modus : „einkauf“ = nur Einkäufe ankündigen, „profit“ = zusätzlich Profit-Rechner
  // (Popup + Panel auf der Produktseite). Einstellung unten im Popup.
  state.modus = "profit"; state.panel = true;
  try {
    const st = await chrome.storage.local.get(["axxModus", "axxPanel"]);
    if (st && st.axxModus) state.modus = st.axxModus;
    if (st && st.axxPanel === false) state.panel = false;
  } catch (e) { }
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tabs && tabs[0] ? tabs[0].id : null;
  state.tabUrl = tabs && tabs[0] ? (tabs[0].url || "") : "";

  let info = await page("axx-page");
  // Shop-Seite ohne dauerhaften Chip: content.js jetzt einbinden (activeTab nach dem Klick aufs Symbol)
  if (!info && state.tabId != null && /^https?:/.test(state.tabUrl)) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId: state.tabId }, files: ["chip.css"] });
      await chrome.scripting.executeScript({ target: { tabId: state.tabId }, files: ["content.js"] });
      await new Promise((r) => setTimeout(r, 150));
      info = await page("axx-page");
    } catch (e) { /* z. B. Chrome-Web-Store-Seiten: dort darf keine Erweiterung laufen */ }
  }
  state.page = info;

  // Keine Amazon-Produktseite: dann gibt es nichts zu kalkulieren. Statt eines
  // leeren Formulars zeigt das Popup, was hier trotzdem hilft — EAN kopieren,
  // Preisvergleich, Login-Status.
  if (!info || !info.amazon || !info.asin) return renderSeite(info);

  setSub(info.asin);
  body().innerHTML = loading("Lade Produktdaten…");
  // Profit-Rechner (SellerAmp-Ersatz) parallel zur Analyse anstoßen — eigener Endpunkt,
  // braucht ~1 s und blockiert die Kalkulation nicht.
  state.profitLaden = state.modus === "profit" ? api("/api/ext/profit?asin=" + encodeURIComponent(info.asin)) : null;
  state.meLaden = api("/api/ext/me");

  /* Der Abruf holt Buy-Box-Preise fuer vier Marktplaetze ueber die SP-API — das
     dauert serverseitig und laesst sich hier nicht beschleunigen. Statt eines
     stummen Spinners sagt das Popup, woran es haengt, und bricht nach 20 s mit
     einem klaren Hinweis ab, statt ewig zu drehen. */
  const startedAt = Date.now();
  const ticker = setInterval(() => {
    const box = body();
    if (!box || !box.querySelector(".axx-load")) return;
    const sek = Math.round((Date.now() - startedAt) / 1000);
    if (sek >= 4) box.innerHTML = loading("Buy-Box-Preise werden geholt… (" + sek + " s)");
    else if (sek >= 1) box.innerHTML = loading("Frage Amazon-Katalog ab…");
  }, 1000);

  const frist = () => new Promise((r) => setTimeout(
    () => r({ step: "error", error: "Zeitüberschreitung — Arbitragex antwortet nicht. Später erneut versuchen." }),
    20000));
  let res = await Promise.race([page("axx-analyze"), frist()]);
  clearInterval(ticker);   // sonst ueberschreibt der Ticker die Meldung unten

  /* Das Vorabladen laeuft beim SEITENAUFRUF. Wer sich erst danach einloggt oder
     sein Amazon-Konto verbindet, bekam bis dahin ewig das eingefrorene
     "nicht eingeloggt"/"kein Konto" zu sehen — bis er die Amazon-Seite neu lud.
     Darauf kommt niemand. Also einmal frisch nachfragen und, wenn es jetzt
     passt, das Vorabladen im Content-Script verwerfen und neu holen. */
  if (res && (res.step === "login" || res.step === "noaccount")) {
    const me = await api("/api/ext/me");
    if (me.ok && me.data && me.data.email && me.data.connected) {
      await page("axx-reload");
      const box = body();
      if (box) box.innerHTML = loading("Verbindung gefunden — lade Produktdaten…");
      res = await Promise.race([page("axx-analyze"), frist()]);
    }
  }

  if (!res || res.step === "noasin") return renderSeite(info);
  if (res.step === "login") return renderLogin();
  if (res.step === "noaccount") return renderMsg("Amazon-Konto verbinden",
    "Der Profit-Rechner rechnet mit den Gebühren deines eigenen Verkäuferkontos (Lesezugriff über Amazons Selling Partner API). Einmal verbinden, danach hier erneut öffnen.",
    '<a class="axx-btn primary" href="' + BASE + '/extension" target="_blank" rel="noopener">Amazon-Konto verbinden</a>');
  if (res.step === "error") return renderMsg("Nicht gefunden", res.error);

  state.data = res.data;
  state.prices = {};
  MPS.forEach((k) => { state.prices[k] = res.data.suggested[k] != null ? res.data.suggested[k] : ""; });
  await aboLaden();
  render();
})();

/* Abo-Status: ohne Abo ist der Profit-Rechner frei, Einkauf registrieren/Listing/Prep gesperrt. */
async function aboLaden() {
  const me = await (state.meLaden || api("/api/ext/me"));
  state.abo = me && me.ok && me.data ? me.data.abo !== false : null;
}

/* --- Ohne ASIN: was die Seite trotzdem hergibt ---------------------------- */
async function renderSeite(info) {
  const ean = info && info.ean ? info.ean : null;
  const asin = info && info.asin ? info.asin : null;
  const q = ean || asin || "";

  let html = "";
  if (ean || asin) {
    html += '<div class="axx-codes">' +
      (asin ? '<button class="axx-code" data-copy="' + esc(asin) + '"><b>ASIN</b>' + esc(asin) + "</button>" : "") +
      (ean ? '<button class="axx-code" data-copy="' + esc(ean) + '"><b>EAN</b>' + esc(ean) + "</button>" : "") +
      "</div>";
  }
  if (q) {
    html += '<div class="axx-links">' +
      '<a href="https://www.idealo.de/preisvergleich/MainSearchProductCategory.html?q=' + encodeURIComponent(q) + '" target="_blank" rel="noopener">idealo</a>' +
      '<a href="' + (asin ? "https://www.amazon.de/dp/" + encodeURIComponent(asin)
                          : "https://www.amazon.de/s?k=" + encodeURIComponent(q)) + '" target="_blank" rel="noopener">Amazon</a>' +
      '<a href="https://www.google.com/search?q=' + encodeURIComponent(q) + '" target="_blank" rel="noopener">Google</a>' +
      "</div>" +
      '<a class="axx-btn primary" href="' + BASE + "/?ean=" + encodeURIComponent(q) +
      '" target="_blank" rel="noopener">In Arbitragex suchen</a>';
  }

  // Shop-Seite mit EAN: Amazon-Listing über die Katalog-API finden -> volle Kalkulation 
  if (ean && state.modus !== "einkauf") html = '<div id="axx-eansuche">' + loading("Suche Amazon-Listing zur EAN…") + "</div>" + html;
  const titel = q ? "Keine Amazon-Produktseite" : "Nichts erkannt";
  const text = q
    ? "Für die Kalkulation eine Amazon-Produktseite (/dp/…) öffnen. Von hier gibt es nur den Code und die Preisvergleiche."
    : "Öffne eine Amazon-Produktseite (/dp/…), dann rechnet die Extension hier.";
  html += einstellungBlock();
  const shop = ean && state.modus !== "einkauf";
  renderMsg(shop ? "Shop-Seite" : titel,
    shop ? "Amazon-Listing zur EAN dieser Seite – zum Rechnen und Einkauf-Anlegen auswählen." : text, html);
  einstellungWire();
  if (ean && state.modus !== "einkauf") eanSuche(ean, info);
  document.querySelectorAll(".axx-code").forEach((b) =>
    b.addEventListener("click", () => copyText(b.getAttribute("data-copy"), b)));

  // Login-Status als Fußzeile — die häufigste stille Ursache, wenn nichts geht.
  const me = await api("/api/ext/me");
  const st = document.createElement("div");
  if (me.ok && me.data && me.data.email) {
    st.className = "axx-status";
    st.textContent = "✓ Eingeloggt: " + me.data.email +
      (me.data.connected ? "" : " · kein Amazon-Konto verbunden");
  } else {
    st.className = "axx-status bad";
    st.innerHTML = '✗ Nicht eingeloggt — <a href="' + BASE + '/login" target="_blank" rel="noopener">anmelden</a>';
  }
  body().appendChild(st);
}

function copyText(txt, node) {
  const prev = node.innerHTML;
  const done = () => {
    node.classList.add("copied");
    node.textContent = "kopiert ✓";
    setTimeout(() => { node.classList.remove("copied"); node.innerHTML = prev; }, 900);
  };
  const alt = () => {
    const ta = document.createElement("textarea");
    ta.value = txt; ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta); ta.select();
    try { if (document.execCommand("copy")) done(); } catch (e) { }
    ta.remove();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, alt);
  else alt();
}

/* --- Kalkulation ---------------------------------------------------------
   Reihenfolge nach Blickverlauf: Was ist das? Was bringt es? Was gebe ich ein? */
function render() {
  const d = state.data;
  const sells = d.sells || {};
  const sold = (sells.units || 0) > 0
    ? '<span class="axx-sold">✓ verkaufst du schon · ' + sells.units + " Stk</span>"
    : '<span class="axx-sold new">neu für dich</span>';

  const cells = MPS.map((k) => {
    const bb = d.buybox[k];
    return '<div class="axx-mp' + (bb == null ? " off" : "") + '">' +
      '<div class="axx-mplab">' + FLAG[k] + " " + k.toUpperCase() + '</div>' +
      '<div class="axx-mpbb">' + eur(bb) + '</div>' +
      '<div class="axx-mpout" data-mp="' + k + '">' +
      (state.prices[k] !== "" ? eur(state.prices[k]) : "—") + "</div></div>";
  }).join("");

  const prep = d.prep || {};
  const prepOk = prep.channel === "prepbusiness";
  const vk = d.buybox && d.buybox.de != null ? Number(d.buybox.de).toFixed(2).replace(".", ",") : "";
  const url = (state.page && state.page.url) || state.tabUrl || "";
  const eanKopf = (state.page && state.page.ean) || d.ean || "";

  document.body.classList.add("mit-produkt");
  body().innerHTML =
    // Das Ergebnis steht GANZ OBEN und bleibt beim Scrollen stehen. Vorher sass es
    // unter dem Knopf am Seitenende — nach dem Registrieren musste man erst scrollen,
    // um ueberhaupt zu sehen, ob es geklappt hat. Genau das darf nicht sein.
    '<div class="axx-result" id="axx-result"></div>' +

    '<div class="axx-prod">' +
      (d.image ? '<img src="' + esc(d.image) + '" alt="">' : '<div class="axx-noimg">📦</div>') +
      '<div class="axx-pinfo"><div class="axx-title">' + esc(d.title || d.asin) + "</div>" +
      '<div class="axx-codes">' + '<button class="axx-code" data-copy="' + esc(d.asin) + '">' + esc(d.asin) + "</button>" +
        (eanKopf ? '<button class="axx-code ean" data-copy="' + esc(eanKopf) + '">' + esc(eanKopf) + "</button>" : "") + "</div>" +
      '<div class="axx-meta">' + (d.brand ? esc(d.brand) + ", " : "") + sold + "</div></div>" +
      // Knöpfe wie im Panel oben rechts; die Kopfzeile des Popups entfällt bei Produktansicht (Platz)
      '<div class="axx-kbtn"><button id="axx-zahnrad2" type="button" title="Extension-Einstellungen">⚙</button>' +
      '<a href="' + BASE + '/" target="_blank" rel="noopener" title="Arbitragex öffnen">↗</a></div></div>' +
    // Quick-Links wie im Panel: Preisvergleich mit der EAN (ohne EAN mit der ASIN)
    '<nav class="axx-links">' +
      '<a href="https://www.idealo.de/preisvergleich/MainSearchProductCategory.html?q=' + encodeURIComponent(eanKopf || d.asin) + '" target="_blank" rel="noopener">idealo</a>' +
      '<a href="https://www.amazon.de/dp/' + encodeURIComponent(d.asin) + '" target="_blank" rel="noopener">Amazon</a>' +
      '<a href="https://www.google.com/search?q=' + encodeURIComponent(eanKopf || d.asin) + '" target="_blank" rel="noopener">Google</a></nav>' +
    // Kalkulation + Ergebnis (wie im Panel), direkt darunter der Einkauf — ohne Scrollen erreichbar (11.11.2026)
    (state.modus === "profit" ? '<div class="axx-profit" id="axx-profit">' + loading("Profit wird gerechnet…") + "</div>" : "") +

    '<div class="axx-buygrid' + (state.modus === "profit" ? " mit-profit" : "") + '">' +
      // EK und Menge stehen im Profit-Modus oben in der Kalkulation; die Felder hier bleiben (gleicher Wert) für das Speichern
      '<label class="axx-dup">EK € / Stück<input id="axx-b-cost" type="text" inputmode="decimal" placeholder="0,00"></label>' +
      '<label class="axx-dup">Menge<input id="axx-b-qty" type="number" min="1" value="1"></label>' +
      '<label>Bestellt bei<input id="axx-b-url" type="url" placeholder="Link zum Einkauf (Shop/Bestellung)" value="' + esc(url) + '"></label>' +
      '<label>Bestellnr.<input id="axx-b-order" type="text" placeholder="optional"></label>' +
      // SKU-Wahl: mehrere SKUs je ASIN (Neu FBA, Gebraucht, alte FBM). Vorauswahl
      // Neu + FBA; „Neue SKU anlegen" blendet den Zustand ein.
      '<label class="axx-sku">SKU<select id="axx-b-sku" disabled><option value="">lade SKUs…</option></select></label>' +
      '<label id="axx-b-condbox" style="display:none">Zustand der neuen SKU<select id="axx-b-cond"></select></label>' +
      '<label id="axx-b-chanbox" style="display:none">Versandart (Listing)<select id="axx-b-chan">' +
        '<option value="FBA">FBA (Amazon)</option><option value="FBM">FBM (Eigenversand)</option></select></label>' +
      '<div class="axx-full axx-skunote" id="axx-b-skunote"></div>' +
    "</div>" +

    '<button class="axx-btn primary" id="axx-save" title="Legt den Einkauf an, listet mit Preis' +
      (prepOk ? " und meldet bei Prep an" : " (Prep nicht verbunden)") + '">Einkauf registrieren</button>' +

    (state.modus === "profit" ? '<div class="axx-profit" id="axx-profit2"></div>' : "") +

    '<details class="axx-mehr"><summary>Listing-Preise und Aufschlag</summary>' +
    '<div class="axx-markup"><span>Aufschlag</span>' +
      '<button class="axx-mk" data-mk="20">+20 %</button>' +
      '<button class="axx-mk" data-mk="30">+30 %</button>' +
      '<input id="axx-mkc" type="number" min="0" value="' + state.markup + '"><span>%</span></div>' +
    '<div class="axx-mps">' + cells + "</div>" +
    '<div class="axx-buygrid"><label class="axx-full">Listing-Preis DE € (leer = Buy Box + Aufschlag)<input id="axx-b-sell" type="text" inputmode="decimal" value="" placeholder="auto = Buy Box + Aufschlag"></label></div>' +
    "</details>" +

    einstellungBlock();

  wire();
  try { einstellungWire(); } catch (e) { console.warn("Einstellungen:", e); }   // darf den Profit-Teil nie stoppen
  ekAusPanel();
  document.querySelectorAll(".axx-prod .axx-code").forEach((b) =>
    b.addEventListener("click", () => copyText(b.getAttribute("data-copy"), b)));
  profitStart();
  if (state.abo === false) einkaufSperren();
}

function wire() {
  document.querySelectorAll(".axx-mk").forEach((b) => b.addEventListener("click", () => {
    state.markup = parseFloat(b.getAttribute("data-mk"));
    const c = document.getElementById("axx-mkc"); if (c) c.value = state.markup;
    applyMarkup();
  }));
  const mkc = document.getElementById("axx-mkc");
  if (mkc) mkc.addEventListener("input", () => {
    const v = parseFloat(mkc.value);
    if (!isNaN(v) && v >= 0) { state.markup = v; applyMarkup(); }
  });

  const cost = document.getElementById("axx-b-cost");
  document.getElementById("axx-save").addEventListener("click", save);
  // Enter im EK-Feld speichert direkt — spart den Griff zur Maus.
  if (cost) cost.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
  if (cost && cost.offsetParent) cost.focus();      // im Profit-Modus steht das EK-Feld oben (axx-pf-ek)
  // Merken, damit Speichern darauf warten kann (Enter im EK-Feld kommt oft vor der Liste).
  // Ohne Abo keine SKU-Liste (Endpunkt ist Abo-Funktion) — der Bereich ist gesperrt.
  state.skuLaden = state.abo === false ? Promise.resolve() : loadSkus();
}

/* --- SKU-Wahl ------------------------------------------------------------- */
async function loadSkus() {
  const sel = document.getElementById("axx-b-sku");
  const cond = document.getElementById("axx-b-cond");
  const box = document.getElementById("axx-b-condbox");
  const chBox = document.getElementById("axx-b-chanbox");
  const chSel = document.getElementById("axx-b-chan");
  const note = document.getElementById("axx-b-skunote");
  if (!sel) return;
  let hinweis = "";
  const sync = () => {
    const neu = sel.value === "__neu__";
    box.style.display = neu ? "" : "none";
    if (chBox) chBox.style.display = neu ? "" : "none";
    if (neu && chSel && !chSel.dataset.manuell) chSel.value = state.kanal === "fbm" ? "FBM" : "FBA";
    const o = sel.selectedOptions[0];
    // FBM-SKU: der Nachkauf passt dort nur den Preis an, er stellt nicht auf FBA um.
    note.textContent = (o && o.getAttribute("data-chan") === "FBM")
      ? "⚠️ FBM-SKU: Es wird nur der Preis angepasst, die Versandart bleibt FBM. Für die Einlagerung bei Amazon eine FBA-SKU wählen oder eine neue anlegen."
      : hinweis;
  };
  if (chSel) chSel.addEventListener("change", () => { chSel.dataset.manuell = "1"; });
  sel.addEventListener("change", sync);
  const r = await api("/api/ext/skus?asin=" + encodeURIComponent(state.data.asin));
  const d = (r && r.ok && r.data) ? r.data : { skus: [], neu_zustaende: [],
    warnung: "SKU-Liste nicht abrufbar (" + ((r && r.data && r.data.error) || ("HTTP " + (r ? r.status : 0))) + ")" };
  const zust = (d.neu_zustaende && d.neu_zustaende.length) ? d.neu_zustaende : [{ value: "new_new", label: "Neu" }];
  cond.innerHTML = zust.map((z) => '<option value="' + esc(z.value) + '">' + esc(z.label) + "</option>").join("");
  // Zustand/Versandart einer SKU unbekannt -> nichts vorwählen, sonst entstünde
  // womöglich ein zweites Neu-Listing.
  const waehlen = !d.default && d.unklar && (d.skus || []).length;
  sel.innerHTML = (waehlen ? '<option value="__wahl__">— Bitte SKU wählen —</option>' : "") +
    (d.skus || []).map((x) => '<option value="' + esc(x.sku) + '" data-chan="' + esc(x.channel || "") + '">' +
      esc(x.sku + " · " + (x.zustand || "?") + " · " + (x.channel || "?") + " · " +
        (x.price != null ? eur(x.price) : "kein Preis") +
        (x.stock != null ? " · " + x.stock + " Stk" : "")) + "</option>").join("") +
    '<option value="__neu__">＋ Neue SKU anlegen …</option>';
  sel.value = d.default || (waehlen ? "__wahl__" : "__neu__");
  sel.disabled = false;
  state.skusLoaded = true;
  hinweis = d.warnung ? "⚠️ " + d.warnung
    : "";      // „noch keine SKU“ sagt schon die Auswahl „Neue SKU anlegen“ (spart eine Zeile)
  sync();
}

function skuWahl() {
  const sel = document.getElementById("axx-b-sku");
  if (!sel || !state.skusLoaded) return {};          // Liste noch nicht da -> Server-Standard
  if (sel.value === "__neu__") {
    const ch = (document.getElementById("axx-b-chan") && document.getElementById("axx-b-chan").value) || (state.kanal === "fbm" ? "FBM" : "FBA");
    return { new_sku: true, condition: document.getElementById("axx-b-cond").value || "new_new", list_channel: ch, announce: ch !== "FBM" };
  }
  return sel.value ? { sku: sel.value } : {};
}

function applyMarkup() {
  const bb = state.data.buybox;
  MPS.forEach((k) => {
    state.prices[k] = bb[k] != null ? Math.round(bb[k] * (1 + state.markup / 100) * 100) / 100 : "";
  });
  document.querySelectorAll(".axx-mpout").forEach((cell) => {
    const k = cell.getAttribute("data-mp");
    cell.textContent = state.prices[k] !== "" ? eur(state.prices[k]) : "—";
  });
}

// Sperre gegen Doppel-Registrierung: btn.disabled schuetzt nur den Klick, nicht
// das Enter im EK-Feld. Zwei Enter in Folge legten zwei Einkaeufe an -- jeder mit
// eigenem Listing und eigener Prep-Anmeldung. Der Server hat zusaetzlich ein
// 10-s-Idempotenzfenster (app._purchase_duplikat).
async function save() {
  if (state.abo === false) { window.open(BASE + "/billing?src=extension", "_blank", "noopener"); return; }
  if (state.saving) return;
  state.saving = true;
  try { await saveInner(); } finally { state.saving = false; }
}

async function saveInner() {
  const btn = document.getElementById("axx-save");
  const res = document.getElementById("axx-result");
  const cost = num(document.getElementById("axx-b-cost").value);
  if (cost == null || cost <= 0) {
    res.innerHTML = '<div class="axx-err">Bitte den EK eintragen.</div>';
    showResult();
    document.getElementById("axx-b-cost").focus();
    return;
  }
  const url = (document.getElementById("axx-b-url").value || "").trim();
  const qty = parseInt(document.getElementById("axx-b-qty").value, 10) || 1;
  btn.disabled = true; btn.textContent = "Registriere…";
  res.innerHTML = "";
  // Erst die SKU-Liste abwarten — sonst ginge {} raus und der Server legte A1-<ASIN>
  // an, obwohl es eine Neu-FBA-SKU gibt.
  if (state.skuLaden) await state.skuLaden;
  const skuSel = document.getElementById("axx-b-sku");
  if (skuSel && skuSel.value === "__wahl__") {
    btn.disabled = false; btn.textContent = "Einkauf registrieren";
    res.innerHTML = '<div class="axx-err">Bitte wähle aus, auf welche SKU der Einkauf gehen soll.</div>';
    showResult();
    skuSel.focus();
    return;
  }

  const manSell = num(document.getElementById("axx-b-sell").value);
  // Anlegen. Das Backend stößt Listing + Prep im Hintergrund an (AUTO_LIST_PREP).
  const r = await api("/api/purchases", "POST", {
    asin: state.data.asin,
    title: state.data.title,
    image: state.data.image,
    source: shopName(url),
    source_url: url,
    cost: cost,
    quantity: qty,
    sell_price: manSell,
    sell_price_manual: !!(manSell && manSell > 0),
    order_number: (document.getElementById("axx-b-order").value || "").trim(),
    ...skuWahl(),
    // Brutto/Netto so, wie der Profit-Rechner oben gerechnet hat — sonst zeigte das
    // Popup eine andere Marge als spaeter die COGS in Arbitragex.
    ...(state.profit ? { cost_gross: state.ekNetto ? 0 : 1 } : {}),
    markup: state.markup
  });

  if (!r.ok) {
    btn.disabled = false; btn.textContent = "Einkauf registrieren";
    res.innerHTML = '<div class="axx-err">' + esc((r.data && r.data.error) || ("HTTP " + r.status)) + "</div>";
    showResult();
    return;
  }

  // Steht der Auto-Flow aus, den Export für genau diesen Einkauf nachziehen —
  // sonst würde "registrieren" nur die Zeile anlegen und nichts auslösen.
  let listing = null;
  if (r.data && r.data.auto === false && r.data.id) {
    const ex = await api("/api/purchases/export", "POST", { ids: [r.data.id] });
    listing = ex.ok && ex.data && ex.data.results ? ex.data.results[0] : null;
  }

  btn.disabled = false; btn.textContent = "Einkauf registrieren";
  const prepTxt = (r.data && r.data.prep_connected) ? " · Prep angemeldet" : "";
  // Was wirklich passiert, haengt am Haken „Produkt bei Amazon anlegen" — nicht
  // behaupten, es werde gelistet, wenn der Nutzer das abgeschaltet hat.
  const listTxt = (r.data && r.data.listing_enabled === false)
    ? "Amazon-Listing ist in den Einstellungen aus"
    : "Listing läuft";
  res.innerHTML = '<div class="axx-res ok">Einkauf registriert · ' + qty + " × " + eur(cost) +
    (r.data && r.data.sku ? " · SKU " + esc(r.data.sku) : "") +
    "<small>" + listTxt + prepTxt + ". Status siehst du in Arbitragex → Einkäufe.</small></div>" +
    (listing && listing.listing ? renderListing(listing.listing) : "");
  document.getElementById("axx-b-cost").value = "";
  skuNachSave(r.data && r.data.sku);
  showResult();
}

/* Das Ergebnis muss ohne Scrollen sichtbar sein. Es steht oben im Popup und klebt
   dort fest; zusaetzlich springt der Inhalt nach oben, falls der Nutzer beim
   Ausfuellen weiter unten war. Sonst quittiert das Popup den Klick scheinbar gar
   nicht — man sieht die Bestaetigung erst nach dem Scrollen. */
function showResult() {
  const b = body();
  if (b) b.scrollTo({ top: 0, behavior: "smooth" });
}

function renderListing(rows) {
  return (rows || []).map((x) => {
    const st = String(x.status).toUpperCase();
    const cls = st === "ACCEPTED" ? "ok" : st === "FREISCHALTUNG" ? "warn" : "err";
    const txt = st === "ACCEPTED" ? "gelistet" : st === "FREISCHALTUNG" ? "Freischaltung nötig" : "Fehler";
    return '<div class="axx-res ' + cls + '">' + (FLAG[x.marketplace] || "") + " " +
      String(x.marketplace || "").toUpperCase() + " · " + txt + "</div>";
  }).join("");
}

/* Nach dem Registrieren steht die benutzte SKU in der Auswahl -- eine eben neu
   angelegte inklusive. Sonst legte der naechste Einkauf derselben Ware gleich
   noch eine SKU an. */
function skuNachSave(sku) {
  const sel = document.getElementById("axx-b-sku");
  if (!sel || !sku) return;
  if (![...sel.options].some((o) => o.value === sku)) {
    const o = document.createElement("option");
    o.value = sku; o.textContent = sku + " · eben angelegt";
    sel.insertBefore(o, sel.firstChild);
  }
  sel.value = sku;
  sel.dispatchEvent(new Event("change"));
}

/* --- Profit-Rechner (SellerAmp-Ersatz, 27.10.2026) ---------------------------
 * Daten: GET /api/ext/profit — je Markt Buy Box, aktuelle + fruehere Verkaeufer,
 * Freigabe, Gebuehrenmodell (Gebuehr netto = satz × VK + fix, × vf) lokal UND EFN.
 * Gerechnet wird hier, damit EK/VK/Ziel-ROI ohne Neuabfrage reagieren. Formel
 * identisch mit ext_profit.gewinn (Server-Test test_ext_profit_2710.py):
 *   gewinn = VK/(1+USt Zielland) − vf·(fix + satz·VK) − EK netto − Prep
 * EK netto wie beim Einkauf (config.ek_to_netto): brutto aus DE ÷ (1 + USt der ASIN), brutto aus dem
 * Ausland bleibt (keine deutsche Vorsteuer), netto unveraendert.
 */
const AMZ_TLD = { de: "amazon.de", fr: "amazon.fr", it: "amazon.it", es: "amazon.es" };

function einkaufsland() {
  return AxxRechner.einkaufsland((document.getElementById("axx-b-url") || {}).value || "");
}
function pct(n) { return n == null || !isFinite(n) ? "—" : n.toFixed(0) + " %"; }
function datum(ts) {
  try { return new Date(ts * 1000).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }); }
  catch (e) { return ""; }
}

async function profitStart() {
  const box = document.getElementById("axx-profit");
  if (!box || !state.profitLaden) return;
  const r = await state.profitLaden;
  if (!r || !r.ok || !r.data || r.data.error) {
    // Fehler sichtbar melden, nie als „kein Gewinn“ ausgeben
    box.innerHTML = '<div class="axx-err">Profit nicht verfügbar: ' +
      esc((r && r.data && r.data.error) || ("HTTP " + (r ? r.status : 0))) + "</div>";
    return;
  }
  const d = r.data;
  state.profit = d;
  state.ekNetto = !!d.ek_netto;
  state.ustModus = d.ust_modus || "oss";
  state.prep = d.prep || 0;
  state.ziel = 20;
  try {
    const p = await chrome.storage.local.get(["axxZielRoi"]);
    if (p && p.axxZielRoi != null) state.ziel = Number(p.axxZielRoi);
  } catch (e) { }
  state.tarif = {}; state.vk = {};
  MPS.forEach((mk) => {
    const m = d.maerkte[mk] || {};
    state.tarif[mk] = !!m.efn_vorwahl;
    state.vk[mk] = m.buybox != null ? m.buybox : null;
  });
  // Markt der Seite vorwählen, FBA/FBM je Produkt (wie im Panel), FBM-Versand gemerkt
  const host = (state.tabUrl || "").match(/amazon\.(de|fr|it|es)\//);
  state.mk = host ? host[1] : "de";
  state.seitenMk = state.mk;                      // Markt der geöffneten Seite: nur dort gilt das Abzeichen der Seite
  state.kanal = "fba";
  state.versandDe = d.fbm_versand_de != null ? Number(d.fbm_versand_de) : 4.99;
  state.versandEu = d.fbm_versand_eu != null ? Number(d.fbm_versand_eu) : 14.99;
  try {
    const st = await chrome.storage.local.get(["axxKanal:" + d.asin]);
    if (st["axxKanal:" + d.asin] === "fbm") state.kanal = "fbm";
  } catch (e) { }
  renderProfit();
  const ekFeld = document.getElementById("axx-pf-ek");
  if (ekFeld && !ekFeld.value) ekFeld.focus();
}

function renderProfit() {
  const d = state.profit;
  const box = document.getElementById("axx-profit");
  if (!d || !box) return;
  if (!state.mk || !(d.maerkte[state.mk] || {}).vorhanden) state.mk = MPS.find((k) => (d.maerkte[k] || {}).vorhanden) || "de";
  const kopf = [];
  if (d.bsr && d.bsr.rank) kopf.push('<span title="' + esc(d.bsr.kategorie || "") + '">BSR <b>#' + Number(d.bsr.rank).toLocaleString("de-DE") + "</b></span>");
  const gekauft = state.page && state.page.gekauft;
  if (gekauft) kopf.push('<span class="pp-ok">🔥 ' + esc(gekauft) + "</span>");
  const md = d.maerkte[state.mk] || {};
  if (md.vorhanden) kopf.push("<span>" + (md.fba_anzahl || 0) + " FBA · " + (md.fbm_anzahl || 0) + " FBM</span>");
  if (md.amazon_dabei) kopf.push('<b class="pp-warn">Amazon verkauft selbst</b>');
  const ekWert = esc((document.getElementById("axx-b-cost") || {}).value || "");
  const mengeWert = esc((document.getElementById("axx-b-qty") || {}).value || "1");
  const vkMk = state.vk[state.mk];

  const zeilen = MPS.map((mk) => {
    const m = d.maerkte[mk] || {};
    const lab = FLAG[mk] + " " + mk.toUpperCase();
    if (m.fehler) return '<tr class="aus"><td>' + lab + '</td><td colspan="5" class="pp-warn">Fehler: ' + esc(m.fehler) + "</td></tr>";
    if (!m.vorhanden) return '<tr class="aus"><td>' + lab + '</td><td colspan="5" class="pp-mut">nicht gelistet</td></tr>';
    const frei = m.frei === true ? '<span class="pp-ok" title="Du darfst verkaufen">✓</span>'
      : m.frei === false ? '<span class="pp-warn" title="Freischaltung nötig: ' + esc(m.frei_detail || "") + '">🔒</span>'
      : '<span class="pp-mut" title="Freigabe unbekannt">?</span>';
    const tarif = (m.modell_efn || state.tarif[mk]) && state.kanal !== "fbm"
      ? '<button class="pp-chip" data-tarif="' + mk + '" title="Tarif umschalten">' + (state.tarif[mk] ? "EFN" : "Pan-EU") + "</button>" : "";
    return '<tr data-mk="' + mk + '"' + (mk === state.mk ? ' class="an"' : "") + "><td>" + lab + "</td>" +
      '<td class="r">' + (state.vk[mk] != null ? eur(state.vk[mk]) : '<span class="pp-mut">kein Angebot</span>') + "</td>" +
      '<td class="r" id="pp-g-' + mk + '">—</td><td class="r" id="pp-r-' + mk + '">—</td>' +
      '<td class="r">' + frei + "</td><td>" + tarif + "</td></tr>";
  }).join("");

  const reiter = MPS.map((mk) => {
    const m = d.maerkte[mk] || {};
    return '<button class="pp-reiter' + (mk === state.mk ? " an" : "") + (m.vorhanden ? "" : " aus") + '" data-reiter="' + mk + '">' +
      FLAG[mk] + " " + mk.toUpperCase() + "</button>";
  }).join("");
  box.innerHTML =
    '<div class="pp-reiterzeile">' + reiter + "</div>" +
    // Freigabe, BSR, Angebote und Sales über den Eingaben — derselbe Baustein wie im Panel (rechner.js)
    AxxRechner.fakten(d, state.mk, state.mk === state.seitenMk ? (state.page && state.page.gekauft) : null, BASE) +
    '<div class="pp-box">' +
      '<div class="pp-g3">' +
        '<label>EK €<input id="axx-pf-ek" inputmode="decimal" placeholder="0,00" value="' + ekWert + '"></label>' +
        '<label><span class="lz">VK € ' + state.mk.toUpperCase() +
          '<span class="ustg">' + AxxRechner.ustKnoepfe(d, state.mk, state.kanal || "fba", state.tarif[state.mk], state.ustModus) + '</span></span><input id="pp-vk" inputmode="decimal" placeholder="VK eintragen" value="' +
          (vkMk != null ? String(vkMk.toFixed(2)).replace(".", ",") : "") + '"></label>' +
        '<label>Menge<input id="pp-menge" inputmode="numeric" value="' + mengeWert + '"></label>' +
      "</div>" +
      '<div class="pp-opt">' +
        '<span class="pp-seg"><button data-kanal="fba" class="' + (state.kanal !== "fbm" ? "an" : "") + '">FBA</button>' +
          '<button data-kanal="fbm" class="' + (state.kanal === "fbm" ? "an" : "") + '">FBM</button></span>' +
        (state.kanal === "fbm"
          ? '<label title="Netto-Versandkosten für ' + (state.mk === "de" ? "Deutschland" : "EU-Ausland") + ' (gilt für dieses Produkt; Standard unter ⚙ oder in Arbitragex)">Versand ' + (state.mk === "de" ? "DE" : "EU") + ' netto €<input id="pp-versand" inputmode="decimal" value="' + String(state.mk === "de" ? state.versandDe : state.versandEu).replace(".", ",") + '"></label>'
          : '<label>Prep €<input id="axx-pf-prep" inputmode="decimal" value="' + String(state.prep).replace(".", ",") + '"></label>') +
        '<label>Ziel-ROI<input id="axx-pf-ziel" inputmode="decimal" value="' + state.ziel + '"></label>' +
        '<label class="pp-cb"><input type="checkbox" id="axx-pf-netto"' + (state.ekNetto ? " checked" : "") + "> EK netto</label>" +

      "</div>" +
      '<div class="pp-hinweis" id="pp-hinweis"></div>' +
    "</div>" +
    '<div class="pp-tiles" id="pp-tiles"></div>';
  const box2 = document.getElementById("axx-profit2");
  if (box2) box2.innerHTML =
    '<table class="pp-tab"><thead><tr><th>Markt</th><th class="r">Buy Box</th><th class="r">Gewinn</th><th class="r">ROI</th><th class="r">Frei</th><th></th></tr></thead><tbody>' +
      zeilen + "</tbody></table>" +
    sellerBlock(d);

  const $ = (id) => document.getElementById(id);
  document.querySelectorAll("#axx-profit2 tr[data-mk]").forEach((tr) => tr.addEventListener("click", (e) => {
    if (e.target.closest("[data-tarif]")) return;
    state.mk = tr.getAttribute("data-mk"); renderProfit();
  }));
  box.querySelectorAll("[data-reiter]").forEach((b) => b.addEventListener("click", () => {
    const mk = b.getAttribute("data-reiter");
    if (!(d.maerkte[mk] || {}).vorhanden) return;
    state.mk = mk; renderProfit();
  }));
  document.querySelectorAll("#axx-profit2 [data-tarif]").forEach((b) => b.addEventListener("click", () => {
    const mk = b.getAttribute("data-tarif"); state.tarif[mk] = !state.tarif[mk]; renderProfit();
  }));
  box.querySelectorAll("[data-ust]").forEach((b) => b.addEventListener("click", () => {
    state.ustModus = b.getAttribute("data-ust");
    api("/api/ext/einstellungen", "POST", { ust_modus: state.ustModus });   // gilt im Konto: Dashboard + Repricer
    renderProfit();
  }));
  box.querySelectorAll("[data-ustsatz]").forEach((b) => b.addEventListener("click", async () => {   // USt-Satz dieser ASIN (1.9.16)
    const land = b.getAttribute("data-ustland"), ziel = state.profit;
    const r = await api("/api/ext/einstellungen", "POST", { ust_asin: { asin: ziel.asin, land, satz: +b.getAttribute("data-ustsatz") } });
    if (state.profit !== ziel || !(r && r.ok && r.data && r.data.ok)) return;
    AxxRechner.ustGewaehlt(ziel, land, r.data.satz, r.data.quelle);
    renderProfit();
  }));
  box.querySelectorAll("[data-kanal]").forEach((b) => b.addEventListener("click", () => {
    state.kanal = b.getAttribute("data-kanal");
    const chSel = document.getElementById("axx-b-chan");
    if (chSel && !chSel.dataset.manuell) chSel.value = state.kanal === "fbm" ? "FBM" : "FBA";
    try { chrome.storage.local.set({ ["axxKanal:" + state.data.asin]: state.kanal }); } catch (e) { }
    renderProfit();
  }));
  $("pp-vk").addEventListener("input", (e) => { state.vk[state.mk] = num(e.target.value); profitRechnen(); });
  $("pp-menge").addEventListener("input", (e) => {
    const q = $("axx-b-qty"); if (q) q.value = e.target.value; profitRechnen();
  });
  if ($("pp-versand")) {
    $("pp-versand").addEventListener("input", (e) => {
      const v = num(e.target.value), val = v == null ? 0 : v;
      if (state.mk === "de") state.versandDe = val; else state.versandEu = val;
      profitRechnen();
    });
  }
  $("axx-pf-netto").addEventListener("change", (e) => { state.ekNetto = e.target.checked; profitRechnen(); });
  if ($("axx-pf-prep")) {
    $("axx-pf-prep").addEventListener("input", (e) => { const v = num(e.target.value); state.prep = v == null ? 0 : v; profitRechnen(); });
    $("axx-pf-prep").addEventListener("change", () => {
      if (state.profit) state.profit.prep = state.prep;
      api("/api/ext/einstellungen", "POST", { prep: state.prep });
    });
  }
  $("axx-pf-ziel").addEventListener("input", (e) => {
    const v = num(e.target.value);
    if (v == null) return;
    state.ziel = v; profitRechnen();
    try { chrome.storage.local.set({ axxZielRoi: v }); } catch (err) { }
  });
  // Zwei EK-Felder (Profit oben, Einkauf unten) zeigen immer denselben Wert
  const pfEk = $("axx-pf-ek"), bEk = $("axx-b-cost");
  if (pfEk && bEk) {
    pfEk.addEventListener("input", () => { bEk.value = pfEk.value; profitRechnen(); });
    if (!bEk.dataset.pfsync) { bEk.dataset.pfsync = "1"; bEk.addEventListener("input", () => { const p = $("axx-pf-ek"); if (p) p.value = bEk.value; }); }
    pfEk.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
  }
  ["axx-b-cost", "axx-b-url"].forEach((id) => {
    const el = $(id);
    if (el && !el.dataset.pf) { el.dataset.pf = "1"; el.addEventListener("input", profitRechnen); }
  });
  ["axx-b-cost", "axx-b-url", "axx-b-qty", "axx-pf-ek", "pp-menge"].forEach((id) => {
    const el = $(id);
    if (el && !el.dataset.merk) { el.dataset.merk = "1"; el.addEventListener("change", ekMerken); el.addEventListener("input", () => { if (el.dataset.shoppreis) delete el.dataset.shoppreis; }); }
  });
  profitRechnen();
}

function profitRechnen() {
  const d = state.profit;
  if (!d) return;
  const ek = num((document.getElementById("axx-b-cost") || {}).value);
  const land = einkaufsland();
  const menge = Math.max(1, Math.floor(num((document.getElementById("pp-menge") || {}).value) || 1));
  const o = { kanal: state.kanal || "fba", ekNetto: state.ekNetto, land, ekUst: d.ek_ust || 19, prep: state.prep,
              ziel: state.ziel, menge, vorsteuer: d.gebuehren_vorsteuer !== false, ustModus: state.ustModus };
  let sel = null;
  MPS.forEach((mk) => {
    const m = d.maerkte[mk] || {};
    if (!m.vorhanden) return;
    const e = AxxRechner.rechne(m, state.tarif[mk], state.vk[mk], ek, Object.assign({}, o, { efn: state.tarif[mk], versand: mk === "de" ? state.versandDe : state.versandEu }));
    const g = document.getElementById("pp-g-" + mk), r = document.getElementById("pp-r-" + mk);
    if (g) g.innerHTML = e.ok && e.gewinn != null ? '<b class="' + (e.gewinn >= 0 ? "pp-pos" : "pp-neg") + '">' + eur(e.gewinn) + "</b>" : '<span class="pp-mut">—</span>';
    if (r) r.textContent = e.ok && e.roi != null ? pct(e.roi) : "—";
    if (mk === state.mk) sel = e;
  });
  const t = document.getElementById("pp-tiles");
  if (t) {
    if (!sel || !sel.ok) {
      t.innerHTML = '<div class="pp-leer">' + esc(sel ? sel.fehler : "Keine Daten") +
        (sel && /VK/.test(sel.fehler || "") ? " – oben bei „VK“ den Verkaufspreis für " + state.mk.toUpperCase() + " eintragen." : "") + "</div>";
    } else {
      const k = (titel, wert, cls, gross) => '<div class="pp-t' + (gross ? " gross" : "") + '"><i>' + titel + "</i><b" + (cls ? ' class="' + cls + '"' : "") + ">" + wert + "</b></div>";
      t.innerHTML =
        k("Gewinn / Stück", sel.gewinn != null ? eur(sel.gewinn) : "EK eintragen", sel.gewinn == null ? "pp-mut" : sel.gewinn >= 0 ? "pp-pos" : "pp-neg", true) +
        k("ROI · Nettomarge", sel.gewinn != null ? pct(sel.roi) + " · " + pct(sel.marge) : "—", "", true) +
        k("Max-EK (" + (state.ziel || 0) + " % ROI)", eur(sel.maxEk)) +
        k("Break-even VK", sel.breakEvenVk != null ? eur(sel.breakEvenVk) : "—") +
        (sel.menge > 1 && sel.gesamt != null ? '<div class="pp-t voll"><i>Gesamt ' + sel.menge + " Stück · Einsatz " + eur(sel.einsatz) +
          '</i><b class="' + (sel.gesamt >= 0 ? "pp-pos" : "pp-neg") + '">' + eur(sel.gesamt) + "</b></div>" : "");
    }
  }
  // Hinweise: Ausland-EK, unplausibler Shop-Preis (z. B. Ratenpreis oder andere Variante)
  const h = document.getElementById("pp-hinweis");
  if (h) {
    const teile = [];
    if (land !== "de" && !state.ekNetto) teile.push("Einkauf im Ausland (" + land.toUpperCase() + "): Brutto-EK ist Kostenbasis, keine deutsche Vorsteuer.");
    const bbDe = (d.maerkte.de || {}).buybox;
    if (sel && sel.ok && sel.fbaFehlt) teile.push("⚠ Amazon liefert für diesen Artikel keine FBA-Gebühr – sie fehlt in der Rechnung, der Gewinn ist zu hoch.");
    if (sel && sel.ok && sel.fbaTarif) teile.push("FBA-Gebühr nach Amazon-Tarifkarte aus den Packmaßen (Amazon nennt keinen Wert).");
    if (sel && sel.ok && !sel.exakt && d.exakt_abruf) teile.push("Gebühren für diesen VK werden bei Amazon abgefragt …");
    const aktV = state.mk === "de" ? state.versandDe : state.versandEu;
    if (state.kanal === "fbm" && aktV >= 30) teile.push("⚠ Versand " + eur(aktV) + " eingetragen – wirklich so hoch oder Komma vergessen?");
    if (ek && bbDe && ek < bbDe * 0.4) teile.push("⚠ EK " + eur(ek) + " liegt unter 40 % der Buy Box (" + eur(bbDe) + ") – bitte prüfen (Ratenpreis, andere Variante, Gebrauchtpreis?).");
    h.innerHTML = teile.map(esc).join("<br>");
  }
  // Echte Gebuehren beim eingetragenen VK nachholen (Preisstufen), kurz nach der letzten Eingabe
  clearTimeout(state.exaktT);
  state.exaktT = setTimeout(() => {
    if (state.profit && state.vk[state.mk] > 0) AxxRechner.exaktHolen(api, state.profit, state.mk, state.vk[state.mk], profitRechnen);
  }, 450);
}

function sellerBlock(d) {
  return MPS.map((mk) => {
    const m = d.maerkte[mk] || {};
    if (!m.vorhanden) return "";
    const tld = AMZ_TLD[mk];
    const zeile = (v, frueher) => {
      const link = v.seller_id ? '<a href="https://www.' + tld + "/sp?seller=" + encodeURIComponent(v.seller_id) +
        '" target="_blank" rel="noopener">' + esc(v.amazon ? "Amazon" : v.seller_id) + "</a>" : "?";
      return '<div class="axx-sl' + (v.ich ? " ich" : "") + '">' +
        (v.buybox ? "👑 " : "") + "<b>" + eur(v.preis) + "</b> · " + (v.fba ? "FBA" : "FBM") + " · " + link +
        (v.ich ? " · <b>du</b>" : "") +
        (frueher ? ' <span class="axx-pf-muted">zuletzt ' + datum(v.zuletzt) + "</span>"
          : (v.feedback != null ? ' <span class="axx-pf-muted">' + v.feedback + " Bew. · " + (v.positiv != null ? v.positiv + " %" : "") + "</span>" : "")) +
        "</div>";
    };
    const akt = (m.verkaeufer || []).map((v) => zeile(v, false)).join("") || '<div class="axx-pf-muted">keine Angebote</div>';
    const fr = (m.frueher || []);
    return '<details class="axx-sellers"><summary>' + FLAG[mk] + " " + mk.toUpperCase() + " · " +
      (m.fba_anzahl || 0) + " FBA · " + (m.fbm_anzahl || 0) + " FBM" + (m.amazon_dabei ? " · Amazon dabei" : "") +
      (fr.length ? " · " + fr.length + " früher" : "") + "</summary>" + akt +
      (fr.length ? '<div class="axx-sl-sub">Früher gesehen (eigene Beobachtung, 180 Tage)</div>' + fr.map((v) => zeile(v, true)).join("") : "") +
      "</details>";
  }).join("");
}


/* --- Einstellungen der Extension  ------------------------------------ */
function einstellungBlock() {
  return '<details class="axx-einst" id="axx-einst"><summary>Extension-Einstellungen</summary>' +
    '<label class="axx-einst-r"><input type="checkbox" id="axx-einst-chip"> Auf Shop-Seiten: EAN-Chip + Rechner wie auf Amazon</label>' +
    '<div class="axx-pf-muted" style="margin:-2px 0 6px 22px">Chrome fragt dafür einmal nach Zugriff auf alle Websites. Ohne den Haken funktioniert die Erweiterung auf Shop-Seiten per Klick aufs Symbol.</div>' +
    '<label class="axx-einst-r"><input type="radio" name="axx-modus" value="einkauf"' + (state.modus === "einkauf" ? " checked" : "") +
      "> Nur Einkäufe ankündigen (Einkauf, Listing, Prep)</label>" +
    '<label class="axx-einst-r"><input type="radio" name="axx-modus" value="profit"' + (state.modus !== "einkauf" ? " checked" : "") +
      "> Zusätzlich Profit-Rechner</label>" +
    '<label class="axx-einst-r sub"><input type="checkbox" id="axx-einst-panel"' + (state.panel ? " checked" : "") +
      (state.modus === "einkauf" ? " disabled" : "") + "> Panel direkt auf der Amazon-Produktseite (wie SellerAmp)</label>" +
    '<label class="axx-einst-r">Prep-/Inbound-Kosten je Stück €<input id="axx-einst-prep" inputmode="decimal" style="width:60px" value="' +
      (state.profit ? String(state.profit.prep).replace(".", ",") : "") + '" placeholder="aus Arbitragex"></label>' +
    '<label class="axx-einst-r">FBM-Versand DE netto €<input id="axx-einst-fbm-de" inputmode="decimal" style="width:60px" value="' +
      (state.profit && state.profit.fbm_versand_de != null ? String(state.profit.fbm_versand_de).replace(".", ",") : "4,99") + '" placeholder="4,99"></label>' +
    '<label class="axx-einst-r">FBM-Versand EU netto €<input id="axx-einst-fbm-eu" inputmode="decimal" style="width:60px" value="' +
      (state.profit && state.profit.fbm_versand_eu != null ? String(state.profit.fbm_versand_eu).replace(".", ",") : "14,99") + '" placeholder="14,99"></label>' +
    '<div class="axx-pf-muted">Prep und Standard-FBM-Versand (DE/EU) werden im Arbitragex-Konto gespeichert. EFN/Pan-EU und CEP stellst du in Arbitragex → Einstellungen ein.</div>' +
    automatBlock() +
    "</details>";
}

/* --- Automat: Freischaltungen beantragen + Auszahlungen anfordern mit der eigenen Seller-Central-Sitzung.
   Eingeschaltet wird NUR im ArbitrageX-Konto (Reiter Freischaltung bzw. Dashboard → Auszahlungen; Betreiber 11.11.2026).
   Hier: Stand, einmalig „Zugriff auf Seller Central erlauben“ (Chrome-Berechtigung braucht einen Klick) und
   „Jetzt ausführen“. Läuft sonst alle 2 h im Service-Worker (automat.js). Passwörter tippt die Extension nie. */
function automatBlock() {
  return '<div class="axx-auto" id="axx-auto" style="margin-top:8px;padding-top:6px;border-top:1px solid rgba(128,128,128,.25)">' +
    '<div style="font-weight:600;margin-bottom:2px">Automat: Freischaltungen &amp; Auszahlungen</div>' +
    '<div class="axx-pf-muted" id="axx-auto-stand">Stand wird geladen…</div>' +
    '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">' +
    '<button class="axx-btn primary" type="button" id="axx-auto-recht" style="display:none">Zugriff auf Seller Central erlauben</button>' +
    '<button class="axx-btn" type="button" id="axx-auto-jetzt">Jetzt ausführen</button>' +
    '<a class="axx-btn" href="' + BASE + '/" target="_blank" rel="noopener">In Arbitragex einstellen</a>' +
    "</div></div>";
}

function automatStandText(srv, lokal) {
  const teile = [];
  if (srv) {
    teile.push("Freischaltungen " + (srv.freischaltung ? "an" : "aus") + " · Auszahlungen " + (srv.auszahlung ? "an (" + (srv.takt_text || "täglich") + ")" : "aus") +
      (srv.freischaltung || srv.auszahlung ? "" : " – im Arbitragex-Konto einschalten (Reiter Freischaltung bzw. Dashboard → Auszahlungen)."));
  }
  if (srv && srv.letzter_lauf && srv.letzter_lauf.ts) {
    const l = srv.letzter_lauf;
    teile.push("Letzter Lauf " + new Date(l.ts * 1000).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" }) +
      (l.trocken ? " (Trockenlauf)" : "") + ": " + l.freischaltung + " Antrag/Anträge, " + l.auszahlung + " Auszahlungsmarkt/-märkte" +
      (l.fehler && l.fehler.length ? " · " + l.fehler.slice(0, 3).join(" · ") : ""));
  } else if (lokal && lokal.text) {
    teile.push(lokal.text + (lokal.fehler && lokal.fehler.length ? " · " + lokal.fehler.slice(0, 3).join(" · ") : ""));
  } else if (srv && (srv.freischaltung || srv.auszahlung)) {
    teile.push("Noch kein Lauf. Der erste Lauf ist ein Trockenlauf (nichts wird abgeschickt), danach läuft es alle 2 Stunden, solange du in Seller Central angemeldet bist.");
  }
  return teile.join(" ");
}

async function automatWire() {
  const stand = document.getElementById("axx-auto-stand"), jetzt = document.getElementById("axx-auto-jetzt");
  const recht = document.getElementById("axx-auto-recht");
  if (!stand || !jetzt || !recht) return;
  let srv = null;
  const r = await api("/api/ext/automat");
  if (r.status === 402) { stand.textContent = "Der Automat ist Teil des Abos."; jetzt.disabled = true; return; }
  if (r.status === 401) { stand.textContent = "Bei Arbitragex anmelden – eingeschaltet wird der Automat im Arbitragex-Konto."; jetzt.disabled = true; return; }
  if (r.ok && r.data) srv = r.data;
  let lokal = null;
  try { lokal = (await chrome.storage.local.get("axxAutomat")).axxAutomat || null; } catch (e) { }
  stand.textContent = automatStandText(srv, lokal);
  const an = !!(srv && (srv.freischaltung || srv.auszahlung));
  let hat = false;
  try { hat = await chrome.permissions.contains({ origins: ["https://sellercentral.amazon.de/*"] }) || await chrome.permissions.contains({ origins: ["<all_urls>"] }); } catch (e) { }
  if (an && !hat) { recht.style.display = ""; stand.textContent += " Zuerst den Zugriff auf sellercentral.amazon.de erlauben."; }
  recht.addEventListener("click", async () => {
    try {
      const ok = await chrome.permissions.request({ origins: ["https://sellercentral.amazon.de/*"] });
      if (ok) { recht.style.display = "none"; stand.textContent = automatStandText(srv, lokal) + " Zugriff erteilt – der Automat läuft alle 2 Stunden."; chrome.runtime.sendMessage({ type: "axx-automat-alarm" }, () => void chrome.runtime.lastError); }
    } catch (e) { stand.textContent = "Berechtigung nicht erteilt: " + String(e && e.message || e); }
  });
  jetzt.addEventListener("click", () => {
    jetzt.disabled = true; stand.textContent = "Läuft… (bitte Popup offen lassen)";
    chrome.runtime.sendMessage({ type: "axx-automat-jetzt" }, (res) => {
      jetzt.disabled = false;
      if (chrome.runtime.lastError || !res) { stand.textContent = "Keine Antwort vom Hintergrunddienst – Extension neu laden."; return; }
      stand.textContent = res.ok && res.stand ? (res.stand.text || "fertig") + (res.stand.fehler && res.stand.fehler.length ? " · " + res.stand.fehler.slice(0, 4).join(" · ") : "") : "Fehler: " + (res.error || "?");
    });
  });
}

function einstellungWire() {
  // Knopf im Kopf (Popup-Kopfzeile bzw. Produktkopf): Einstellungen aufklappen und hinspringen
  ["axx-zahnrad", "axx-zahnrad2"].forEach((id) => {
    const zr = document.getElementById(id);
    if (zr) zr.onclick = () => {
      const det = document.getElementById("axx-einst");
      if (det) { det.open = true; det.scrollIntoView({ block: "start", behavior: "smooth" }); }
    };
  });
  automatWire().catch((e) => console.warn("Automat:", e));     // Automat (parallele Sitzung extauto1011, 1.9.13)
  const chip = document.getElementById("axx-einst-chip");
  if (chip && chrome.permissions) {
    chrome.permissions.contains({ origins: ["<all_urls>"] }).then((ja) => { chip.checked = !!ja; });
    chip.addEventListener("change", async () => {
      try {
        if (chip.checked) chip.checked = await chrome.permissions.request({ origins: ["<all_urls>"] });
        else await chrome.permissions.remove({ origins: ["<all_urls>"] });
      } catch (e) { chip.checked = false; }
    });
  }
  document.querySelectorAll('input[name="axx-modus"]').forEach((r) => r.addEventListener("change", async () => {
    state.modus = r.value;
    try { await chrome.storage.local.set({ axxModus: r.value }); } catch (e) { }
    const p = document.getElementById("axx-einst-panel");
    if (p) p.disabled = r.value === "einkauf";
  }));
  const pr = document.getElementById("axx-einst-prep");
  if (pr) pr.addEventListener("change", async () => {
    const v = num(pr.value);
    if (v == null || v < 0) return;
    const r = await api("/api/ext/einstellungen", "POST", { prep: v });
    pr.style.outline = r && r.ok ? "2px solid #46d39a" : "2px solid #ff8073";
    if (r && r.ok) { state.prep = v; if (state.profit) state.profit.prep = v; profitRechnen(); }
  });
  [["axx-einst-fbm-de", "fbm_versand_de", "de"], ["axx-einst-fbm-eu", "fbm_versand_eu", "eu"]].forEach(([id, key, zone]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", async () => {
      const v = num(el.value);
      if (v == null || v < 0 || v > 500) return;
      const r = await api("/api/ext/einstellungen", "POST", { [key]: v });
      el.style.outline = r && r.ok ? "2px solid #46d39a" : "2px solid #ff8073";
      if (r && r.ok) {
        if (zone === "de") state.versandDe = v; else state.versandEu = v;
        if (state.profit) state.profit[key] = v;
        const vf = document.getElementById("pp-versand");
        if (vf && ((zone === "de" && state.mk === "de") || (zone === "eu" && state.mk !== "de"))) vf.value = String(v).replace(".", ",");
        profitRechnen();
      }
    });
  });
  const p = document.getElementById("axx-einst-panel");
  if (p) p.addEventListener("change", async () => {
    state.panel = p.checked;
    try { await chrome.storage.local.set({ axxPanel: p.checked }); } catch (e) { }
  });
}

/* EK, den man im Panel oder Popup eingetippt hat, bleibt je ASIN 30 Tage stehen (Betreiber 27.10.:
   „nicht immer wieder raus-tappen“). Panel und Popup teilen sich axxEk:<asin>. */
const EK_MERKEN_MS = 30 * 24 * 3600 * 1000;
function ekMerken() {
  try {
    const asin = state.data && state.data.asin;
    if (!asin) return;
    const ek = num((document.getElementById("axx-b-cost") || {}).value);
    if (ek == null) return;
    chrome.storage.local.set({ ["axxEk:" + asin]: { ek, ts: Date.now(),
      menge: parseInt((document.getElementById("axx-b-qty") || {}).value, 10) || 1,
      url: ((document.getElementById("axx-b-url") || {}).value || "").trim() } });
  } catch (e) { }
}

async function ekAusPanel() {
  try {
    const k = "axxEk:" + state.data.asin;
    const st = await chrome.storage.local.get([k]);
    const v = st && st[k];
    if (!v || Date.now() - v.ts > EK_MERKEN_MS) return;
    const f = document.getElementById("axx-b-cost");
    if (f && (!f.value || f.dataset.shoppreis) && v.ek != null) {      // gemerkter EK schlägt den Shop-Preis
      f.value = String(v.ek).replace(".", ",");
      f.dispatchEvent(new Event("input"));
    }
    const u = document.getElementById("axx-b-url");
    if (u && v.url) { u.value = v.url; u.dispatchEvent(new Event("input")); }
    const q = document.getElementById("axx-b-qty");
    if (q && v.menge > 1) q.value = v.menge;
  } catch (e) { }
}


/* --- Shop-Seite -> Amazon-Listing per EAN  ------------------------------
 * Katalogsuche (GET /api/ext/ean-suche). Mehrere Treffer werden nicht geraten: der Nutzer
 * waehlt. Danach dieselbe Kalkulation wie auf Amazon (analyze + Profit), EK = Shop-Preis
 * der Seite (JSON-LD/Meta), „Gekauft bei“ = diese Shop-Seite. */
async function eanSuche(ean, info) {
  const box = document.getElementById("axx-eansuche");
  const r = await api("/api/ext/ean-suche?ean=" + encodeURIComponent(ean));
  if (!box) return;
  if (!r.ok || !r.data || r.data.error) {
    box.innerHTML = '<div class="axx-err">EAN-Suche fehlgeschlagen: ' + esc((r.data && r.data.error) || ("HTTP " + r.status)) + "</div>";
    return;
  }
  const t = r.data.treffer || [];
  if (!t.length) { box.innerHTML = '<div class="axx-err">Kein Amazon-Listing zu EAN ' + esc(ean) + " gefunden.</div>"; return; }
  box.innerHTML = '<div class="axx-treffer">' + t.map((x, i) =>
    '<button class="axx-tr" data-i="' + i + '">' + (x.bild ? '<img src="' + esc(x.bild) + '" alt="">' : '<span class="axx-noimg">📦</span>') +
    "<span><b>" + esc(x.titel || x.asin) + "</b><small>" + esc(x.asin) + (x.marke ? " · " + esc(x.marke) : "") +
    (x.bsr ? " · BSR #" + Number(x.bsr).toLocaleString("de-DE") : "") + "</small></span></button>").join("") + "</div>";
  box.querySelectorAll(".axx-tr").forEach((b) => b.addEventListener("click", () => asinWaehlen(t[+b.getAttribute("data-i")].asin, info)));
  if (t.length === 1) asinWaehlen(t[0].asin, info);          // eindeutig -> direkt rechnen
}

async function asinWaehlen(asin, info) {
  setSub(asin);
  body().innerHTML = loading("Lade Amazon-Daten zu " + asin + "…");
  state.profitLaden = state.modus === "profit" ? api("/api/ext/profit?asin=" + encodeURIComponent(asin)) : null;
  const r = await api("/api/ext/analyze?asin=" + encodeURIComponent(asin) + "&markup=" + state.markup);
  if (!r.ok || !r.data || r.data.error && !r.data.asin) {
    return renderMsg("Nicht gefunden", (r.data && r.data.error) || ("HTTP " + r.status));
  }
  state.data = r.data;
  state.page = Object.assign({}, info || {}, { asin, amazon: false });
  state.prices = {};
  MPS.forEach((k) => { state.prices[k] = r.data.suggested[k] != null ? r.data.suggested[k] : ""; });
  await aboLaden();
  render();
  // Shop-Preis als EK vorbelegen, Shop-Seite als „Gekauft bei“
  const f = document.getElementById("axx-b-cost");
  if (f && info && info.preis && !f.value) {
    f.value = String(info.preis).replace(".", ",");
    f.dispatchEvent(new Event("input"));
    f.dataset.shoppreis = "1";                     // nur Vorschlag – ein gemerkter EK ersetzt ihn
  }
}


/* --- Ohne Abo: Einkaufsbereich geblurrt, Klick fuehrt zur Abo-Seite ------------- */
function einkaufSperren() {
  const teile = [".axx-markup", ".axx-mps", ".axx-buygrid", "#axx-save", ".axx-note"]
    .map((s) => document.querySelector(s)).filter(Boolean);
  if (!teile.length) return;
  const huelle = document.createElement("div");
  huelle.className = "axx-gesperrt";
  teile[0].parentNode.insertBefore(huelle, teile[0]);
  const inhalt = document.createElement("div");
  inhalt.className = "axx-gesperrt-inhalt";
  inhalt.setAttribute("aria-hidden", "true");
  teile.forEach((t) => inhalt.appendChild(t));
  inhalt.querySelectorAll("input,select,button").forEach((e) => { e.disabled = true; e.tabIndex = -1; });
  huelle.appendChild(inhalt);
  const ov = document.createElement("a");
  ov.className = "axx-gesperrt-ov";
  ov.href = BASE + "/billing?src=extension";
  ov.target = "_blank"; ov.rel = "noopener";
  ov.innerHTML = '<span class="axx-schloss">🔒</span><b>Einkauf registrieren</b>' +
    "<small>Einkauf erfassen, Amazon-Listing anlegen und Prep-Center ankündigen – mit dem Arbitragex-Abo.</small>" +
    '<span class="axx-btn primary">Abo ansehen</span>';
  huelle.appendChild(ov);
}
