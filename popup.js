/* Arbitragex Popup — Kalkulation und "Einkauf registrieren" (v1.8.0)
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

const state = { tabId: null, page: null, data: null, prices: {}, markup: 30 };

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
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(n);
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
  renderMsg("Nicht eingeloggt", "Einmal bei Arbitragex anmelden, danach hier erneut öffnen.",
    '<a class="axx-btn primary" href="' + BASE + '/login" target="_blank" rel="noopener">Zum Arbitragex-Login</a>');
}

/* --- Start ---------------------------------------------------------------- */
(async function init() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tabs && tabs[0] ? tabs[0].id : null;
  state.tabUrl = tabs && tabs[0] ? (tabs[0].url || "") : "";

  const info = await page("axx-page");
  state.page = info;

  // Keine Amazon-Produktseite: dann gibt es nichts zu kalkulieren. Statt eines
  // leeren Formulars zeigt das Popup, was hier trotzdem hilft — EAN kopieren,
  // Preisvergleich, Login-Status.
  if (!info || !info.amazon || !info.asin) return renderSeite(info);

  setSub(info.asin);
  body().innerHTML = loading("Lade Produktdaten…");

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

  const abbruch = new Promise((r) => setTimeout(
    () => r({ step: "error", error: "Zeitüberschreitung — Arbitragex antwortet nicht. Später erneut versuchen." }),
    20000));
  const res = await Promise.race([page("axx-analyze"), abbruch]);
  clearInterval(ticker);

  if (!res || res.step === "noasin") return renderSeite(info);
  if (res.step === "login") return renderLogin();
  if (res.step === "noaccount") return renderMsg("Kein Amazon-Konto verbunden",
    "Verbinde dein Konto in Arbitragex → Einstellungen.");
  if (res.step === "error") return renderMsg("Nicht gefunden", res.error);

  state.data = res.data;
  state.prices = {};
  MPS.forEach((k) => { state.prices[k] = res.data.suggested[k] != null ? res.data.suggested[k] : ""; });
  render();
})();

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
                          : "https://www.amazon.de/s?k=" + encodeURIComponent(q)) + '" target="_blank" rel="noopener">amazon</a>' +
      '<a href="https://www.google.com/search?q=' + encodeURIComponent(q) + '" target="_blank" rel="noopener">google</a>' +
      "</div>" +
      '<a class="axx-btn primary" href="' + BASE + "/?ean=" + encodeURIComponent(q) +
      '" target="_blank" rel="noopener">In Arbitragex suchen</a>';
  }

  const titel = q ? "Keine Amazon-Produktseite" : "Nichts erkannt";
  const text = q
    ? "Für die Kalkulation eine Amazon-Produktseite (/dp/…) öffnen. Von hier gibt es nur den Code und die Preisvergleiche."
    : "Öffne eine Amazon-Produktseite (/dp/…), dann rechnet die Extension hier.";
  renderMsg(titel, text, html);
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
  navigator.clipboard.writeText(txt).then(done, () => { });
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

  body().innerHTML =
    '<div class="axx-prod">' +
      (d.image ? '<img src="' + esc(d.image) + '" alt="">' : '<div class="axx-noimg">📦</div>') +
      '<div class="axx-pinfo"><div class="axx-title">' + esc(d.title || d.asin) + "</div>" +
      '<div class="axx-meta">' + (d.brand ? esc(d.brand) + " · " : "") + sold + "</div></div></div>" +

    '<div class="axx-markup"><span>Aufschlag</span>' +
      '<button class="axx-mk" data-mk="20">+20 %</button>' +
      '<button class="axx-mk" data-mk="30">+30 %</button>' +
      '<input id="axx-mkc" type="number" min="0" value="' + state.markup + '"><span>%</span></div>' +

    '<div class="axx-mps">' + cells + "</div>" +

    '<div class="axx-buygrid">' +
      '<label>EK € / Stück<input id="axx-b-cost" type="text" inputmode="decimal" placeholder="0,00"></label>' +
      '<label>Menge<input id="axx-b-qty" type="number" min="1" value="1"></label>' +
      '<label>VK €<input id="axx-b-sell" type="text" inputmode="decimal" value="' + vk + '"></label>' +
      '<label>Bestellnr.<input id="axx-b-order" type="text" placeholder="optional"></label>' +
      '<label class="axx-full">Gekauft bei<input id="axx-b-url" type="url" value="' + esc(url) + '"></label>' +
    "</div>" +

    '<div class="axx-margin" id="axx-b-margin">EK eintragen für Marge</div>' +

    '<button class="axx-btn primary" id="axx-save">Einkauf registrieren</button>' +
    '<div class="axx-note">Legt den Einkauf an, listet auf den Märkten mit Preis und meldet ihn ' +
      (prepOk ? "beim Prep-Center an." : "— Prep ist nicht verbunden.") + "</div>" +
    '<div class="axx-result" id="axx-result"></div>';

  wire();
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
  const sell = document.getElementById("axx-b-sell");
  const qty = document.getElementById("axx-b-qty");
  [cost, sell, qty].forEach((i) => i && i.addEventListener("input", updateMargin));
  updateMargin();

  document.getElementById("axx-save").addEventListener("click", save);
  // Enter im EK-Feld speichert direkt — spart den Griff zur Maus.
  if (cost) cost.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
  if (cost) cost.focus();
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

function updateMargin() {
  const c = num(document.getElementById("axx-b-cost").value);
  const s = num(document.getElementById("axx-b-sell").value);
  const q = parseInt(document.getElementById("axx-b-qty").value, 10) || 1;
  const box = document.getElementById("axx-b-margin");
  if (c == null || s == null || c <= 0 || s <= 0) {
    box.className = "axx-margin";
    box.textContent = "EK eintragen für Marge";
    return;
  }
  // Roh-Marge OHNE Amazon-Gebühren — die exakte Rechnung macht Arbitragex nach
  // dem Sync. Hier zählt nur die schnelle Ampel beim Einkauf.
  const diff = s - c, pct = (diff / s) * 100;
  box.className = "axx-margin " + (pct >= 25 ? "ok" : pct >= 12 ? "warn" : "bad");
  box.textContent = "Roh-Marge " + eur(diff) + " / Stk · " + pct.toFixed(1).replace(".", ",") +
    " % · gesamt " + eur(diff * q) + " (ohne Gebühren)";
}

async function save() {
  const btn = document.getElementById("axx-save");
  const res = document.getElementById("axx-result");
  const cost = num(document.getElementById("axx-b-cost").value);
  if (cost == null || cost <= 0) {
    res.innerHTML = '<div class="axx-err">Bitte den EK eintragen.</div>';
    document.getElementById("axx-b-cost").focus();
    return;
  }
  const url = (document.getElementById("axx-b-url").value || "").trim();
  const qty = parseInt(document.getElementById("axx-b-qty").value, 10) || 1;
  btn.disabled = true; btn.textContent = "Registriere…";
  res.innerHTML = "";

  // Anlegen. Das Backend stößt Listing + Prep im Hintergrund an (AUTO_LIST_PREP).
  const r = await api("/api/purchases", "POST", {
    asin: state.data.asin,
    title: state.data.title,
    image: state.data.image,
    source: shopName(url),
    source_url: url,
    cost: cost,
    quantity: qty,
    sell_price: num(document.getElementById("axx-b-sell").value),
    order_number: (document.getElementById("axx-b-order").value || "").trim(),
    markup: state.markup
  });

  if (!r.ok) {
    btn.disabled = false; btn.textContent = "Einkauf registrieren";
    res.innerHTML = '<div class="axx-err">' + esc((r.data && r.data.error) || ("HTTP " + r.status)) + "</div>";
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
  res.innerHTML = '<div class="axx-res ok">Einkauf registriert · ' + qty + " × " + eur(cost) +
    "<small>Listing läuft" + prepTxt + ". Status siehst du in Arbitragex → Einkäufe.</small></div>" +
    (listing && listing.listing ? renderListing(listing.listing) : "");
  document.getElementById("axx-b-cost").value = "";
  updateMargin();
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
