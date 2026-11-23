/* Arbitragex Profit-Panel auf der Amazon-Produktseite (27.10.2026, SellerAmp-Ersatz)
 *
 * Sitzt wie SellerAmp rechts auf der PDP, verschiebbar; minimiert wird es zur AX-Leiste
 * (ASIN · EAN · idealo · amazon · google · Gewinn) und ersetzt dann den Chip aus content.js.
 * Nur im Modus „Zusaetzlich Profit-Rechner“ mit Haken „Panel auf der Produktseite“ (Popup → ⚙).
 *
 * Daten: GET /api/ext/profit (Gebuehren, Angebote, Verlauf, Sales) ueber den Background-Proxy.
 * Dazu liest das Panel die Angebotsliste (AOD) des jeweiligen Amazon-Markts: Verkaeufernamen
 * und die angebotene Menge je Verkaeufer (Mengenauswahl = Stock-Anhaltspunkt, bei 29 gedeckelt)
 * und meldet sie mit dem Sales-Badge an POST /api/ext/beobachtung — daraus wachsen Chart und
 * Sales-Schaetzung (wie Keepa aus Besuchen). Rechnung: rechner.js (gleiche Formel wie Popup/Server).
 */
(function () {
  if (window.top !== window) return;               // nicht in iframes
  if (window.__axxPanelGeladen) return;            // 1.9.18: das Rechtsklick-Menü lädt das Panel bei Bedarf nach – nie doppelt
  window.__axxPanelGeladen = true;
  const MPS = ["de", "fr", "it", "es"];
  const FLAG = { de: "🇩🇪", fr: "🇫🇷", it: "🇮🇹", es: "🇪🇸" };
  const MID = { de: "A1PA6795UKMFR9", fr: "A13V1IB3VIYZZH", it: "APJ6JRA9NG5V4", es: "A1RKKUPIHCS9HS" };
  const KEEPA_NR = { de: 3, fr: 4, it: 8, es: 9 };
  const BASE = "https://arbitragex.de";
  const CHIP_ID = "axx-launch";
  const SHOP_AUTOMATIK = false;                     // Panel auf Shop-Seiten nur noch über das Popup                    // Chip aus content.js, solange das Panel da ist ausgeblendet
  const S = { asin: null, d: null, mk: null, vk: {}, tarif: {}, ekNetto: false, prep: 0, ziel: 20,
              menge: 1, kanal: "fba", versand: 4.99, zu: false, pos: null, host: null, root: null,
              fehler: null, aod: {}, aodLaeuft: {}, frisch: {}, bereich: 90, chartAus: {}, chartGross: false,
              kurz: null, modus: "profit", einstAuf: false,
              kauf: { d: null, sku: null, cond: null, chan: null, nr: "", laedt: false, sendet: false }, kaufMeldung: "" };

  // Kurz: ab 1.000 € ohne Cent, sonst ohne „,00“ (Betreiber 27.10.: „kein ,00“)
  const eur = (n) => {
    if (n == null || !isFinite(n)) return "—";
    const ganz = Math.abs(n) >= 1000 || Math.abs(n - Math.round(n)) < 0.005;
    return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR",
      minimumFractionDigits: ganz ? 0 : 2, maximumFractionDigits: ganz ? 0 : 2 }).format(n);
  };
  const eurGenau = (n) => n == null || !isFinite(n) ? "—"
    : new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(n);
  const pct = (n) => n == null || !isFinite(n) ? "—" : n.toFixed(1).replace(".", ",") + " %";
  const zahl = (n) => n == null ? "—" : Number(n).toLocaleString("de-DE");
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  function num(v) {
    let s = String(v == null ? "" : v).replace(/[^\d.,-]/g, "");
    if (!s) return null;
    const k = s.lastIndexOf(","), p = s.lastIndexOf(".");
    if (k > -1 && p > -1) s = k > p ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
    else if (k > -1) s = s.split(",").length > 2 || /,\d{3}$/.test(s) && !/^\d{1,3},\d{3}$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
    else if (p > -1 && (s.split(".").length > 2 || /^\d{1,3}\.\d{3}$/.test(s))) s = s.replace(/\./g, "");
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  }
  const api = (path, method, body) => new Promise((res) => {
    try { chrome.runtime.sendMessage({ path, method: method || "GET", body }, (r) => res(r || { ok: false, status: 0 })); }
    catch (e) { res({ ok: false, status: 0, error: String(e) }); }
  });
  const store = {
    get: async (k) => { try { return await chrome.storage.local.get(k); } catch (e) { return {}; } },
    set: async (o) => { try { await chrome.storage.local.set(o); } catch (e) { } }
  };

  function seitenAsin() {
    const m = location.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i);
    if (m) return m[1].toUpperCase();
    const inp = document.getElementById("ASIN");
    return inp && /^[A-Z0-9]{10}$/i.test(inp.value) ? inp.value.toUpperCase() : null;
  }
  const IST_AMAZON = /(^|\.)amazon\.(de|fr|it|es)$/i.test(location.hostname);
  function seitenMarkt() {
    const t = location.hostname.split(".").pop();
    return MPS.includes(t) ? t : "de";
  }
  /* 1.9.29 (badge2211, 22.11.2026): Amazon zeigt das Verkaeufe-Abzeichen an mehreren Stellen und in vielen
   * Schreibweisen. Gemessen an 40 gespeicherten Produktseiten: 4 von 11 Seiten mit Kauf-Abzeichen trugen es nur im
   * Schnellansicht-Absatz #pqv-bought-in-last-month, nicht im Faceout #social-proofing-faceout-title-tk_bought.
   * „angesehen/viewed“ steht an derselben Stelle und ist KEIN Absatz -> nie als Abzeichen. */
  const BADGE_KAUF = /gekauft|k[äa]ufe|bought|purchased|achet|acquist|comprad|vendid/i;
  const BADGE_SICHT = /angesehen|viewed|\bvues?\b|vistas?\b|visualizzat|consultad/i;
  const nurSicht = (t) => BADGE_SICHT.test(t) && !BADGE_KAUF.test(t);
  function badgeSeite() {
    if (!IST_AMAZON) return null;
    const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
    for (const el of document.querySelectorAll('[id^="social-proofing-faceout-title-tk_bought"]')) {
      const t = txt(el);
      if (t && !nurSicht(t)) return t.slice(0, 80);              // Kauf-Faceout: Text in jeder Sprache
    }
    const weitere = [...document.querySelectorAll("#socialProofingAsinFaceout_feature_div .social-proofing-faceout-title-text"),
                     document.getElementById("pqv-bought-in-last-month")];
    for (const el of weitere) {
      const t = txt(el);
      if (t && BADGE_KAUF.test(t) && !nurSicht(t)) return t.slice(0, 80);
    }
    return null;
  }
  /* Ist die Seite fertig genug, dass „kein Abzeichen“ eine Aussage ist? Seite geladen, Abzeichen-Bereich im Markup,
   * mindestens BADGE_WARTE_MS seit dem Seitenstart (Amazon laedt Teile nach). Sonst gilt „nicht geprueft“. */
  const BADGE_WARTE_MS = 8000;
  function badgeGeprueft() {
    return IST_AMAZON && document.readyState === "complete" && !!document.getElementById("socialProofingAsinFaceout_feature_div") &&
      performance.now() >= BADGE_WARTE_MS;
  }
  // „Nur noch 1 auf Lager“ / „Only 1 left in stock“ des Buy-Box-Angebots dieser Seite
  function restSeite() {
    if (!IST_AMAZON) return null;
    const t = ((document.getElementById("availability") || {}).textContent || "").replace(/\s+/g, " ");
    const m = t.match(/(?:only|nur noch|il ne reste plus que|solo|sólo quedan?|quedan?)\s*(\d+)/i);
    return m ? parseInt(m[1], 10) : null;
  }
  function preisSeite() {
    if (!IST_AMAZON) return null;
    const el = document.querySelector("#corePrice_feature_div .a-offscreen, #corePriceDisplay_desktop_feature_div .a-offscreen");
    return el ? num(el.textContent) : null;
  }

  /* 1.9.25: Bewertungen der Produktseite fuer die Sales-Schaetzung (Betreiber 14.11.2026: „Bewertungen
   * innerhalb der letzten 45 d“). Gelesen wird nur, was die Seite ohnehin zeigt — kein weiterer Abruf:
   * die Bewertungszahl, die Sterne und das Datum der Bewertungen aus dem Land der Seite. Varianten teilen
   * sich die Bewertungen: dann zaehlen nur die Bewertungen der gewaehlten Variante (Farbe/Groesse steht an
   * jeder Bewertung); ist die Variante nicht lesbar, wird kein Datum gemeldet. Die Seite laedt die
   * Bewertungen teils spaeter nach — fehlt die Liste, ist das „unbekannt“ (null), nicht „keine“. */
  const MONATE = [["janv", 1], ["jan", 1], ["gen", 1], ["ene", 1], ["feb", 2], ["fev", 2], ["mar", 3], ["apr", 4], ["avr", 4], ["abr", 4],
                  ["mai", 5], ["may", 5], ["mag", 5], ["juil", 7], ["juin", 6], ["jun", 6], ["giu", 6], ["jul", 7], ["lug", 7],
                  ["aug", 8], ["aou", 8], ["ago", 8], ["sep", 9], ["set", 9], ["okt", 10], ["oct", 10], ["ott", 10], ["nov", 11],
                  ["dez", 12], ["dec", 12], ["dic", 12]];
  function rezDatum(text) {
    const s = String(text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    let tag, mon, jahr;
    let m = s.match(/(\d{1,2})\.?\s+(?:de\s+)?([a-z]{3,})\.?\s+(?:de\s+)?(20\d\d)/);
    if (m) { tag = +m[1]; mon = m[2]; jahr = +m[3]; }
    else {
      m = s.match(/([a-z]{3,})\s+(\d{1,2}),\s*(20\d\d)/);              // „November 3, 2026“
      if (!m) return null;
      mon = m[1]; tag = +m[2]; jahr = +m[3];
    }
    const e = MONATE.find((x) => mon.startsWith(x[0]));
    if (!e || tag < 1 || tag > 31) return null;
    return jahr + "-" + String(e[1]).padStart(2, "0") + "-" + String(tag).padStart(2, "0");
  }
  function bewertungenSeite() {
    if (!IST_AMAZON) return null;
    const txt = (el) => el ? el.textContent.replace(/\s+/g, " ").trim() : "";
    const a = document.querySelector("#acrCustomerReviewText");
    const az = a ? (a.getAttribute("aria-label") || txt(a)) : "";
    const zm = /\d\s*(k|tsd|mil)/i.test(az) ? null : az.match(/\d[\d.,\s\u00a0\u202f]*/);   // „1,2 Tsd.“ ist gerundet -> unbekannt
    const anzahl = zm ? parseInt(zm[0].replace(/\D/g, ""), 10) : null;
    const st = document.querySelector("#acrPopover");
    const sm = st ? (st.getAttribute("title") || "").match(/(\d)[.,](\d)/) : null;
    const sterne = sm ? parseFloat(sm[1] + "." + sm[2]) : null;
    let varianten = 0;
    try {
      const sk = Array.from(document.scripts).find((x) => x.textContent.indexOf('"dimensionToAsinMap"') >= 0);
      const dm = sk ? sk.textContent.match(/"dimensionToAsinMap"\s*:\s*\{([^}]*)\}/) : null;
      varianten = dm ? (dm[1].match(/"[A-Z0-9]{10}"/g) || []).length : 0;
    } catch (e) { varianten = 0; }
    if (!varianten && document.querySelector("[id^='inline-twister-row'], #twister [id^='variation_']")) varianten = 2;
    const wahl = Array.from(document.querySelectorAll("[id^='inline-twister-expanded-dimension-text-'], #twister [id^='variation_'] .selection"))
      .map(txt).filter(Boolean);
    const liste = document.querySelector("#localTopReviewsList, #cm-cr-dp-review-list");
    let rez = null;
    if (liste && !(varianten > 1 && !wahl.length)) {
      rez = [];
      const re = wahl.map((w) => new RegExp(":\\s*" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=$|[^:]{0,40}:)"));
      liste.querySelectorAll("[data-hook='review']").forEach((r) => {
        if (varianten > 1) {
          const f = txt(r.querySelector("[data-hook='format-strip'], [data-hook='format-strip-linkless']"));
          if (!re.every((x) => x.test(f))) return;                       // Bewertung einer anderen Variante
        }
        const d = rezDatum(txt(r.querySelector("[data-hook='review-date']")));
        if (d) rez.push(d);
      });
    }
    if (anzahl == null && rez == null) return null;
    return { anzahl, sterne, varianten, rez_daten: rez };
  }

  /* --- Angebotsliste (AOD) eines Markts: Namen + Menge je Verkaeufer ------------
   * 1.9.22 (14.11.2026, an der echten Liste gemessen): Amazon liefert zwei Varianten.
   *  - Privatkonto / abgemeldet: Mengen-Dropdown mit den Optionen 1..N.
   *  - Amazon-Business-Konto: KEIN Dropdown. Der Hoechstwert steht im Warenkorb-Knopf
   *    (data-aod-atc-action -> maxQty = N + 1). Unter „Verkäufer“ steht bei Fremdangeboten
   *    Amazon (USt.-Rechnung von Amazon), der Verkaeufer-Link sitzt dann an anderer Stelle.
   * Beide enden bei 29 (maxQty 30): ab da ist der echte Bestand unbekannt („gedeckelt“).
   * Vorher las das Panel nur die erste Variante — mit Business-Konto kam kein Bestand an. */
  const AOD_DECKEL = 29;
  const AOD_GENERISCH = /^(details?|détails|dettagli|detalles|mehr|more|plus|más|altro)$/i;
  const AOD_GEBRAUCHT = /gebraucht|used|occasion|usato|usado|segunda mano|seconde main|retourenkauf|warehouse|resale|renewed|refurbished|generalüberholt|reconditionn|ricondizionat|reacondicionad/i;
  function aodMenge(o) {
    const opts = o.querySelectorAll("[id^='aod-offer-qty-option-']").length;
    if (opts) return opts;
    const el = o.querySelector("[data-aod-atc-action]");
    if (!el) return null;
    try {
      const mx = parseInt(JSON.parse(el.getAttribute("data-aod-atc-action")).maxQty, 10);
      return mx >= 2 ? mx - 1 : null;            // maxQty 1 = keine Mengenauswahl -> Bestand unbekannt
    } catch (e) { return null; }
  }
  function aodPreis(o) {
    // Business-Konto zeigt netto UND brutto: brutto zaehlt (wie ueberall im Panel)
    const brutto = o.querySelector("[id^='aod-tax-incl-price']");       // „35,37 € inkl. USt“ als reiner Text
    if (brutto) { const n = num((brutto.textContent.match(/\d[\d.,]*/) || [""])[0]); if (n) return n; }
    const p = o.querySelector(".a-price .a-offscreen, .aok-offscreen");
    return p ? num((p.textContent.match(/[\d.,]+/) || [""])[0]) : null;
  }
  function aodParsen(html, mk, ohneSeite) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const txt = (el) => el ? el.textContent.replace(/\s+/g, " ").trim() : "";
    const out = [];
    doc.querySelectorAll("#aod-pinned-offer, #aod-offer").forEach((o, i) => {
      const sold = o.querySelector("#aod-offer-soldBy"), shipEl = o.querySelector("#aod-offer-shipsFrom");
      const link = (el) => el ? el.querySelector("a[href*='seller=']") : null;
      const alle = Array.from(o.querySelectorAll("a[href*='seller=']"));
      const a = link(sold) || link(shipEl) || alle.find((x) => !AOD_GENERISCH.test(txt(x))) || alle[0] || null;
      const m = a ? (a.getAttribute("href") || "").match(/seller=([A-Z0-9]+)/) : null;
      const soldName = txt(sold ? sold.querySelector("a, .a-color-base") : null);
      const shipName = txt(shipEl ? shipEl.querySelector("a, .a-color-base") : null);
      let name = m && !AOD_GENERISCH.test(txt(a)) ? txt(a) : soldName;
      if (m && /^amazon/i.test(name) && shipName && !/^amazon/i.test(shipName)) name = shipName;
      const gebraucht = AOD_GEBRAUCHT.test(txt(o.querySelector("#aod-offer-heading")) + " " + soldName);
      // Amazon selbst: kein Verkaeufer-Link und „Verkäufer Amazon“; Retourenkauf (gebraucht) ist nicht Amazon-Neuware
      const amazonVerkauf = !m && /^amazon/i.test(soldName) && !gebraucht;
      let qty = aodMenge(o);
      // Amazons eigene Mengenauswahl ist die Kaufgrenze je Kunde, kein Bestand (gemessen: angemeldet 2,
      // abgemeldet keine Auswahl). Fuer Amazon zaehlt nur „Nur noch N auf Lager“ der Produktseite.
      if (amazonVerkauf) qty = null;
      const pinned = o.id === "aod-pinned-offer";
      // ohneSeite (1.9.24, Nachmessen im Hintergrund): die offene Seite gehoert zu einem anderen Produkt
      if (pinned && !ohneSeite && mk === seitenMarkt()) { const r = restSeite(); if (r != null) qty = r; }
      const ship = txt(shipEl);
      out.push({ seller_id: m ? m[1] : (amazonVerkauf ? "AMAZON" : null), name, qty,
                 gedeckelt: qty != null && qty >= AOD_DECKEL, preis: aodPreis(o),
                 fba: /amazon/i.test(ship), pinned, gebraucht, pos: i });
    });
    return out;
  }

  /* Meldung an den Server: EIN Wert je Verkaeufer (auch Amazon). Hat ein Verkaeufer mehrere
   * Angebote (FBA + FBM, neu + gebraucht), zaehlt die Summe — sonst springt die Messung
   * zwischen den Mengen und erzeugt Scheinverkaeufe. Das oben angeheftete Angebot steht in
   * der Business-Variante noch einmal in der Liste: es zaehlt einmal. Ist ein Teil unbekannt,
   * ist der Bestand unbekannt; ist ein Teil gedeckelt, gilt der Deckel. */
  function aodMeldung(liste) {
    const je = {};
    const eintrag = (x) => je[x.seller_id] || (je[x.seller_id] = { seller_id: x.seller_id, name: x.name, preis: x.preis, fba: x.fba, teile: [] });
    liste.filter((x) => x.seller_id && !x.pinned).forEach((x) => {
      const e = eintrag(x);
      if (!e.name && x.name) e.name = x.name;
      const gleich = e.teile.find((t) => t.preis === x.preis && t.fba === x.fba && t.gebraucht === x.gebraucht);
      if (!gleich) e.teile.push({ preis: x.preis, fba: x.fba, gebraucht: x.gebraucht, qty: x.qty });
      else if (gleich.qty == null) gleich.qty = x.qty;
    });
    liste.filter((x) => x.seller_id && x.pinned).forEach((x) => {
      const e = eintrag(x);
      if (!e.name && x.name) e.name = x.name;
      const art = e.teile.filter((t) => t.fba === x.fba && t.gebraucht === x.gebraucht);
      const gleich = art.find((t) => t.preis === x.preis) || art[0];
      if (!gleich) e.teile.push({ preis: x.preis, fba: x.fba, gebraucht: x.gebraucht, qty: x.qty });
      else if (x.qty != null) gleich.qty = x.qty;                // „Nur noch N auf Lager“ der Seite ist der genauere Wert
    });
    return Object.keys(je).map((k) => {
      const e = je[k];
      const unbekannt = e.teile.some((t) => t.qty == null);
      const summe = e.teile.reduce((s, t) => s + (t.qty || 0), 0);
      const deckel = e.teile.some((t) => t.qty != null && t.qty >= AOD_DECKEL) || summe >= AOD_DECKEL;
      return { seller_id: e.seller_id, name: e.name, qty: deckel ? AOD_DECKEL : (unbekannt ? null : summe), preis: e.preis, fba: e.fba };
    });
  }

  // Stand nach der Meldung (Server-Antwort) in die geladenen Marktdaten uebernehmen
  function frischAnwenden() {
    let neu = false;
    Object.keys(S.frisch || {}).forEach((mk) => {
      const m = S.d && S.d.maerkte && S.d.maerkte[mk], f = S.frisch[mk];
      if (!m || !f) return;
      if (f.bestand) m.bestand = f.bestand;
      if (f.sales_andere) m.sales_andere = f.sales_andere;
      if (f.sales) m.sales = f.sales;                 // 1.9.25: vorsichtige Sales-Schaetzung
      neu = true;
    });
    return neu;
  }

  async function aodLaden(mk) {
    if (S.aod[mk] || S.aodLaeuft[mk] || !S.asin) return;
    S.aodLaeuft[mk] = true;
    const asin = S.asin;
    const r = await new Promise((res) => {
      try { chrome.runtime.sendMessage({ type: "axx-aod", mk, asin }, (x) => res(x || { ok: false })); }
      catch (e) { res({ ok: false, error: String(e) }); }
    });
    S.aodLaeuft[mk] = false;
    if (S.asin !== asin) return;
    if (!r.ok || !r.html) { S.aod[mk] = { fehler: r.error || ("HTTP " + (r.status || 0)), liste: [] }; zeichne(); return; }
    const liste = aodParsen(r.html, mk);
    S.aod[mk] = { liste };
    // Beobachtung melden (Namen, Stock, Badge) -> Verlauf + Sales-Schaetzung auf dem Server
    const angebote = aodMeldung(liste);           // 1.9.22: ein Wert je Verkaeufer, Amazon zaehlt mit
    const standNehmen = (r) => {
      // 1.9.23: die eben gemeldete Messung sofort verwenden (Bestandsdrops, Sales-Schaetzung) —
      // vorher stand sie erst beim naechsten Besuch der Seite im Panel.
      if (S.asin !== asin || !r || !r.ok || !r.data || !r.data.stand) return;
      S.frisch[mk] = r.data.stand;
      const tippt = S.root && S.root.activeElement && S.root.activeElement.tagName === "INPUT";
      if (frischAnwenden() && S.host && !tippt) zeichne();
    };
    const bew = mk === seitenMarkt() ? bewertungenSeite() : null;       // 1.9.25
    const badge1 = mk === seitenMarkt() ? badgeSeite() : null;
    api("/api/ext/beobachtung", "POST", {
      asin, mk, angebote,
      badge: badge1,
      preis: mk === seitenMarkt() ? preisSeite() : null,
      bewertungen: bew
    }).then(standNehmen);
    // 1.9.29 (badge2211): Abzeichen nachsehen, solange die Seite nachlaedt. Erscheint es spaeter, wird es nachgemeldet;
    // bleibt es aus, meldet die Extension EINMAL „fertig gelesen, kein Abzeichen“ (badge_geprueft) -- nur das darf der
    // Server als Beleg „ohne Abzeichen“ nehmen. Hoechstens eine Zusatzmeldung je Seitenbesuch.
    if (mk === seitenMarkt() && IST_AMAZON && !badge1) {
      const nachsehen = (rest) => setTimeout(() => {
        if (S.asin !== asin || seitenAsin() !== asin) return;            // Seite/Variante gewechselt
        const b = badgeSeite();
        if (b) {
          api("/api/ext/beobachtung", "POST", { asin, mk, angebote: [], badge: b, preis: null }).then(standNehmen);
          zeichne();
          return;
        }
        if (badgeGeprueft()) {
          api("/api/ext/beobachtung", "POST", { asin, mk, angebote: [], badge: null, preis: null, badge_geprueft: true }).then(standNehmen);
          return;
        }
        if (rest > 0) nachsehen(rest - 1);
      }, 4000);
      nachsehen(4);                                                       // bis ~20 s nach dem Laden der Angebote
    }
    // Die Seite laedt die Bewertungen teils erst nach: einmal nachsehen und nur dann nachmelden,
    // wenn jetzt Daten da sind, die beim ersten Mal fehlten (keine Angebote, kein Badge -> keine Doppelzeilen)
    if (mk === seitenMarkt() && IST_AMAZON && !(bew && bew.rez_daten)) setTimeout(() => {
      if (S.asin !== asin) return;
      const b2 = bewertungenSeite();
      if (!b2 || !b2.rez_daten) return;
      api("/api/ext/beobachtung", "POST", { asin, mk, angebote: [], badge: null, preis: null, bewertungen: b2 }).then(standNehmen);
    }, 7000);
    zeichne();
  }

  /* 1.9.24: Bestand nachmessen. Der Service-Worker schickt (nur wenn der Nutzer es in Arbitragex
   * eingeschaltet hat) einen Auftrag {asin, mk} an einen offenen Amazon-Tab: derselbe Abruf der
   * Angebotsliste wie beim Seitenbesuch, dieselbe Meldung an den Server — nur ohne dass die
   * Produktseite offen ist. Badge und Preis der Seite gehoeren zu einem anderen Produkt und
   * werden nicht gemeldet. Fehler (Pruefseite, HTTP) gehen als Fehler zurueck, nie als leere Liste. */
  async function aodNachmessen(asin, mk) {
    const r = await new Promise((res) => {
      try { chrome.runtime.sendMessage({ type: "axx-aod", mk, asin }, (x) => res(x || { ok: false })); }
      catch (e) { res({ ok: false, error: String(e) }); }
    });
    if (!r.ok || !r.html) return { nachmessen: true, ok: false, fehler: r.error || ("HTTP " + (r.status || 0)), status: r.status || 0 };
    const dieseSeite = asin === seitenAsin() && mk === seitenMarkt();
    const liste = aodParsen(r.html, mk, !dieseSeite);
    const angebote = aodMeldung(liste);
    const m = await api("/api/ext/beobachtung", "POST", { asin, mk, angebote, badge: null, preis: null, nachmessung: true });
    if (!m || !m.ok) return { nachmessen: true, ok: false, fehler: "Meldung an Arbitragex: " + ((m && m.data && m.data.error) || (m && m.error) || ("HTTP " + ((m && m.status) || 0))), status: 0 };
    return { nachmessen: true, ok: true, angebote: liste.length, mit_menge: angebote.filter((x) => x.qty != null).length,
             zeilen: (m.data && m.data.zeilen) || 0 };
  }

  /* --- Aufbau ------------------------------------------------------------- */
  function host() {
    if (S.host) return S.root;
    S.host = document.createElement("div");
    S.host.id = "axx-panel-host";
    lage();
    S.root = S.host.attachShadow({ mode: "open" });
    S.root.innerHTML = "<style>" + CSS + '</style><div class="p" id="p"></div><div class="cmodal" id="cmodal" hidden></div>';
    lage();
    document.documentElement.appendChild(S.host);
    // Chip aus content.js ausblenden — das minimierte Panel IST jetzt die Leiste
    if (!document.getElementById("axx-panel-chipaus")) {
      const st = document.createElement("style");
      st.id = "axx-panel-chipaus";
      st.textContent = "#" + CHIP_ID + "{display:none!important}";
      document.documentElement.appendChild(st);
    }
    return S.root;
  }
  // Das offene Panel endet immer 12 px über dem unteren Fensterrand (vorher feste Höhe ab 110 px:
  // der untere Teil lag außerhalb des Fensters und ließ sich nicht erreichen).
  const OBEN_STD = 64, MIN_HOEHE = 360;
  function lage() {
    const p = S.zu ? S.posZu : S.pos;
    let oben = OBEN_STD;
    if (!S.zu && p && p.top != null) oben = Math.max(8, Math.min(p.top, window.innerHeight - MIN_HOEHE));
    S.host.style.cssText = "position:fixed;z-index:2147483646;" +
      (S.zu ? (p && p.left != null ? "left:" + p.left + "px;top:" + p.top + "px;" : "right:22px;bottom:22px;")
            : (p && p.left != null ? "left:" + Math.max(0, Math.min(p.left, window.innerWidth - 120)) + "px;top:" + oben + "px;"
                                   : "right:14px;top:" + oben + "px;"));
    const el = S.root && S.root.getElementById("p");
    if (el) el.style.maxHeight = S.zu ? "" : Math.max(240, window.innerHeight - oben - 12) + "px";
  }
  window.addEventListener("resize", () => { if (S.host) lage(); });
  function entfernen() {
    if (S.host) { S.host.remove(); S.host = null; S.root = null; }
    const st = document.getElementById("axx-panel-chipaus");
    if (st) st.remove();
  }

  function zeichne() {
    const root = host();
    lage();
    const p = root.getElementById("p");
    if (S.zu) {
      S.chartGross = false;
      const cm = root.getElementById("cmodal");
      if (cm) { cm.hidden = true; cm.innerHTML = ""; }
      p.className = "p zu";
      p.innerHTML = leiste();
      kopierbar(root);
      root.getElementById("auf").onclick = () => { S.zu = false; store.set({ axxPanelZu: false }); zeichne(); };
      ziehbar(root.getElementById("griff"), true);
      return;
    }
    p.className = "p";
    const k = Object.assign({}, S.d && S.d.katalog || {});
    if (!k.ean && S.ean) k.ean = S.ean;
    const kopf = '<div class="kopf" id="kopf">' +
      (k.bild ? '<img src="' + esc(k.bild) + '" alt="">' : '<div class="noimg">📦</div>') +
      '<div class="ktxt"><b title="' + esc(k.titel || "") + '">' + esc(k.titel || "Arbitragex") + "</b>" +
        '<span class="codes"><button class="cp" data-copy="' + esc(S.asin || "") + '" title="ASIN kopieren">' + esc(S.asin || "") + "</button>" +
        (k.ean ? '<button class="cp ean" data-copy="' + esc(k.ean) + '" title="EAN kopieren">' + esc(k.ean) + "</button>"
               : (S.eanFehlt ? '<span class="ohne" title="Amazon führt für dieses Listing keine EAN, zum Beispiel wegen einer GTIN-Befreiung des Herstellers. Die Links suchen deshalb mit der ASIN.">keine EAN bei Amazon</span>' : "")) + "</span>" +
        (k.masse ? "<span>" + masseText(k.masse) + "</span>" : "") + "</div>" +
      '<div class="kbtn"><button id="zahnrad" title="Extension-Einstellungen">⚙</button><button id="neu" title="Neu laden (frische Preise und Gebühren)">↻</button>' +
      '<button id="min" title="Zur AX-Leiste verkleinern">–</button><button id="x" title="Auf dieser Seite schließen">×</button></div></div>' +
      schnelllinks(k);
    let inhalt;
    if (S.fehler) inhalt = '<div class="msg">' + S.fehler + "</div>";
    else if (!S.d) inhalt = '<div class="msg"><span class="spin"></span> Profit wird gerechnet…</div>';
    else inhalt = rumpf();
    p.innerHTML = kopf + '<div class="inhalt">' + inhalt + einstellungen() + "</div>";
    einstellungenVerdrahten(root);
    root.getElementById("min").onclick = () => { S.zu = true; store.set({ axxPanelZu: true }); zeichne(); };
    root.getElementById("x").onclick = () => entfernen();
    root.getElementById("neu").onclick = () => laden(S.asin, true);
    root.getElementById("zahnrad").onclick = () => {
      S.einstAuf = true;
      const det = root.getElementById("einst");
      if (det) { det.open = true; det.scrollIntoView({ block: "start", behavior: "smooth" }); }
    };
    kopierbar(root);
    ziehbar(root.getElementById("kopf"), false);
    if (S.d) verdrahten(root);
  }

  function kopierbar(root) {
    root.querySelectorAll("[data-copy]").forEach((b) => {
      b.onmousedown = (e) => e.stopPropagation();          // nicht als Ziehen werten
      b.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        const txt = b.getAttribute("data-copy");
        const ok = () => { const t = b.textContent; b.textContent = "kopiert ✓"; setTimeout(() => { b.textContent = t; }, 900); };
        const alt = () => {                       // Shop-Seiten verweigern die Clipboard-API teils (Permissions-Policy)
          const ta = document.createElement("textarea");
          ta.value = txt; ta.style.cssText = "position:fixed;opacity:0";
          document.body.appendChild(ta); ta.select();
          try { if (document.execCommand("copy")) ok(); } catch (err) { }
          ta.remove();
        };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(ok, alt); else alt();
      };
    });
  }

  function masseText(m) {
    const f = (x) => x == null ? "?" : String(Math.round(x * 10) / 10).replace(".", ",");
    return f(m.l) + " × " + f(m.b) + " × " + f(m.h) + " cm" + (m.kg != null ? ", " + f(m.kg) + " kg" : "") +
      (m.art === "Artikel" ? " (ohne Verpackung)" : "");
  }

  // Preisvergleich mit der EAN (ohne EAN mit der ASIN): idealo, Amazon, Google — im Panel und in der Leiste
  function linkZiele(k) {
    const q = (k && k.ean) || S.asin || "";
    return [["idealo", "https://www.idealo.de/preisvergleich/MainSearchProductCategory.html?q=" + encodeURIComponent(q), "Bei idealo mit der EAN suchen"],
            ["Amazon", "https://www.amazon.de/dp/" + encodeURIComponent(S.asin || ""), "Produktseite auf Amazon.de"],
            ["Google", "https://www.google.com/search?q=" + encodeURIComponent(q), "Bei Google mit der EAN suchen"]];
  }
  function schnelllinks(k) {
    if (!S.asin || S.asin === "-") return "";
    return '<nav class="links">' + linkZiele(k).map(([n, u, t]) =>
      '<a target="_blank" rel="noopener" href="' + u + '" title="' + t + '">' + n + "</a>").join("") + "</nav>";
  }

  function leiste() {
    const k = Object.assign({}, S.d && S.d.katalog || {});
    if (!k.ean && S.ean) k.ean = S.ean;
    return '<div class="leiste"><button class="ax" id="auf" title="Profit-Panel öffnen">AX</button>' +
      (S.asin ? '<button data-copy="' + esc(S.asin) + '" title="ASIN kopieren">' + esc(S.asin) + "</button>" : "") +
      (k.ean ? '<button class="ean" data-copy="' + esc(k.ean) + '" title="EAN kopieren">' + esc(k.ean) + "</button>" : "") +
      linkZiele(k).map(([n, u, t]) => '<a target="_blank" rel="noopener" href="' + u + '" title="' + t + '">' + n + "</a>").join("") +
      (S.kurz != null ? '<span class="lg ' + (S.kurz >= 0 ? "pos" : "neg") + '">' + eur(S.kurz) + "</span>" : "") +
      '<span class="grip" id="griff" title="Verschieben">⠿</span></div>';
  }

  function rumpf() {
    const d = S.d, mk = S.mk, m = d.maerkte[mk] || {};
    const tabs = MPS.map((k) => {
      const x = d.maerkte[k] || {};
      const laedt = !d.maerkte[k] && S.ladeRest;
      return '<button class="tab' + (k === mk ? " an" : "") + (x.vorhanden || laedt ? "" : " aus") + '" data-mk="' + k + '"' +
        (laedt ? ' title="wird geladen"' : "") + ">" + FLAG[k] + " " + k.toUpperCase() + (laedt ? ' <span class="spin mini"></span>' : "") + "</button>";
    }).join("");
    if (!d.maerkte[mk] && S.ladeRest) return '<div class="tabs">' + tabs + '</div><div class="msg"><span class="spin"></span> ' + mk.toUpperCase() + " wird geladen…</div>";
    if (!d.maerkte[mk] && S.restFehler) return '<div class="tabs">' + tabs + '</div><div class="msg neg">' + mk.toUpperCase() + " nicht geladen: " + esc(S.restFehler) + "</div>";
    if (m.fehler) return '<div class="tabs">' + tabs + '</div><div class="msg neg">Fehler ' + mk.toUpperCase() + ": " + esc(m.fehler) + "</div>";
    if (!m.vorhanden) return '<div class="tabs">' + tabs + '</div><div class="msg">In ' + mk.toUpperCase() + " nicht gelistet.</div>";
    const frei = m.frei === true ? '<span class="pos">Ja</span>' : m.frei === false
      ? '<span class="neg" title="' + esc(m.frei_detail || "") + '">🔒 Nein</span>' : '<span class="mut">?</span>';
    const bsr = mk === "de" && d.bsr && d.bsr.rank ? '<span title="' + esc(d.bsr.kategorie || "") + '">#' + zahl(d.bsr.rank) + "</span>"
      : (m.rang ? '<span title="Rang in der Unterkategorie">#' + zahl(m.rang) + "</span>" : "—");
    const kanalBtn = '<div class="seg"><button data-kanal="fba" class="' + (S.kanal === "fba" ? "an" : "") + '">FBA</button>' +
      '<button data-kanal="fbm" class="' + (S.kanal === "fbm" ? "an" : "") + '">FBM</button></div>';
    const tarif = S.kanal === "fba" && (m.modell_efn || S.tarif[mk]) ? '<button class="tarif" id="tarif" title="Tarif umschalten (Standard: ' +
      esc({ auto: "nach Lager", paneu: "Pan-EU", efn: "EFN" }[d.eu_versand] || d.eu_versand) + ')">' +
      (S.tarif[mk] ? "EFN" : "Pan-EU") + "</button>" : "";
    // Reihenfolge (Betreiber 11.11.2026): Freigabe, BSR, Angebote und Sales über den Eingaben
    return '<div class="tabs">' + tabs + "</div>" +
      AxxRechner.fakten(d, mk, mk === seitenMarkt() ? badgeSeite() : null, BASE) +
      '<div class="eingabe"><div class="ehead">Kalkulation</div>' +
      '<div class="ein">' +
        '<label>EK €<input id="ek" inputmode="decimal" placeholder="0,00"></label>' +
        '<label><span class="lz">VK € ' + mk.toUpperCase() +
          // USt-Umschalter sitzt im Feldtitel (eigene Zeile kostete den Platz für „Einkauf registrieren“)
          '<span class="ustg">' + AxxRechner.ustKnoepfe(S.d, mk, S.kanal, S.tarif[mk], S.ustModus) + '</span></span><input id="vk" inputmode="decimal" value="' +
          (S.vk[mk] != null ? String(S.vk[mk].toFixed(2)).replace(".", ",") : "") + '"></label>' +
        '<label>Menge<input id="menge" inputmode="numeric" value="' + S.menge + '"></label>' +
      "</div>" +
      '<div class="opt">' + kanalBtn + tarif +
        (S.kanal === "fbm" ? '<label>Versand €<input id="versand" inputmode="decimal" value="' + String(S.versand).replace(".", ",") + '"></label>'
                           : '<label>Prep €<input id="prep" inputmode="decimal" value="' + String(S.prep).replace(".", ",") + '"></label>') +
        '<label>Ziel-ROI<input id="ziel" inputmode="decimal" value="' + S.ziel + '"></label>' +
        '<label><input type="checkbox" id="netto"' + (S.ekNetto ? " checked" : "") + "> EK netto</label>" +

      "</div>" +
      '<div class="landhinweis" id="landhinweis"></div>' +
      '<div class="erg" id="erg"></div>' +
      '<div class="kaufres" id="kaufres">' + (S.kaufMeldung || "") + "</div>" +
      kaufFelder() +
      '<button class="kauf" id="kauf">Einkauf registrieren</button>' +
      "</div>" +
      '<details class="box" open id="geb"><summary>Rechnung &amp; Gebühren</summary><div id="aufst"></div></details>' +
      chartBlock(m) +
      '<table class="alle"><tr><th></th><th>Buy Box</th><th>Gewinn</th><th>ROI</th></tr>' +
        MPS.map((k) => '<tr data-mk="' + k + '"' + (k === mk ? ' class="an"' : "") + "><td>" + FLAG[k] + " " + k.toUpperCase() + "</td><td>" +
          eur((d.maerkte[k] || {}).buybox) + '</td><td id="g-' + k + '">—</td><td id="r-' + k + '">—</td></tr>').join("") +
      "</table>" +
      sellerBlock(m, mk);
  }
  // „Mehr als 1.000 Mal im letzten Monat gekauft“ / „1K+ bought in past month“ -> „1.000+ / Monat“
  function badgeKurz(t) {
    const m = String(t || "").match(/([\d.,]+)\s*(k|tsd)?\+?/i);
    if (!m) return t;
    let n = m[1];
    if (m[2]) n = String(Math.round(parseFloat(n.replace(",", ".")) * 1000)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    return n + "+ / Monat";
  }
  function kachel(t, v) { return '<div class="k"><i>' + t + "</i><b>" + v + "</b></div>"; }

  function salesBlock(m, mk) {
    const badge = (mk === seitenMarkt() && badgeSeite()) ? { text: badgeSeite(), quelle: "pdp" } : m.badge;
    const s = m.sales_andere || {};
    const schaetz = s.pro_monat != null ? "~" + s.pro_monat + "/Monat"
      : (s.beobachtungen ? '<span class="mut">Messung läuft</span>' : '<span class="mut">ab nächstem Besuch</span>');
    const kp = m.keepa || {};
    const keepaGesperrt = S.d && S.d.abo === false;          // Keepa-Werte nur mit Abo (Keepa-AGB)
    return '<div class="grid sales">' +
      kachel("Keepa · Verkäufe/Monat", keepaGesperrt
        ? '<a class="abo" href="' + BASE + '/billing?src=extension-keepa" target="_blank" rel="noopener">🔒 mit Abo</a>'
        : kp.verkauft_monat != null
        ? '<span title="Aus Delta (Keepa), Stand ' + (kp.ts ? new Date(kp.ts * 1000).toLocaleDateString("de-DE") : "?") +
          (kp.avg30 ? " · Ø 30 T " + eur(kp.avg30) : "") + (kp.drops30 != null ? " · " + kp.drops30 + " Rang-Drops 30 T" : "") + '">~' +
          zahl(kp.verkauft_monat) + (kp.avg30 ? "<small>Ø 30 T " + eur(kp.avg30) + "</small>" : "") + "</span>"
        : '<span class="mut">keine Delta-Daten</span>') +
      kachel("Sales-Badge", badge ? '<span class="badgetxt" title="' + esc(badge.text) + " · Quelle: " + (badge.quelle === "delta" ? "Delta" : "Produktseite") + '">' +
        esc(badgeKurz(badge.text)) + "</span>" : '<span class="mut" title="Amazon zeigt auf dieser Seite kein „… im letzten Monat gekauft“">nicht angezeigt</span>') +
      kachel("Andere (Schätzung)", '<span title="Aus Bestandsrückgängen anderer Verkäufer: ' + (s.beobachtungen || 0) +
        " Beobachtungen, " + (s.seller || 0) + " Verkäufer. Nicht gezählt: Nachschub, verschwundene Verkäufer, Großabgänge (" +
        (s.ausgelassen || 0) + ' Stk, eher Remission)">' + schaetz + "</span>") +
      kachel("Deine (30 T)", (m.eigene_sales_30t || 0) + " Stk") +
      "</div>";
  }

  /* --- Chart (1.9.32): Buy Box / Amazon / FBA- / FBM-Minimum, Angebote, BSR ----------------
   * Zeitachse = gewaehlter Zeitraum (30/90/365 T) bis jetzt. Werte als Stufen. Ausreisser
   * (< 40 % oder > 250 % des Medians) werden nicht gezeichnet. Zugaenglich: feste Lesezeile
   * statt schwebendem Tooltip, Tastatur (Pfeiltasten/Pos1/Ende/Esc) + Pointer/Touch,
   * ein-/ausblendbare Linien mit eigener Strichart, EK-Linie, Keepa-Link, Werte als Tabelle
   * und ein-Klick-Grossansicht direkt ueber Amazon. */
  const REIHEN = [
    ["buybox", "Buy Box", "#f0f3f0", 2.2, ""],
    ["amazon", "Amazon", "#f59e42", 1.8, ""],
    ["fba_min", "FBA min", "#46d39a", 1.6, ""],
    ["fbm_min", "FBM min", "#a3b1a9", 1.6, "6 3"],
    ["angebot_min", "günstigstes", "#7b8c84", 1.4, "2 3"]
  ];
  const UST_STD = { de: 0.19, fr: 0.20, it: 0.22, es: 0.21 };
  const CW = 300, CH = 112, CB = 36, PL = 36, PR = 6, PT = 8, PB = 16;

  function chartEkBrutto(mk) {
    if (!(S.ek > 0)) return null;
    return S.ekNetto ? S.ek * (1 + (UST_STD[mk] || 0.19)) : S.ek;
  }
  function chartWertBei(reihe, t) {
    let v = null;
    for (let i = 0; i < reihe.length; i++) {
      if (reihe[i][0] <= t + 1) v = reihe[i][1]; else break;
    }
    return v;
  }
  function chartLetzterBei(liste, t) {
    let x = null;
    for (let i = 0; i < liste.length; i++) {
      if (liste[i].ts <= t + 1) x = liste[i]; else break;
    }
    return x;
  }
  function chartKennzahlen(reihe, t0, t1) {
    let sum = 0, dauer = 0, lo = Infinity, hi = -Infinity;
    reihe.forEach((p, i) => {
      const a = Math.max(p[0], t0), b = i + 1 < reihe.length ? reihe[i + 1][0] : t1;
      if (b > a) { sum += p[1] * (b - a); dauer += b - a; }
      lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]);
    });
    return { jetzt: reihe[reihe.length - 1][1], schnitt: dauer ? sum / dauer : reihe[0][1], tief: lo, hoch: hi };
  }
  function chartStrich(farbe, dash) {
    const d = dash ? ' stroke-dasharray="' + dash.replace(/\d+/g, (n) => Math.max(2, Math.round(+n * 0.7))) + '"' : "";
    return '<svg class="cstrich" width="16" height="8" viewBox="0 0 16 8" aria-hidden="true"><line x1="1" y1="4" x2="15" y2="4" stroke="' + farbe + '" stroke-width="2.5" stroke-linecap="round"' + d + "/></svg>";
  }
  function keepaUrl(asin, mk) {
    if (!asin || asin === "-") return "";
    return "https://keepa.com/#!product/" + (KEEPA_NR[mk] || 3) + "-" + encodeURIComponent(asin);
  }

  function chartDaten(m) {
    const jetzt = Date.now() / 1000, t0 = jetzt - S.bereich * 86400;
    const alle = (m.verlauf || []).slice().sort((a, b) => a.ts - b.ts);
    const werte = [];
    alle.forEach((x) => REIHEN.forEach(([k]) => { if (x[k]) werte.push(x[k]); }));
    werte.sort((a, b) => a - b);
    const med = werte.length ? werte[Math.floor(werte.length / 2)] : null;
    const ok = (v) => v && med && v >= med * 0.4 && v <= med * 2.5;
    const reihen = {}, zeiten = {};
    REIHEN.forEach(([k]) => {
      const p = alle.filter((x) => ok(x[k]));
      const vor = p.filter((x) => x.ts < t0).pop();
      const drin = p.filter((x) => x.ts >= t0).map((x) => [x.ts, x[k]]);
      if (vor) drin.unshift([t0, vor[k]]);
      if (drin.length) { reihen[k] = drin; drin.forEach((pt) => { zeiten[pt[0]] = 1; }); }
    });
    const ang = alle.filter((x) => x.ts >= t0 && (x.fba_n != null || x.fbm_n != null));
    const bsr = alle.filter((x) => x.ts >= t0 && x.bsr);
    ang.concat(bsr).forEach((x) => { zeiten[x.ts] = 1; });
    const ticks = Object.keys(zeiten).map(Number).filter((t) => t >= t0).sort((a, b) => a - b);
    if (!ticks.length || ticks[ticks.length - 1] < jetzt - 60) ticks.push(jetzt);
    return { t0, t1: jetzt, reihen, ang, bsr, ticks, punkte: alle.filter((x) => x.ts >= t0).length };
  }

  function chartBlock(m, gross) {
    const pre = gross ? "cm-" : "c-";
    const W = gross ? 740 : CW, H = gross ? 236 : CH, HB = gross ? 58 : CB;
    const pl = gross ? 54 : PL, pr = gross ? 14 : PR, pt = gross ? 12 : PT, pb = gross ? 22 : PB;
    const knoepfe = [30, 90, 365].map((t) => '<button type="button" data-bereich="' + t + '" aria-pressed="' + (S.bereich === t) + '" class="' + (S.bereich === t ? "an" : "") + '">' + (t === 365 ? "1 J" : t + " T") + "</button>").join("");
    const ku = keepaUrl(S.asin, S.mk);
    const keepa = ku ? '<a class="ckeepa" href="' + ku + '" target="_blank" rel="noopener noreferrer" title="Produkt bei Keepa öffnen">Keepa ↗</a>' : "";
    const grossKnopf = gross
      ? '<button type="button" class="cbtn" id="cmZu" aria-label="Großansicht schließen">✕ Schließen</button>'
      : '<button type="button" class="cbtn" id="cGross" title="Preisverlauf groß öffnen (Tastatur & Tabelle)" aria-label="Preisverlauf groß öffnen">⤢ Groß</button>';
    const mkTabs = gross && S.d && S.d.maerkte
      ? '<span class="seg mini" role="group" aria-label="Marktplatz">' + MPS.map((k) => {
          const hat = (((S.d.maerkte[k] || {}).verlauf) || []).length > 0;
          return '<button type="button" data-cmk="' + k + '" aria-pressed="' + (k === S.mk) + '" class="' + (k === S.mk ? "an" : "") + '"' + (hat ? "" : " disabled") + ">" + FLAG[k] + " " + k.toUpperCase() + "</button>";
        }).join("") + "</span>"
      : "";
    const cd = chartDaten(m);
    const kopf = '<div class="chead"><b>' + (gross ? "Preisverlauf · " + esc(S.asin || "") + " (" + (S.mk || "de").toUpperCase() + ")" : "Preisverlauf") + "</b>" +
      '<div class="chead-r">' + mkTabs + '<span class="seg mini" role="group" aria-label="Zeitraum">' + knoepfe + "</span>" + keepa + grossKnopf + "</div></div>";
    const vorh = REIHEN.filter(([k]) => cd.reihen[k]);
    if (!vorh.length) {
      return '<div class="box chart-box' + (gross ? " gross" : "") + '" id="' + pre + 'box">' + kopf +
        '<div class="mut leer">Noch keine Preise im Zeitraum. Jeder Besuch, der Nachtlauf und Delta füllen den Verlauf.</div></div>';
    }
    let sicht = vorh.filter(([k]) => !S.chartAus[k]);
    if (!sicht.length) sicht = [vorh[0]];
    const ek = chartEkBrutto(S.mk);
    let lo = Infinity, hi = -Infinity;
    sicht.forEach(([k]) => cd.reihen[k].forEach(([, v]) => { lo = Math.min(lo, v); hi = Math.max(hi, v); }));
    const ekDrin = ek && isFinite(lo) && ek >= lo * 0.25 && ek <= hi * 4;
    if (ekDrin) { lo = Math.min(lo, ek); hi = Math.max(hi, ek); }
    const pad = Math.max((hi - lo) * 0.12, hi * 0.015, 0.5);
    lo = Math.max(0, lo - pad); hi += pad;
    const X = (t) => pl + ((t - cd.t0) / (cd.t1 - cd.t0)) * (W - pl - pr);
    const Y = (v) => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
    const stufe = (r) => r.map(([t, v], i) => (i ? "H" + X(t).toFixed(1) + "V" : "M" + X(t).toFixed(1) + ",") + Y(v).toFixed(1)).join("") +
      "H" + X(cd.t1).toFixed(1);
    const schritteY = gross ? 4 : 2;
    let svg = "";
    for (let i = 0; i <= schritteY; i++) {
      const v = lo + (hi - lo) * (i / schritteY), y = Y(v).toFixed(1);
      svg += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y + '" y2="' + y + '" class="gitter"/>' +
        '<text x="' + (pl - 4) + '" y="' + (+y + 3) + '" class="ax" text-anchor="end">' + kurzEur(v) + "</text>";
    }
    const nx = gross ? 6 : 2;
    for (let i = 0; i <= nx; i++) {
      const t = cd.t0 + (cd.t1 - cd.t0) * (i / nx);
      svg += '<text x="' + X(t).toFixed(1) + '" y="' + (H - 3) + '" class="ax" text-anchor="' + (i === 0 ? "start" : i === nx ? "end" : "middle") + '">' + tag(t) + "</text>";
    }
    if (cd.reihen.buybox && !S.chartAus.buybox) {
      svg += '<path d="' + stufe(cd.reihen.buybox) + "V" + Y(lo).toFixed(1) + "H" + X(cd.reihen.buybox[0][0]).toFixed(1) + 'Z" class="flaeche"/>';
    }
    if (ekDrin) {
      const ye = Y(ek).toFixed(1);
      svg += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + ye + '" y2="' + ye + '" stroke="#a78bfa" stroke-width="1.3" stroke-dasharray="6 3"/>' +
        '<text x="' + (W - pr - 3) + '" y="' + (+ye - 3) + '" class="ax ekax" text-anchor="end">EK ' + eur(ek) + "</text>";
    }
    sicht.slice().reverse().forEach(([k, , farbe, breite, dash]) => {
      svg += '<path d="' + stufe(cd.reihen[k]) + '" fill="none" stroke="' + farbe + '" stroke-width="' + (gross ? breite : Math.max(1.3, breite - 0.2)) + '" stroke-linejoin="round"' +
        (dash ? ' stroke-dasharray="' + dash + '"' : "") + "/>";
    });
    svg += '<g id="' + pre + 'cur" style="display:none">' +
      '<line id="' + pre + 'hl" x1="0" x2="0" y1="' + pt + '" y2="' + (H - pb) + '" class="hover"/>' +
      sicht.map(([k, , farbe]) => '<circle data-ck="' + k + '" r="' + (gross ? 4 : 3) + '" fill="' + farbe + '" stroke="#0f1512" stroke-width="1.2"/>').join("") +
      "</g>";
    // Unterer Streifen: Angebote (Stufenlinie) + BSR (Linie, oben = besser)
    let unten = "";
    const maxN = Math.max(1, ...cd.ang.map((x) => (x.fba_n || 0) + (x.fbm_n || 0)));
    const XB = (t) => pl + ((t - cd.t0) / (cd.t1 - cd.t0)) * (W - pl - pr);
    if (cd.ang.length >= 2) {
      const YA = (n) => HB - 4 - (n / maxN) * (HB - 10);
      unten += '<path d="' + cd.ang.map((x, i) => (i ? "H" + XB(x.ts).toFixed(1) + "V" : "M" + XB(x.ts).toFixed(1) + ",") +
        YA((x.fba_n || 0) + (x.fbm_n || 0)).toFixed(1)).join("") + "H" + XB(cd.t1).toFixed(1) + '" fill="none" stroke="#7fa8d6" stroke-width="1.5"/>' +
        '<text x="' + (pl - 4) + '" y="10" class="ax" text-anchor="end">' + maxN + " Ang.</text>";
    }
    if (cd.bsr.length >= 2) {
      const bl = Math.min(...cd.bsr.map((x) => x.bsr)), bh = Math.max(...cd.bsr.map((x) => x.bsr));
      const YB = (v) => 5 + ((v - bl) / Math.max(bh - bl, 1)) * (HB - 12);
      unten += '<path d="' + cd.bsr.map((x, i) => (i ? "L" : "M") + XB(x.ts).toFixed(1) + "," + YB(x.bsr).toFixed(1)).join("") +
        '" fill="none" stroke="#e5b45a" stroke-width="1.3" stroke-dasharray="3 2"/>' +
        '<text x="' + (pl - 4) + '" y="' + (HB - 3) + '" class="ax" text-anchor="end">#' + kurzZahl(bl) + "</text>";
    }
    let drops = { html: "", legende: "" };
    if (!gross) {
      try { drops = bestandStreifen(m, cd, XB); }
      catch (e) { drops = { html: '<div class="mut streifen">Bestandsdrops: Anzeige-Fehler (' + esc(e && e.message) + ")</div>", legende: "" }; }
    }
    const haupt = sicht[0], kz = chartKennzahlen(cd.reihen[haupt[0]], cd.t0, cd.t1);
    const stats = '<div class="cstats">' +
      "<span><i>" + haupt[1] + " aktuell</i><b>" + eur(kz.jetzt) + "</b></span>" +
      "<span><i>Ø " + (S.bereich === 365 ? "1 J" : S.bereich + " T") + "</i><b>" + eur(kz.schnitt) + "</b></span>" +
      "<span><i>Tief</i><b>" + eur(kz.tief) + "</b></span>" +
      "<span><i>Hoch</i><b>" + eur(kz.hoch) + "</b></span>" +
      (ek ? "<span><i>EK" + (S.ekNetto ? " brutto" : "") + "</i><b>" + eur(ek) + "</b></span>" : "") +
      "</div>";
    const jetztN = (m.fba_anzahl || 0) + (m.fbm_anzahl || 0);
    const jetztBsr = S.mk === "de" && S.d && S.d.bsr ? S.d.bsr.rank : m.rang;
    const erst = (m.verlauf || []).filter((x) => x.quelle !== "delta" && (x.fba_n != null || x.bsr)).map((x) => x.ts)[0];
    const streifenInfo = (cd.ang.length < 2 || cd.bsr.length < 2)
      ? '<div class="mut streifen">Angebote <b>' + jetztN + "</b> · BSR <b>" + (jetztBsr ? "#" + zahl(jetztBsr) : "—") +
        "</b> — Verlauf dafür" + (erst ? " ab " + tag(erst) : " ab heute") + " (eigene Messung; Delta speichert ihn nicht)</div>" : "";
    const legende = vorh.map(([k, n, f, , dash]) => {
      const an = !S.chartAus[k];
      return '<button type="button" class="cleg-btn" data-linie="' + k + '" aria-pressed="' + an + '">' + chartStrich(f, dash) + n + "</button>";
    }).join("") +
      (ekDrin ? '<span class="cleg-fest">' + chartStrich("#a78bfa", "6 3") + "EK</span>" : "") +
      (cd.ang.length >= 2 ? '<span class="cleg-fest">' + chartStrich("#7fa8d6", "") + "Angebote</span>" : "") +
      (cd.bsr.length > 1 ? '<span class="cleg-fest">' + chartStrich("#e5b45a", "3 2") + "BSR</span>" : "");
    const meta = { cd, X, Y, W, H, pl, pr, sicht, ek, i: null };
    if (gross) S.chartModal = meta; else S.chart = meta;
    return '<div class="box chart-box' + (gross ? " gross" : "") + '" id="' + pre + 'box" role="region" aria-label="Preisverlauf">' + kopf +
      stats +
      '<div class="clese" id="' + pre + 'lese" aria-live="off"></div>' +
      '<div class="cwrap" id="' + pre + 'wrap" tabindex="0" role="group" aria-roledescription="Diagramm" aria-label="Preisverlauf – Pfeiltasten links und rechts für Messpunkte, Pos1 und Ende für Anfang und Ende">' +
        '<svg viewBox="0 0 ' + W + " " + H + '" class="chart" id="' + pre + 'chart" aria-hidden="true">' + svg + "</svg>" +
      "</div>" +
      (unten ? '<svg viewBox="0 0 ' + W + " " + HB + '" class="chart klein" aria-hidden="true">' + unten + "</svg>" : "") + streifenInfo +
      drops.html +
      '<div class="leg" role="group" aria-label="Linien ein- und ausblenden">' + legende + drops.legende + "</div>" +
      '<details class="ctbl-det" id="' + pre + 'det"><summary>Werte als Tabelle</summary><div class="ctbl-wrap" id="' + pre + 'tb"></div></details>' +
      '<div class="mut">' + cd.punkte + " Punkte" + ((m.verlauf || []).some((x) => x.quelle === "delta") ? " · inkl. Delta" : "") + " · Pfeiltasten oder Zeiger über das Diagramm</div></div>";
  }

  /* --- Bestandsdrops (10.11.2026): nur bei Produkten OHNE Verkaeufe-Badge ----------------
   * Balken je Tag: verkaufte Stueck (Bestand eines Verkaeufers ist zwischen zwei Beobachtungen
   * gesunken), gruene Marke = Nachschub, grauer Rahmen = Grossabgang (eher Remission, zaehlt nicht).
   * Quelle: Angebotsliste der Produktseite bei jedem Besuch — Amazons API nennt fremden Bestand nicht. */
  function bestandStreifen(m, cd, XB) {
    const leer = { html: "", legende: "" };
    const mk = S.mk;
    const badge = (mk === seitenMarkt() && badgeSeite()) || m.badge;
    if (badge) return leer;                                   // mit Badge zeigt Amazon die Verkaeufe selbst
    const b = m.bestand || {};
    if (b.fehler) return { html: '<div class="mut streifen">Bestandsdrops: Fehler beim Laden (' + esc(b.fehler) + ")</div>", legende: "" };
    const tage = (b.tage || []).filter((t) => t.ts + 86400 >= cd.t0);
    if (!tage.length) {
      return { html: '<div class="mut streifen">Bestandsdrops: ' + (b.beobachtungen
        ? b.beobachtungen + " Bestandsmessungen bei " + (b.seller || 0) + " Verkäufern, bisher keine Änderung"
        : "Messung läuft – jeder Besuch dieser Seite speichert den Bestand je Verkäufer") + "</div>", legende: "" };
    }
    const H = 34, maxV = Math.max(1, ...tage.map((t) => Math.max(t.verkauft, t.gross)));
    const bw = Math.max(2.5, Math.min(9, (CW - PL - PR) / S.bereich - 1));
    const namen = (tagTs, art) => (b.ereignisse || []).filter((e) => e.art === art && e.ts >= tagTs && e.ts < tagTs + 86400)
      .map((e) => (e.name || e.seller_id) + ": " + e.von + " → " + e.auf).join(", ");
    let svg = '<line x1="' + PL + '" x2="' + (CW - PR) + '" y1="' + (H - 3) + '" y2="' + (H - 3) + '" class="gitter"/>' +
      '<text x="' + (PL - 3) + '" y="9" class="ax" text-anchor="end">' + maxV + " Stk</text>";
    let summe = 0;
    tage.forEach((t) => {
      const x = Math.min(Math.max(XB(t.ts + 43200), PL + bw / 2), CW - PR - bw / 2) - bw / 2;
      const hoehe = (n) => Math.max(2, (n / maxV) * (H - 11));
      const dat = tag(t.ts);
      if (t.gross) svg += '<rect x="' + x.toFixed(1) + '" y="' + (H - 3 - hoehe(t.gross)).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + hoehe(t.gross).toFixed(1) +
        '" fill="none" stroke="#94a3b8" stroke-width="0.8" stroke-dasharray="2 1"><title>' + esc(dat + ": Großabgang " + t.gross + " Stk (nicht als Verkauf gezählt) – " + namen(t.ts, "gross")) + "</title></rect>";
      if (t.verkauft) {
        summe += t.verkauft;
        svg += '<rect x="' + x.toFixed(1) + '" y="' + (H - 3 - hoehe(t.verkauft)).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + hoehe(t.verkauft).toFixed(1) +
          '" fill="#ff8073" rx="1"><title>' + esc(dat + ": " + t.verkauft + " verkauft – " + namen(t.ts, "verkauf")) + "</title></rect>";
      }
      if (t.zugang) svg += '<path d="M' + (x + bw / 2 - 2.5).toFixed(1) + ",5 L" + (x + bw / 2 + 2.5).toFixed(1) + ",5 L" + (x + bw / 2).toFixed(1) + ',1 Z" fill="#46d39a"><title>' +
        esc(dat + ": Nachschub +" + t.zugang + " Stk – " + namen(t.ts, "zugang")) + "</title></path>";
    });
    return {
      html: '<svg viewBox="0 0 ' + CW + " " + H + '" class="chart klein">' + svg + "</svg>" +
        '<div class="mut streifen">Bestandsdrops: <b>' + summe + "</b> Verkäufe anderer (inkl. Amazon) im Zeitraum · " + (b.beobachtungen || 0) + " Messungen · " +
        (b.seller || 0) + " Verkäufer" + (b.erst ? " · seit " + tag(b.erst) : "") + "</div>",
      legende: '<span><i style="background:#ff8073"></i>Verkäufe (Bestandsdrop)</span><span><i style="background:#46d39a"></i>Nachschub</span>'
    };
  }

  function kurzEur(v) {
    if (v >= 10000) return Math.round(v / 1000) + " T€";
    if (v >= 1000) return (v / 1000).toFixed(1).replace(".", ",") + " T€";
    return (v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 0 : 1).replace(".", ",")) + " €";
  }
  function kurzZahl(n) { return n >= 10000 ? Math.round(n / 1000) + "k" : String(n); }
  function tag(t) { return new Date(t * 1000).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }); }

  function chartLese(root, pre, meta, t) {
    const lese = root.getElementById(pre + "lese");
    const cur = root.getElementById(pre + "cur");
    if (!lese || !meta) return;
    const { cd, X, Y, sicht } = meta;
    const jetzt = t == null, tt = jetzt ? cd.t1 : t;
    const teile = [];
    sicht.forEach(([k, n, f, , dash]) => {
      const v = chartWertBei(cd.reihen[k], tt);
      if (v != null) teile.push('<span class="cw">' + chartStrich(f, dash) + n + " <b>" + eur(v) + "</b></span>");
    });
    const a = chartLetzterBei(cd.ang, tt), b = chartLetzterBei(cd.bsr, tt);
    if (a) teile.push('<span class="cw">Ang. <b>' + ((a.fba_n || 0) + (a.fbm_n || 0)) + "</b></span>");
    if (b) teile.push('<span class="cw">BSR <b>#' + zahl(b.bsr) + "</b></span>");
    const kopf = jetzt ? "Aktuell" : new Date(tt * 1000).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" }) +
      ", " + new Date(tt * 1000).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
    lese.innerHTML = '<b class="ctag">' + kopf + "</b>" + (teile.length ? teile.join("") : '<span class="mut">Keine Werte</span>');
    if (!cur) return;
    if (jetzt) { cur.style.display = "none"; return; }
    const x = X(tt).toFixed(1), lin = root.getElementById(pre + "hl");
    if (lin) { lin.setAttribute("x1", x); lin.setAttribute("x2", x); }
    cur.querySelectorAll("circle[data-ck]").forEach((c) => {
      const v = chartWertBei(cd.reihen[c.getAttribute("data-ck")] || [], tt);
      if (v == null) { c.style.display = "none"; return; }
      c.style.display = ""; c.setAttribute("cx", x); c.setAttribute("cy", Y(v).toFixed(1));
    });
    cur.style.display = "";
  }

  function chartTabelle(root, pre, meta) {
    const box = root.getElementById(pre + "tb");
    if (!box || !meta) return;
    const { cd, sicht } = meta;
    const tage = {};
    cd.ticks.forEach((t) => {
      const d = new Date(t * 1000);
      tage[d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate()] = t;
    });
    const liste = Object.values(tage).sort((a, b) => b - a);
    const mitAng = cd.ang.length > 0, mitBsr = cd.bsr.length > 0;
    let h = '<table class="ctbl"><thead><tr><th scope="col">Tag</th>' +
      sicht.map(([, n]) => '<th scope="col" class="r">' + n + "</th>").join("") +
      (mitAng ? '<th scope="col" class="r">Ang.</th>' : "") +
      (mitBsr ? '<th scope="col" class="r">BSR</th>' : "") + "</tr></thead><tbody>";
    h += liste.map((t) => {
      const a = chartLetzterBei(cd.ang, t), b = chartLetzterBei(cd.bsr, t);
      const dat = new Date(t * 1000).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" });
      return '<tr><th scope="row">' + dat + "</th>" +
        sicht.map(([k]) => '<td class="r">' + eur(chartWertBei(cd.reihen[k], t)) + "</td>").join("") +
        (mitAng ? '<td class="r">' + (a ? (a.fba_n || 0) + (a.fbm_n || 0) : "—") + "</td>" : "") +
        (mitBsr ? '<td class="r">' + (b ? "#" + zahl(b.bsr) : "—") + "</td>" : "") + "</tr>";
    }).join("");
    box.innerHTML = h + "</tbody></table>";
  }

  function chartModalZeichne(root, fokusSel) {
    const cm = root.getElementById("cmodal");
    if (!cm) return;
    if (!S.chartGross || !S.d || !S.d.maerkte) { cm.hidden = true; cm.innerHTML = ""; return; }
    const m = S.d.maerkte[S.mk] || {};
    cm.hidden = false;
    cm.innerHTML = '<div class="cm-dialog" role="dialog" aria-modal="true" aria-label="Preisverlauf Großansicht">' +
      chartBlock(m, true) + "</div>";
    cm.onclick = (e) => { if (e.target === cm) chartModalZu(root); };
    cm.onkeydown = (e) => { if (e.key === "Escape" && !(S.chartModal && S.chartModal.i != null)) { e.preventDefault(); chartModalZu(root); } };
    const zu = root.getElementById("cmZu");
    if (zu) zu.onclick = () => chartModalZu(root);
    cm.querySelectorAll("[data-cmk]").forEach((b) => b.onclick = () => {
      const mk = b.getAttribute("data-cmk");
      if (!mk || mk === S.mk) return;
      S.mk = mk; aodLaden(S.mk); zeichne();
      const neu = root.querySelector('#cmodal [data-cmk="' + mk + '"]'); if (neu) neu.focus();
    });
    cm.querySelectorAll("[data-bereich]").forEach((b) => b.onclick = (e) => {
      e.preventDefault(); S.bereich = +b.getAttribute("data-bereich"); store.set({ axxBereich: S.bereich }); zeichne();
      const neu = root.querySelector('#cmodal [data-bereich="' + S.bereich + '"]'); if (neu) neu.focus();
    });
    chartHover(root, true);
    const f = fokusSel ? root.querySelector(fokusSel) : root.getElementById("cm-wrap") || zu;
    if (f) f.focus();
  }
  function chartModalZu(root) {
    S.chartGross = false;
    const cm = root.getElementById("cmodal");
    if (cm) { cm.hidden = true; cm.innerHTML = ""; }
    const b = root.getElementById("cGross"); if (b) b.focus();
  }

  function chartHover(root, gross) {
    const pre = gross ? "cm-" : "c-";
    const meta = gross ? S.chartModal : S.chart;
    const box = root.getElementById(pre + "box");
    const wrap = root.getElementById(pre + "wrap");
    const svg = root.getElementById(pre + "chart");
    const lese = root.getElementById(pre + "lese");
    if (!gross) {
      const gb = root.getElementById("cGross");
      if (gb) gb.onclick = () => { S.chartGross = true; chartModalZeichne(root); };
      if (S.chartGross) chartModalZeichne(root);
    }
    if (!box || !meta) return;
    const { cd, W, pl, pr } = meta;
    chartLese(root, pre, meta, null);
    const det = root.getElementById(pre + "det");
    if (det) det.addEventListener("toggle", () => { if (det.open) chartTabelle(root, pre, meta); });
    box.querySelectorAll("[data-linie]").forEach((b) => b.onclick = () => {
      const k = b.getAttribute("data-linie");
      const aktiv = REIHEN.filter(([rk]) => cd.reihen[rk] && !S.chartAus[rk]).length;
      if (!S.chartAus[k] && aktiv <= 1) return;
      if (S.chartAus[k]) delete S.chartAus[k]; else S.chartAus[k] = 1;
      store.set({ axxChartAus: S.chartAus });
      zeichne();
      const sel = (gross ? "#cmodal " : "#c-box ") + '[data-linie="' + k + '"]';
      const neu = root.querySelector(sel); if (neu) neu.focus();
    });
    if (!wrap || !svg) return;
    const zeitIdx = (e) => {
      const r = svg.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width * W;
      if (x < pl - 6 || x > W - pr + 6) return null;
      const t = cd.t0 + (Math.min(Math.max(x, pl), W - pr) - pl) / (W - pl - pr) * (cd.t1 - cd.t0);
      let best = 0;
      for (let i = 1; i < cd.ticks.length; i++) if (Math.abs(cd.ticks[i] - t) < Math.abs(cd.ticks[best] - t)) best = i;
      return best;
    };
    const bewegen = (e) => {
      const i = zeitIdx(e); if (i == null) return;
      if (lese) lese.setAttribute("aria-live", "off");
      meta.i = i; chartLese(root, pre, meta, cd.ticks[i]);
    };
    wrap.onpointermove = bewegen;
    wrap.onpointerdown = bewegen;
    wrap.onpointerleave = (e) => { if (e.pointerType === "mouse") { meta.i = null; chartLese(root, pre, meta, null); } };
    wrap.onkeydown = (e) => {
      const n = cd.ticks.length;
      let i = meta.i == null ? n - 1 : meta.i;
      const schritt = e.shiftKey ? Math.max(5, Math.round(n / 10)) : 1;
      if (e.key === "ArrowLeft") i = Math.max(0, i - schritt);
      else if (e.key === "ArrowRight") i = Math.min(n - 1, i + schritt);
      else if (e.key === "Home") i = 0;
      else if (e.key === "End") i = n - 1;
      else if (e.key === "Escape") {
        if (meta.i != null) { meta.i = null; if (lese) lese.setAttribute("aria-live", "polite"); chartLese(root, pre, meta, null); e.preventDefault(); }
        else if (gross) { chartModalZu(root); e.preventDefault(); }
        return;
      } else return;
      e.preventDefault();
      meta.i = i;
      if (lese) lese.setAttribute("aria-live", "polite");
      chartLese(root, pre, meta, cd.ticks[i]);
    };
    wrap.onblur = () => { if (lese) lese.setAttribute("aria-live", "off"); };
  }

  /* --- Verkaeufer: SP-API-Angebote + Namen/Stock aus der Angebotsliste ------------- */
  function verkaeuferListe(m, mk) {
    const api = (m.verkaeufer || []).map((v) => Object.assign({}, v));
    const aod = (S.aod[mk] && S.aod[mk].liste) || [];
    const nachId = {};
    aod.forEach((a) => { if (a.seller_id) nachId[a.seller_id] = a; });
    api.forEach((v) => {
      const a = nachId[v.amazon ? "AMAZON" : v.seller_id] || nachId[v.seller_id];
      if (a) { v.name = v.name || a.name; v.qty = a.qty; v.gedeckelt = a.gedeckelt; a.genutzt = true; }
    });
    // Angebote, die nur in der Angebotsliste stehen (SP-API liefert max. 20)
    aod.filter((a) => !a.genutzt && a.seller_id && a.preis).forEach((a) => api.push({
      seller_id: a.seller_id === "AMAZON" ? "" : a.seller_id, name: a.name, preis: a.preis, fba: a.fba,
      qty: a.qty, gedeckelt: a.gedeckelt, amazon: a.seller_id === "AMAZON", nurAod: true }));
    return api;
  }

  function sellerBlock(m, mk) {
    const liste = verkaeuferListe(m, mk);
    const tld = "amazon." + mk;
    const link = (v) => {
      const name = v.amazon ? "Amazon" : (v.name || v.seller_id || "?");
      if (!v.seller_id || v.amazon) return "<span>" + esc(name) + "</span>";
      return '<a href="https://www.' + tld + "/s?me=" + encodeURIComponent(v.seller_id) + "&marketplaceID=" + MID[mk] +
        '" target="_blank" rel="noopener" title="Storefront öffnen · ' + esc(v.seller_id) + '">' + esc(name) + "</a>";
    };
    const aodStatus = S.aodLaeuft[mk] ? ' <span class="mut">Namen/Stock werden geladen…</span>'
      : (S.aod[mk] && S.aod[mk].fehler ? ' <span class="neg" title="' + esc(S.aod[mk].fehler) + '">Angebotsliste nicht lesbar</span>' : "");
    const zeilen = liste.map((v, i) =>
      '<tr class="' + (v.ich ? "ich" : "") + (v.buybox ? " bb" : "") + '">' +
        "<td>" + (v.buybox ? "👑" : i + 1) + "</td>" +
        '<td class="nm">' + link(v) +
          '<small><span class="kn ' + (v.fba ? "fba" : "fbm") + '">' + (v.fba ? "FBA" : "FBM") + "</span>" + (v.ich ? ' <b class="du">du</b>' : "") +
          (v.feedback != null ? " " + zahl(v.feedback) + " Bew." + (v.positiv != null ? " · " + v.positiv + "%" : "") : "") + "</small></td>" +
        '<td class="r">' + (v.qty == null ? '<span class="mut">?</span>' : v.qty + (v.gedeckelt ? "+" : "")) + "</td>" +
        '<td class="r"><b>' + eur(v.preis) + "</b></td>" +
        '<td class="r" data-preis="' + (v.preis || "") + '" data-fba="' + (v.fba ? 1 : 0) + '">—</td>' +
        '<td class="r roi">—</td></tr>').join("");
    const fr = m.frueher || [];
    const frZ = fr.map((v) => '<div class="fr">' + link(v) + ' <span class="kn ' + (v.fba ? "fba" : "fbm") + '">' + (v.fba ? "FBA" : "FBM") +
      "</span> " + eur(v.preis) + ' <span class="mut">zuletzt ' + new Date(v.zuletzt * 1000).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }) +
      (v.buybox ? " · hatte Buy Box" : "") + "</span></div>").join("");
    return '<details class="box" open><summary>Verkäufer ' + mk.toUpperCase() + " (" + liste.length + ")" + aodStatus + "</summary>" +
      '<table class="sl"><colgroup><col style="width:18px"><col><col style="width:34px">' +
        '<col style="width:64px"><col style="width:64px"><col style="width:46px"></colgroup>' +
        '<tr><th>#</th><th>Verkäufer</th><th class="r">Stock</th><th class="r">Preis</th><th class="r">Profit</th><th class="r">ROI</th></tr>' +
      (zeilen || '<tr><td colspan="6" class="mut">keine Angebote</td></tr>') + "</table>" +
      (fr.length ? '<div class="sub">Früher gesehen (eigene Beobachtung, 180 T)</div>' + frZ : "") +
      "</details>";
  }

  function verdrahten(root) {
    const $ = (id) => root.getElementById(id);
    root.querySelectorAll("input").forEach((i) => i.addEventListener("blur", () => {
      if (S.wartet) { S.wartet = false; setTimeout(zeichne, 0); }
    }));
    root.querySelectorAll(".tab").forEach((b) => b.onclick = () => { S.mk = b.getAttribute("data-mk"); aodLaden(S.mk); zeichne(); });
    root.querySelectorAll(".alle tr[data-mk]").forEach((tr) => tr.onclick = () => { S.mk = tr.getAttribute("data-mk"); aodLaden(S.mk); zeichne(); });
    root.querySelectorAll("[data-kanal]").forEach((b) => b.onclick = () => {
      S.kanal = b.getAttribute("data-kanal");
      store.set({ ["axxKanal:" + S.asin]: S.kanal });          // je Produkt merken, Standard FBA
      zeichne();
    });
    root.querySelectorAll("[data-ust]").forEach((b) => b.onclick = () => {
      S.ustModus = b.getAttribute("data-ust");
      api("/api/ext/einstellungen", "POST", { ust_modus: S.ustModus });     // im Konto: Dashboard + Repricer folgen
      zeichne();
    });
    root.querySelectorAll("[data-ustsatz]").forEach((b) => b.onclick = async () => {      // USt-Satz dieser ASIN wählen (1.9.16)
      const land = b.getAttribute("data-ustland"), asin = S.asin;
      const r = await api("/api/ext/einstellungen", "POST", { ust_asin: { asin, land, satz: +b.getAttribute("data-ustsatz") } });
      if (S.asin !== asin || !(r && r.ok && r.data && r.data.ok)) return;
      AxxRechner.ustGewaehlt(S.d, land, r.data.satz, r.data.quelle);
      zeichne();
    });
    root.querySelectorAll("[data-bereich]").forEach((b) => b.onclick = (e) => {
      e.preventDefault(); S.bereich = +b.getAttribute("data-bereich"); store.set({ axxBereich: S.bereich }); zeichne();
    });
    chartHover(root);
    const ek = $("ek");
    if (ek) {
      if (S.ek != null) ek.value = String(S.ek).replace(".", ",");
      ek.oninput = () => { S.ek = num(ek.value); rechnen(); merkeEk(); };
      $("vk").oninput = () => { S.vk[S.mk] = num($("vk").value); rechnen(); };
      $("menge").oninput = () => { const v = num($("menge").value); S.menge = v && v > 0 ? Math.floor(v) : 1; rechnen(); merkeEk(); };
      $("netto").onchange = (e) => { S.ekNetto = e.target.checked; rechnen(); };
      $("url").oninput = (e) => { S.url = e.target.value.trim(); rechnen(); merkeEk(); };
      if ($("bestellnr")) $("bestellnr").oninput = (e) => { S.kauf.nr = e.target.value; };
      if ($("sku")) $("sku").onchange = (e) => { S.kauf.sku = e.target.value; zeichne(); };
      if ($("cond")) $("cond").onchange = (e) => { S.kauf.cond = e.target.value; };
      if ($("kchan")) $("kchan").onchange = (e) => { S.kauf.chan = e.target.value; };
      ek.onkeydown = (e) => { if (e.key === "Enter" && !(S.d && S.d.abo === false)) einkaufRegistrieren(); };
      if ($("prep")) $("prep").oninput = (e) => { const v = num(e.target.value); S.prep = v == null ? 0 : v; rechnen(); };
      if ($("prep")) $("prep").onchange = () => api("/api/ext/einstellungen", "POST", { prep: S.prep });   // in Arbitragex hinterlegt
      if ($("versand")) $("versand").oninput = (e) => { const v = num(e.target.value); S.versand = v == null ? 0 : v; store.set({ axxVersandFbm: S.versand }); rechnen(); };
      $("ziel").oninput = (e) => { const v = num(e.target.value); if (v == null) return; S.ziel = v; store.set({ axxZielRoi: v }); rechnen(); };
      const t = $("tarif");
      if (t) t.onclick = () => { S.tarif[S.mk] = !S.tarif[S.mk]; zeichne(); };
    }
    if (S.d && S.d.abo === false) {                   // Gratis: Einkauf registrieren ist Abo-Funktion
      $("kauf").innerHTML = "🔒 Einkauf registrieren – mit Abo";
      $("kauf").onclick = () => { merkeEk(); window.open(BASE + "/billing?src=extension-panel", "_blank", "noopener"); };
      return rechnen();
    }
    $("kauf").onclick = einkaufRegistrieren;
    skusLaden(S.asin);
    rechnen();
  }

  /* --- Einkauf direkt im Panel registrieren (11.11.2026, Betreiber: Panel und Popup „genau gleich“) ---
   * Gleiche Felder und derselbe Aufruf wie im Popup (popup.js saveInner): Bestellt bei, Bestellnr., SKU,
   * Zustand einer neuen SKU -> POST /api/purchases. Die SKU-Liste kommt aus /api/ext/skus. */
  const AUFSCHLAG_STD = 30;                          // wie state.markup im Popup
  function kaufFelder() {
    const abo = !(S.d && S.d.abo === false);
    const k = S.kauf;
    let skuOpt = '<option value="">lade SKUs…</option>', zust = "", hinweis = "";
    if (k.d) {
      const d = k.d, waehlen = !d.default && d.unklar && (d.skus || []).length;
      if (k.sku == null) k.sku = d.default || (waehlen ? "__wahl__" : "__neu__");
      const sel = (v) => (v === k.sku ? " selected" : "");
      skuOpt = (waehlen ? '<option value="__wahl__"' + sel("__wahl__") + ">— Bitte SKU wählen —</option>" : "") +
        (d.skus || []).map((x) => '<option value="' + esc(x.sku) + '" data-chan="' + esc(x.channel || "") + '"' + sel(x.sku) + ">" +
          esc(x.sku + " · " + (x.zustand || "?") + " · " + (x.channel || "?") + " · " + (x.price != null ? eur(x.price) : "kein Preis") +
            (x.stock != null ? " · " + x.stock + " Stk" : "")) + "</option>").join("") +
        '<option value="__neu__"' + sel("__neu__") + ">＋ Neue SKU anlegen …</option>";
      const zl = (d.neu_zustaende && d.neu_zustaende.length) ? d.neu_zustaende : [{ value: "new_new", label: "Neu" }];
      if (k.cond == null) k.cond = zl[0].value;
      zust = zl.map((z) => '<option value="' + esc(z.value) + '"' + (z.value === k.cond ? " selected" : "") + ">" + esc(z.label) + "</option>").join("");
      const gew = (d.skus || []).find((x) => x.sku === k.sku);
      hinweis = gew && gew.channel === "FBM"
        ? "⚠️ FBM-SKU: Es wird nur der Preis angepasst, die Versandart bleibt FBM. Für die Einlagerung bei Amazon eine FBA-SKU wählen oder eine neue anlegen."
        : (d.warnung ? "⚠️ " + d.warnung : "");      // „noch keine SKU“ sagt schon die Auswahl „Neue SKU anlegen“ (spart eine Zeile)
    }
    const neu = k.d && k.sku === "__neu__";
    const aktChan = k.chan || (S.kanal === "fbm" ? "FBM" : "FBA");
    return '<div class="kaufgrid">' +
      '<label>Bestellt bei<input id="url" type="url" placeholder="Link zum Einkauf (Shop/Bestellung)" value="' + esc(S.url || "") + '"></label>' +
      '<label>Bestellnr.<input id="bestellnr" type="text" placeholder="optional" value="' + esc(k.nr || "") + '"></label>' +
      (abo ? '<label class="voll">SKU<select id="sku"' + (k.d ? "" : " disabled") + ">" + skuOpt + "</select></label>" +
        (neu ? '<label>Zustand der neuen SKU<select id="cond">' + zust + "</select></label>" +
          '<label>Versandart (Listing)<select id="kchan">' +
            '<option value="FBA"' + (aktChan !== "FBM" ? " selected" : "") + ">FBA (Amazon)</option>" +
            '<option value="FBM"' + (aktChan === "FBM" ? " selected" : "") + ">FBM (Eigenversand)</option>" +
          "</select></label>" : "") +
        (hinweis ? '<div class="skunote voll">' + esc(hinweis) + "</div>" : "") : "") +
      "</div>";
  }
  async function skusLaden(asin) {
    if (S.kauf.laedt || S.kauf.d || (S.d && S.d.abo === false)) return;
    S.kauf.laedt = true;
    const r = await api("/api/ext/skus?asin=" + encodeURIComponent(asin));
    if (S.asin !== asin) return;
    S.kauf.laedt = false;
    S.kauf.d = (r && r.ok && r.data) ? r.data : { skus: [], neu_zustaende: [],
      warnung: "SKU-Liste nicht abrufbar (" + ((r && r.data && r.data.error) || ("HTTP " + (r ? r.status : 0))) + ")" };
    const tippt = S.root && S.root.activeElement && S.root.activeElement.tagName === "INPUT";
    if (S.host && !S.zu && !tippt) zeichne(); else S.wartet = true;
  }
  async function einkaufRegistrieren() {
    const root = S.root, btn = root.getElementById("kauf");
    const melde = (html) => { S.kaufMeldung = html; const el = root.getElementById("kaufres"); if (el) el.innerHTML = html; };
    if (S.kauf.sendet) return;                           // Doppelklick/Enter: nie zwei Einkäufe
    if (S.ek == null || !(S.ek > 0)) { melde('<div class="kerr">Bitte den EK eintragen.</div>'); const e = root.getElementById("ek"); if (e) e.focus(); return; }
    if (!S.kauf.d) { melde('<div class="kerr">Die SKU-Liste lädt noch – gleich noch einmal klicken.</div>'); return; }
    if (S.kauf.sku === "__wahl__") { melde('<div class="kerr">Bitte wähle aus, auf welche SKU der Einkauf gehen soll.</div>'); return; }
    S.kauf.sendet = true; btn.disabled = true; btn.textContent = "Registriere…"; melde("");
    merkeEk();
    const k = S.d.katalog || {}, url = (S.url || location.href).trim();
    let shop = ""; try { shop = new URL(url).hostname.replace(/^www\./, ""); } catch (e) { }
    const listCh = S.kauf.chan || (S.kanal === "fbm" ? "FBM" : "FBA");
    const wahl = S.kauf.sku === "__neu__"
      ? { new_sku: true, condition: S.kauf.cond || "new_new", list_channel: listCh, announce: listCh !== "FBM" }
      : (S.kauf.sku ? { sku: S.kauf.sku } : {});
    const de = (S.d.maerkte.de || {}).buybox;
    // 1.9.33: nur einen selbst geaenderten VK als sell_price schicken; sonst null, damit der Server den eigenen Aufschlag (DEFAULT_MARKUP) anwendet statt die rohe Buy Box zu listen.
    const eigenVk = (S.vk.de != null && S.vk.de > 0 && (de == null || Math.abs(S.vk.de - de) >= 0.005)) ? S.vk.de : null;
    const r = await api("/api/purchases", "POST", Object.assign({
      asin: S.asin, title: k.titel, image: k.bild, source: shop, source_url: url, cost: S.ek, quantity: S.menge || 1,
      sell_price: eigenVk, order_number: (S.kauf.nr || "").trim(), cost_gross: S.ekNetto ? 0 : 1 }, wahl));
    S.kauf.sendet = false;
    if (!r.ok) {
      btn.disabled = false; btn.textContent = "Einkauf registrieren";
      return melde('<div class="kerr">' + esc((r.data && r.data.error) || r.error || ("HTTP " + r.status)) + "</div>");
    }
    if (r.data && r.data.auto === false && r.data.id) await api("/api/purchases/export", "POST", { ids: [r.data.id] });
    const chTxt = (r.data && r.data.list_channel === "FBM") ? "FBM" : "FBA";
    const listTxt = (r.data && r.data.listing_enabled === false) ? "Amazon-Listing ist in den Einstellungen aus" : chTxt + "-Listing läuft";
    S.kaufMeldung = '<div class="kok">Einkauf registriert: ' + (S.menge || 1) + " × " + eur(S.ek) + (r.data && r.data.sku ? ", SKU " + esc(r.data.sku) : "") +
      "<small>" + listTxt + ((r.data && r.data.prep_connected && !r.data.announce_off) ? ", Prep angemeldet" : "") + ". Status siehst du in Arbitragex unter Einkäufe.</small></div>";
    if (r.data && r.data.sku) { S.kauf.d = null; S.kauf.sku = r.data.sku; skusLaden(S.asin); }   // neue SKU erscheint in der Liste
    zeichne();
  }

  /* --- Einstellungen im Panel: dieselben Schalter wie im Popup, gleicher Speicher (chrome.storage) --- */
  function einstellungen() {
    return '<details class="box einst" id="einst"' + (S.einstAuf ? " open" : "") + "><summary>Extension-Einstellungen</summary>" +
      '<label class="er"><input type="radio" name="modus" value="einkauf"' + (S.modus === "einkauf" ? " checked" : "") + "> Nur Einkäufe ankündigen (Einkauf, Listing, Prep)</label>" +
      '<label class="er"><input type="radio" name="modus" value="profit"' + (S.modus !== "einkauf" ? " checked" : "") + "> Zusätzlich Profit-Rechner</label>" +
      '<label class="er sub"><input type="checkbox" id="einst-panel" checked' + (S.modus === "einkauf" ? " disabled" : "") + "> Panel direkt auf der Amazon-Produktseite (wie SellerAmp)</label>" +
      '<label class="er">Prep-/Inbound-Kosten je Stück €<input id="einst-prep" inputmode="decimal" value="' + String(S.prep).replace(".", ",") + '" placeholder="aus Arbitragex"></label>' +
      '<div class="mut">Mit „Nur Einkäufe“ oder ohne den Haken verschwindet das Panel von der Seite; zurück geht es über das Extension-Symbol oben rechts. ' +
      "EFN/Pan-EU und CEP stellst du in Arbitragex unter Einstellungen ein.</div></details>";
  }
  function einstellungenVerdrahten(root) {
    const det = root.getElementById("einst");
    if (det) det.ontoggle = () => { S.einstAuf = det.open; };
    root.querySelectorAll('input[name="modus"]').forEach((r) => r.onchange = () => { S.modus = r.value; store.set({ axxModus: r.value }); });
    const p = root.getElementById("einst-panel");
    if (p) p.onchange = () => store.set({ axxPanel: p.checked });
    const pr = root.getElementById("einst-prep");
    if (pr) pr.onchange = async () => {
      const v = num(pr.value);
      if (v == null || v < 0) return;
      const r = await api("/api/ext/einstellungen", "POST", { prep: v });
      pr.style.outline = r && r.ok ? "2px solid #46d39a" : "2px solid #ff8073";
      if (r && r.ok) { S.prep = v; if (S.d) S.d.prep = v; const f = root.getElementById("prep"); if (f) f.value = String(v).replace(".", ","); rechnen(); }
    };
  }

  function merkeEk() {
    if ((S.ek != null || S.url) && S.asin) store.set({ ["axxEk:" + S.asin]: { ek: S.ek, menge: S.menge, url: S.url || "", ts: Date.now() } });
  }

  function opts(k, kanal) {
    return { kanal: kanal || S.kanal, efn: S.tarif[k], ekNetto: S.ekNetto, land: AxxRechner.einkaufsland(S.url), ekUst: S.d.ek_ust || 19,
             prep: S.prep, ziel: S.ziel, menge: S.menge, versand: S.versand,
             vorsteuer: S.d.gebuehren_vorsteuer !== false, ustModus: S.ustModus };      // Einstellung GEBUEHREN_VORSTEUER
  }

  function rechnen() {
    const root = S.root, d = S.d;
    if (!root || !d) return;
    MPS.forEach((k) => {
      const m = d.maerkte[k] || {};
      const g = root.getElementById("g-" + k), r = root.getElementById("r-" + k);
      if (!m.vorhanden) { if (g) g.textContent = "—"; return; }
      const e = AxxRechner.rechne(m, S.tarif[k], S.vk[k], S.ek, opts(k));
      if (g) g.innerHTML = e.ok && e.gewinn != null ? '<b class="' + (e.gewinn >= 0 ? "pos" : "neg") + '">' + eur(e.gewinn) + "</b>" : "—";
      if (r) r.textContent = e.ok && e.roi != null ? pct(e.roi) : "—";
      if (k !== S.mk) return;
      const lh = root.getElementById("landhinweis");
      if (lh) { const l = AxxRechner.einkaufsland(S.url); lh.textContent = l !== "de" && !S.ekNetto ? "Einkauf im Ausland (" + l.toUpperCase() + "): Brutto-EK ist Kostenbasis, keine deutsche Vorsteuer" : ""; }
      const erg = root.getElementById("erg"), auf = root.getElementById("aufst");
      if (!e.ok) { if (erg) erg.innerHTML = '<span class="neg">' + esc(e.fehler) + "</span>"; if (auf) auf.innerHTML = ""; return; }
      S.kurz = e.gewinn != null ? e.gewinn : null;
      const gebHinweis = (e.fbaFehlt ? '<div class="k voll"><i class="neg">⚠ Amazon liefert für diesen Artikel keine FBA-Gebühr – sie fehlt in der Rechnung, der Gewinn ist zu hoch.</i></div>' : "") +
        (e.fbaTarif ? '<div class="k voll"><i>FBA-Gebühr nach Amazon-Tarifkarte aus den Packmaßen (Amazon nennt keinen Wert).</i></div>' : "") +
        (!e.exakt && S.d.exakt_abruf ? '<div class="k voll"><i>Gebühren für diesen VK werden bei Amazon abgefragt …</i></div>' : "");
      if (erg) erg.innerHTML = gebHinweis +
        '<div class="k gross"><i>Gewinn / Stück</i><b class="' + (e.gewinn == null ? "" : e.gewinn >= 0 ? "pos" : "neg") + '">' + eur(e.gewinn) + "</b></div>" +
        '<div class="k gross"><i>ROI · Nettomarge</i><b>' + pct(e.roi) + " · " + pct(e.marge) + "</b></div>" +
        '<div class="k"><i>Max-EK (' + S.ziel + ' % ROI)</i><b>' + eur(e.maxEk) + "</b></div>" +
        '<div class="k"><i>Break-even VK</i><b>' + eur(e.breakEvenVk) + "</b></div>" +
        (e.menge > 1 ? '<div class="k voll"><i>Gesamt ' + e.menge + " Stück · Einsatz " + eur(e.einsatz) + '</i><b class="' +
          (e.gesamt >= 0 ? "pos" : "neg") + '">' + eur(e.gesamt) + "</b></div>" : "");
      const ekBrutto = e.ekNetto != null ? (AxxRechner.einkaufsland(S.url) !== "de" || S.ekNetto ? e.ekNetto : e.ekNetto * (1 + (S.d.ek_ust || 19) / 100)) : null;
      const vstEk = ekBrutto != null ? ekBrutto - e.ekNetto : 0;
      const vstGeb = e.vorsteuerGebuehren ? e.gebuehrUst : 0;
      const zahllast = e.vkUst - vstEk - vstGeb;
      const vkB = S.vk[S.mk];
      if (auf) auf.innerHTML = (e.gewinn != null ? '<table class="fee rechnung">' +
        '<tr><td>Verkaufspreis</td><td class="r">' + eurGenau(vkB) + "</td></tr>" +
        '<tr><td>− Einkaufspreis' + (ekBrutto !== e.ekNetto ? "" : " (Kostenbasis)") + '</td><td class="r">' + eurGenau(-ekBrutto) + "</td></tr>" +
        '<tr><td>− Amazon-Gebühren netto</td><td class="r">' + eurGenau(-e.gebuehrNetto) + "</td></tr>" +
        '<tr><td>− USt auf Gebühren</td><td class="r">' + eurGenau(-e.gebuehrUst) + "</td></tr>" +
        '<tr><td>− USt-Zahllast <span class="mut">(Verkauf ' + e.vkUstSatz + " %" + (S.mk !== "de" ? (e.vkUstModus === "de" ? " DE-USt" : e.kanal === "fba" && !e.efn ? " lokal" : " OSS") : "") + " " + eurGenau(e.vkUst) + " − EK " + eurGenau(vstEk) + " − Gebühren " + eurGenau(vstGeb) + ')</span></td><td class="r">' + eurGenau(-zahllast) + "</td></tr>" +
        (e.kanal === "fbm" ? '<tr><td>− Versand (FBM)</td><td class="r">' + eurGenau(-e.versand) + "</td></tr>"
                           : (e.prep ? '<tr><td>− Prep / Inbound</td><td class="r">' + eurGenau(-e.prep) + "</td></tr>" : "")) +
        '<tr class="sum"><td>Gewinn</td><td class="r ' + (e.gewinn >= 0 ? "pos" : "neg") + '">' + eurGenau(e.gewinn) + "</td></tr></table>" : "") +
        '<div class="sub">Gebühren einzeln</div><table class="fee">' +
        e.aufstellung.map((z) => "<tr><td>" + esc(z[0]) + '</td><td class="r">' + eur(z[1]) + "</td></tr>").join("") +
        '<tr class="sum"><td>Amazon-Gebühren netto</td><td class="r">' + eur(e.gebuehrNetto) + "</td></tr>" +
        '<tr><td>Break-even EK</td><td class="r">' + eur(e.breakEvenEk) + "</td></tr>" +
        '<tr><td>Auszahlung Amazon</td><td class="r">' + eur(e.auszahlung) + "</td></tr></table>";
      // Profit zu den Preisen der anderen Verkaeufer, mit MEINEM EK
      root.querySelectorAll("td[data-preis]").forEach((td) => {
        const preis = num(td.getAttribute("data-preis"));
        const roiTd = td.nextElementSibling;
        if (!preis || S.ek == null) { td.textContent = "—"; roiTd.textContent = "—"; return; }
        const x = AxxRechner.rechne(m, S.tarif[k], preis, S.ek, opts(k));
        if (!x.ok || x.gewinn == null) { td.textContent = "—"; roiTd.textContent = "—"; return; }
        td.innerHTML = '<b class="' + (x.gewinn >= 0 ? "pos" : "neg") + '">' + eur(x.gewinn) + "</b>";
        roiTd.textContent = x.roi == null ? "—" : Math.round(x.roi) + " %";
      });
    });
    // Echte Gebuehren beim eingetragenen VK nachholen (Preisstufen), kurz nach der letzten Eingabe
    clearTimeout(S.exaktT);
    S.exaktT = setTimeout(() => {
      if (!S.d) return;
      if (S.vk[S.mk] > 0) AxxRechner.exaktHolen(api, S.d, S.mk, S.vk[S.mk], rechnen);
      // Preise der anderen Verkaeufer in der Tabelle: gleiche Stufen-Falle, deshalb ebenfalls echt holen
      const preise = [];
      root.querySelectorAll("td[data-preis]").forEach((td) => { const p = num(td.getAttribute("data-preis")); if (p > 0) preise.push(p); });
      if (preise.length && S.ek != null) AxxRechner.exaktHolenMehr(api, S.d, S.mk, preise, rechnen);
    }, 450);
  }

  function ziehbar(h, zuLeiste) {
    if (!h) return;
    h.onmousedown = (ev) => {
      if (ev.target.tagName === "BUTTON" || ev.target.tagName === "A") return;
      const r = S.host.getBoundingClientRect(), dx = ev.clientX - r.left, dy = ev.clientY - r.top;
      const mv = (e) => {
        S.host.style.right = "auto"; S.host.style.bottom = "auto";
        S.host.style.left = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - dx)) + "px";
        S.host.style.top = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dy)) + "px";
      };
      const up = () => {
        document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up);
        const pos = { left: parseInt(S.host.style.left, 10), top: parseInt(S.host.style.top, 10) };
        if (zuLeiste) { S.posZu = pos; store.set({ axxLeistePos: pos }); }
        else { S.pos = pos; store.set({ axxPanelPos: pos }); }
        lage();
      };
      document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
      ev.preventDefault();
    };
  }

  /* --- Shop-Produktseite: EAN erkennen -> Amazon-Listing -> Panel wie auf Amazon -------- */
  async function shopAsin() {
    const sx = window.__axxSeite;
    if (!sx || sx.amazon) return null;
    let ean = null, produkt = false;
    try { produkt = sx.produkt(); ean = sx.ean(); } catch (e) { return null; }
    if (!produkt || !ean) return "__nochnicht__";        // Shop-SPA laedt Produktdaten oft spaeter
    let preis = null;
    try { preis = sx.preis(); } catch (e) { }
    S.shop = { ean, preis, url: location.href.split("#")[0] };
    const key = "axxEan:" + ean;
    const st = await store.get([key]);
    if (st[key] && Date.now() - st[key].ts < (st[key].asin ? 7 : 1) * 86400000) return st[key].asin;   // auch „kein Listing“ 1 Tag merken
    const r = await api("/api/ext/ean-suche?ean=" + encodeURIComponent(ean));
    if (r.status === 401) return "__login__";
    if (!r.ok || !r.data || r.data.error) { S.shopFehler = (r.data && r.data.error) || ("HTTP " + r.status); return "__fehler__"; }
    const t = r.data.treffer || [];
    if (t.length === 1) { store.set({ [key]: { asin: t[0].asin, ts: Date.now() } }); return t[0].asin; }
    if (t.length > 1) { S.treffer = t; return "__wahl__"; }
    store.set({ [key]: { asin: null, ts: Date.now() } });
    return null;                                   // kein Amazon-Listing zur EAN -> kein Panel
  }

  function zeichneWahl(fehlerText) {
    const root = host(); lage();
    const p = root.getElementById("p"); p.className = "p";
    const kopf = '<div class="kopf wahl" id="kopf"><div class="noimg">AX</div><div class="ktxt"><b>' + (S.treffer && !fehlerText ? "Amazon-Listing wählen" : "Arbitragex") + "</b>" +
      (S.suchText ? '<span title="' + esc(S.suchText) + '">„' + esc(S.suchText) + "“</span>" : "") +
      (S.shop && S.shop.ean ? '<span class="codes"><button class="cp ean" data-copy="' + esc(S.shop.ean) + '" title="EAN kopieren">' + esc(S.shop.ean) + "</button></span>" : "") +
      '</div><div class="kbtn"><button id="x" title="Schließen">×</button></div></div>';
    const liste = fehlerText ? '<div class="msg">' + fehlerText + "</div>"
      : '<div class="msg">' + esc(S.wahlText || "Mehrere Amazon-Listings zu dieser EAN – welches rechnen?") + "</div>" +
        '<div class="trl">' + (S.treffer || []).map((t, i) => '<button class="tr" data-i="' + i + '">' +
          (t.bild ? '<img src="' + esc(t.bild) + '" alt="">' : '<span class="noimg">📦</span>') +
          '<span class="trt"><b>' + esc(t.titel || t.asin) + "</b><small>" + esc(t.asin) + (t.marke ? " · " + esc(t.marke) : "") +
          (t.bsr ? " · BSR #" + zahl(t.bsr) : "") + "</small></span></button>").join("") + "</div>";
    p.innerHTML = kopf + '<div class="inhalt">' + liste + "</div>";
    root.getElementById("x").onclick = () => entfernen();
    kopierbar(root);
    ziehbar(root.getElementById("kopf"), false);
    root.querySelectorAll(".tr").forEach((b) => b.onclick = () => {
      const t = S.treffer[+b.getAttribute("data-i")];
      if (S.shop && S.shop.ean) store.set({ ["axxEan:" + S.shop.ean]: { asin: t.asin, ts: Date.now() } });
      laden(t.asin);
    });
  }

  /* --- Laden -------------------------------------------------------------- */
  async function laden(asin, frisch) {
    S.asin = asin; S.d = null; S.fehler = null; S.mk = seitenMarkt(); S.aod = {}; S.frisch = {}; S.kurz = null; S.ean = null; S.eanFehlt = false;
    S.kauf = { d: null, sku: null, cond: null, nr: "", laedt: false, sendet: false }; S.kaufMeldung = "";
    // EAN gesondert holen: der Katalogaufruf der Analyse nennt sie nicht immer, die Leiste braucht sie sofort
    api("/api/ext/ean?asin=" + encodeURIComponent(asin)).then((r) => {
      if (S.asin !== asin || !r || !r.ok || !r.data) return;
      if (r.data.ean) S.ean = String(r.data.ean); else S.eanFehlt = true;     // Amazon führt keine (z. B. GTIN-Befreiung)
      const tippt = S.root && S.root.activeElement && S.root.activeElement.tagName === "INPUT";
      if (S.host && !tippt) zeichne();
    });
    if (!frisch) { S.ek = null; S.url = ""; }
    zeichne();
    aodLaden(S.mk);                                // parallel: Namen + Stock der Seite
    const seite = seitenMarkt();
    const r = await api("/api/ext/profit?asin=" + encodeURIComponent(asin) + "&maerkte=" + seite + (frisch ? "&frisch=1" : ""));
    if (S.asin !== asin) return;                  // inzwischen andere Seite
    if (r.status === 401) {
      S.fehler = '<b>Kostenloser Profit-Rechner</b><br>E-Mail bestätigen, Amazon-Konto verbinden – fertig.<br>' +
        '<a class="kauf" style="display:block;text-align:center;text-decoration:none;margin:8px 0 4px" href="' + BASE + '/amazon-profit-rechner#start" target="_blank" rel="noopener">Kostenlos registrieren</a>' +
        '<a href="' + BASE + '/login" target="_blank" rel="noopener">Ich habe ein Konto – anmelden</a>';
    } else if (r.status === 400 && r.data && /Amazon-Konto/.test(r.data.error || "")) {
      S.fehler = '<b>Amazon-Konto verbinden</b><br>Der Rechner nutzt die Gebühren deines eigenen Verkäuferkontos (nur Lesezugriff).<br>' +
        '<a class="kauf" style="display:block;text-align:center;text-decoration:none;margin-top:8px" href="' + BASE + '/extension" target="_blank" rel="noopener">Jetzt verbinden</a>';
    } else if (r.status === 402) {
      S.fehler = 'Für dieses Konto ist der Profit-Rechner gerade nicht verfügbar. <a href="' + BASE + '/extension" target="_blank" rel="noopener">Konto ansehen</a>';
    } else if (!r.ok || !r.data || r.data.error) {
      S.fehler = "Profit nicht verfügbar: " + esc((r.data && r.data.error) || r.error || ("HTTP " + r.status));
    } else {
      const d = r.data;
      S.d = d; S.ekNetto = !!d.ek_netto; S.prep = d.prep || 0; S.ustModus = d.ust_modus || "oss";
      MPS.forEach((k) => { const m = d.maerkte[k] || {}; S.vk[k] = m.buybox != null ? m.buybox : null; S.tarif[k] = !!m.efn_vorwahl; });
      if (!(d.maerkte[S.mk] || {}).vorhanden) S.mk = MPS.find((k) => (d.maerkte[k] || {}).vorhanden) || S.mk;
      const st = await store.get(["axxEk:" + asin, "axxKanal:" + asin, "axxVersandFbm"]);
      const v = st["axxEk:" + asin];
      if (!frisch && v && Date.now() - v.ts < 30 * 24 * 3600 * 1000) { S.ek = v.ek; S.menge = v.menge || 1; S.url = v.url || ""; }
      if (S.shop) {                                  // Shop-Produktseite: dieser Shop ist die Bezugsquelle
        if (!S.url) S.url = S.shop.url;
        if (S.ek == null && S.shop.preis) S.ek = S.shop.preis;
      }
      S.kanal = st["axxKanal:" + asin] === "fbm" ? "fbm" : "fba";
      if (st.axxVersandFbm != null) S.versand = Number(st.axxVersandFbm);
      frischAnwenden();
      zeichne();
      // Stufe 2: alle Märkte (FR/IT/ES …) nachladen, Eingaben bleiben stehen
      S.ladeRest = true;
      const voll = await api("/api/ext/profit?asin=" + encodeURIComponent(asin) + (frisch ? "&frisch=1" : ""));
      S.ladeRest = false;
      if (S.asin !== asin) return;
      if (voll.ok && voll.data && !voll.data.error) {
        const alt = S.d;
        S.d = voll.data;
        frischAnwenden();
        MPS.forEach((k) => {
          const m = S.d.maerkte[k] || {};
          if (!(alt.maerkte || {})[k]) { S.vk[k] = m.buybox != null ? m.buybox : null; S.tarif[k] = !!m.efn_vorwahl; }
        });
      } else {
        S.restFehler = (voll.data && voll.data.error) || voll.error || ("HTTP " + voll.status);
      }
      if (S.root && document.activeElement === S.host && S.root.activeElement && S.root.activeElement.tagName === "INPUT") {
        S.wartet = true; rechnen(); return;      // nicht mitten im Tippen neu zeichnen
      }
    }
    zeichne();
  }

  async function pruefen() {
    const st = await store.get(["axxModus", "axxPanel", "axxPanelZu", "axxPanelPos", "axxLeistePos", "axxZielRoi", "axxBereich", "axxChartAus"]);
    if (st.axxBereich) S.bereich = Number(st.axxBereich);
    if (st.axxChartAus && typeof st.axxChartAus === "object") S.chartAus = Object.assign({}, st.axxChartAus);
    const an = (st.axxModus || "profit") === "profit" && st.axxPanel !== false;
    S.modus = st.axxModus || "profit";
    let asin = IST_AMAZON ? seitenAsin() : null;
    // 11.11.2026 (Betreiber: „Amazon-Listing auf jeder Produktseite finden, aber nur beim Klick auf die Extension“):
    // Auf Shop-Seiten startet das Panel nicht mehr von selbst. Die Suche per EAN läuft im Popup (Klick aufs Symbol).
    if (an && !IST_AMAZON && SHOP_AUTOMATIK) {
      if (S.asin && S.shop && S.shop.url === location.href.split("#")[0]) return;   // schon geladen
      asin = await shopAsin();
      if (asin === "__nochnicht__") {
        S.versuche = (S.versuche || 0) + 1;
        if (S.versuche <= 4) setTimeout(pruefen, 1500 * S.versuche);
        asin = null;
      } else S.versuche = 0;
      if (asin === "__wahl__") { S.zu = false; return zeichneWahl(); }
      if (asin === "__login__") { S.fehler = '<b>Kostenloser Profit-Rechner</b><br><a href="' + BASE + '/amazon-profit-rechner#start" target="_blank" rel="noopener">Kostenlos registrieren</a> · <a href="' + BASE + '/login" target="_blank" rel="noopener">anmelden</a>'; S.asin = "-"; return zeichne(); }
      if (asin === "__fehler__") return zeichneWahl("EAN-Suche fehlgeschlagen: " + esc(S.shopFehler || ""));
    }
    if (S.menue && S.menueUrl === location.href) return;            // per Rechtsklick geöffnet: bleibt, bis die Seite wechselt
    S.menue = false;
    if (!an || !asin) { entfernen(); S.asin = null; return; }
    S.zu = !!st.axxPanelZu;
    S.pos = st.axxPanelPos || null;
    S.posZu = st.axxLeistePos || null;
    if (st.axxZielRoi != null) S.ziel = Number(st.axxZielRoi);
    if (asin !== S.asin || !S.host) laden(asin);
  }

  /* --- Rechtsklick-Menü (1.9.18) -------------------------------------------------
   * background.js schickt die Kennung (ASIN, EAN oder Titel). Das Panel klappt auf DIESER Seite auf –
   * kein neuer Tab: ASIN -> direkt rechnen; EAN/Titel -> Katalogsuche über das eigene Konto,
   * ein Treffer -> rechnen, mehrere -> Auswahl (nie raten). Auf Shop-Seiten ist der Shop die Bezugsquelle. */
  async function menue(m) {
    const st = await store.get(["axxPanelPos", "axxLeistePos", "axxZielRoi", "axxBereich", "axxModus", "axxChartAus"]);
    S.modus = st.axxModus || "profit";
    S.pos = st.axxPanelPos || null; S.posZu = st.axxLeistePos || null;
    if (st.axxZielRoi != null) S.ziel = Number(st.axxZielRoi);
    if (st.axxBereich) S.bereich = Number(st.axxBereich);
    if (st.axxChartAus && typeof st.axxChartAus === "object") S.chartAus = Object.assign({}, st.axxChartAus);
    S.zu = false; S.menue = true; S.menueUrl = location.href; S.treffer = null; S.wahlText = "";
    S.suchText = m.art === "text" ? String(m.wert).slice(0, 120) : "";      // ASIN/EAN stehen schon als Kennung im Kopf
    S.shop = null;
    if (!IST_AMAZON) {
      let preis = null, ean = m.art === "ean" ? m.wert : "";
      const sx = window.__axxSeite;
      try { if (sx && sx.produkt()) { preis = sx.preis(); ean = ean || sx.ean() || ""; } } catch (e) { }
      S.shop = { ean, preis, url: location.href.split("#")[0] };
    }
    if (m.art === "asin") return laden(m.wert);
    S.asin = null; S.d = null;
    zeichneWahl('<span class="spin"></span> Suche Amazon-Listing zu „' + esc(String(m.wert).slice(0, 80)) + "“ …");
    const r = await api("/api/ext/ean-suche?" + (m.art === "ean" ? "ean=" : "q=") + encodeURIComponent(m.wert));
    if (r.status === 401) return zeichneWahl('<b>Kostenloser Profit-Rechner</b><br><a href="' + BASE + '/amazon-profit-rechner#start" target="_blank" rel="noopener">Kostenlos registrieren</a> · <a href="' + BASE + '/login" target="_blank" rel="noopener">anmelden</a>');
    if (!r.ok || !r.data || r.data.error) return zeichneWahl("Suche fehlgeschlagen: " + esc((r.data && r.data.error) || r.error || ("HTTP " + r.status)));
    const t = r.data.treffer || [];
    if (!t.length) return zeichneWahl("Kein Amazon-Listing zu „" + esc(String(m.wert).slice(0, 80)) + "“ gefunden.");
    if (t.length === 1 && m.art === "ean") return laden(t[0].asin);
    S.treffer = t;
    S.wahlText = m.art === "ean" ? "Mehrere Amazon-Listings zu dieser EAN – welches rechnen?" : "Welches Amazon-Listing rechnen?";
    zeichneWahl();
  }
  try {
    chrome.runtime.onMessage.addListener((msg, _s, antwort) => {
      if (!msg || msg.type !== "axx-menue" || !msg.wert) return;
      menue(msg);
      antwort({ panel: true });                    // 1.9.21: Hintergrund weiß, dass das Panel da ist (kein Nachladen nötig)
    });
    // 1.9.24: Auftrag „Bestand nachmessen“ vom Service-Worker (nur auf Amazon-Seiten, nur gültige ASIN + Markt)
    chrome.runtime.onMessage.addListener((msg, _s, antwort) => {
      if (!msg || msg.type !== "axx-nachmessen" || !IST_AMAZON) return;
      if (!/^[A-Z0-9]{10}$/.test(String(msg.asin || "")) || !MPS.includes(msg.mk)) { antwort({ nachmessen: true, ok: false, fehler: "ungültig", status: 0 }); return; }
      aodNachmessen(msg.asin, msg.mk).then(antwort)
        .catch((e) => antwort({ nachmessen: true, ok: false, fehler: String(e && e.message || e), status: 0 }));
      return true;                                 // Antwort kommt später
    });
  } catch (e) { }

  // Einstellungen live (Popup → ⚙) und Seitenwechsel ohne Neuladen (Varianten-Klick)
  try { chrome.storage.onChanged.addListener((ch) => { if (ch.axxModus || ch.axxPanel) pruefen(); }); } catch (e) { }
  let letzteUrl = location.href;
  setInterval(() => { if (location.href !== letzteUrl) { letzteUrl = location.href; S.versuche = 0; pruefen(); } }, 1000);
  pruefen();

  const CSS = `
  /* Gestaltung 10.11.2026: ruhiges Messinstrument statt Kachelwand. Dunkle Fläche, weil Amazon- und
     Shop-Seiten weiß sind (Betreiber: helles Panel „unpassend“) — das Panel muss sich abheben.
     Grün nur für Geld im Plus, Rot nur für Minus. Zahlen tabellarisch, Trennlinien statt Rahmen. */
  :host { all: initial; }
  * { box-sizing: border-box; }
  .p { --papier: #151c19; --flaeche: #1f2824; --tinte: #f0f3f0; --leise: #98a59e; --linie: #2c3732; --plus: #46d39a; --minus: #ff8073;
       --feld: #0e1411; --rand: #36433d; --heller: #2a3530; --akzent: #1f9d6b;
       width: 372px; max-height: calc(100vh - 76px); overflow-y: auto; overscroll-behavior: contain; background: var(--papier); color: var(--tinte);
       font: 12.5px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif; font-variant-numeric: tabular-nums;
       border-radius: 14px; border: 1px solid #0b100e; box-shadow: 0 22px 50px -12px rgba(8,12,10,.55), 0 2px 8px rgba(8,12,10,.25);
       scrollbar-width: thin; scrollbar-color: #3a4741 transparent; }
  .p.zu { width: auto; max-height: none; background: none; box-shadow: none; border: 0; overflow: visible; }
  button, input, a { font-family: inherit; }
  a { color: var(--tinte); }

  /* eingeklappt: schmale helle Leiste */
  .leiste { display: flex; align-items: stretch; background: var(--papier); border: 1px solid #0b100e; border-radius: 11px; overflow: hidden;
            box-shadow: 0 12px 28px -10px rgba(8,12,10,.6), 0 1px 4px rgba(8,12,10,.3); font-size: 12.5px; line-height: 1; }
  .leiste button, .leiste a, .leiste span { border: 0; background: transparent; color: var(--tinte); padding: 0 11px; height: 36px; cursor: pointer;
            font: inherit; white-space: nowrap; text-decoration: none; display: flex; align-items: center; }
  .leiste button { font-weight: 600; letter-spacing: .02em; cursor: copy; }
  .leiste button:hover, .leiste a:hover { background: var(--flaeche); }
  .leiste .ax { background: var(--akzent); color: #fff; font-weight: 700; letter-spacing: .04em; padding: 0 12px; cursor: pointer; }
  .leiste .ax:hover { background: #24b079; }
  .leiste .ean { color: var(--leise); font-weight: 500; padding-left: 2px; }
  .leiste a { color: var(--leise); border-left: 1px solid var(--linie); font-weight: 500; }
  .leiste a:hover { color: var(--tinte); }
  .leiste .lg { font-weight: 700; border-left: 1px solid var(--linie); cursor: default; }
  .leiste .lg.pos { color: var(--plus); } .leiste .lg.neg { color: var(--minus); }
  .leiste .grip { cursor: move; color: #5d6a63; padding: 0 9px; border-left: 1px solid var(--linie); }

  /* Kopf */
  .kopf { display: flex; align-items: flex-start; gap: 12px; padding: 12px 12px 10px 14px; cursor: move; background: var(--papier);
          border-radius: 14px 14px 0 0; position: sticky; top: 0; z-index: 3; }
  .kopf img, .kopf .noimg { width: 70px; height: 70px; object-fit: contain; background: #fff; border: 0; border-radius: 10px;
          flex: 0 0 auto; display: flex; align-items: center; justify-content: center; font-size: 26px; padding: 5px; }
  .ktxt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .ktxt b { padding-right: 2px; }
  .ktxt b { font-size: 13px; font-weight: 600; line-height: 1.3; letter-spacing: -.005em; display: -webkit-box; -webkit-line-clamp: 2;
            -webkit-box-orient: vertical; overflow: hidden; }
  .ktxt span { font-size: 11px; color: var(--leise); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .codes { display: flex; gap: 4px; flex-wrap: nowrap; }
  .cp { background: var(--flaeche); border: 0; color: var(--tinte); font-size: 10.5px; font-weight: 600; letter-spacing: 0; border-radius: 6px;
        padding: 3px 5px; cursor: copy; white-space: nowrap; }
  .cp:hover { background: var(--heller); }
  .cp.ean { color: var(--leise); font-weight: 500; }
  .codes .ohne { font-size: 11px; color: var(--leise); padding: 3px 2px; cursor: help; }
  .kbtn { display: flex; gap: 0; margin: -6px -6px 0 -4px; position: absolute; top: 12px; right: 12px; }
  .ktxt b { padding-right: 84px; }
  .kbtn button { background: transparent; color: var(--leise); border: 0; border-radius: 7px; width: 22px; height: 26px; padding: 0; cursor: pointer; font-size: 15px; line-height: 1; }
  .kbtn button:hover { background: var(--flaeche); color: var(--tinte); }
  .links { display: grid; grid-template-columns: repeat(3, 1fr); margin: 0 14px; border: 1px solid var(--linie); border-radius: 9px; overflow: hidden; }
  .links a { text-align: center; padding: 7px 0; font-size: 12px; font-weight: 600; text-decoration: none; color: var(--tinte); }
  .links a + a { border-left: 1px solid var(--linie); }
  .links a:hover { background: var(--flaeche); }

  .inhalt { padding: 10px 14px 14px; }
  .msg { padding: 12px 0; color: var(--leise); line-height: 1.55; }
  .kopf.wahl { align-items: center; }
  .kopf.wahl .noimg { padding: 0; flex: 0 0 34px; width: 34px; height: 34px; border-radius: 9px; background: var(--plus); color: #0e1512; font-size: 12px; font-weight: 800;
    display: flex; align-items: center; justify-content: center; letter-spacing: .3px; }
  .trl { display: flex; flex-direction: column; gap: 6px; }
  .tr { display: flex; align-items: center; gap: 10px; width: 100%; box-sizing: border-box; text-align: left; background: var(--flaeche);
    border: 1px solid var(--linie); border-radius: 10px; padding: 7px 9px; margin: 0; cursor: pointer; color: var(--tinte); font: inherit; }
  .tr:hover { border-color: var(--plus); background: #24302b; }
  .tr img, .tr .noimg { width: 44px; height: 44px; flex: 0 0 44px; object-fit: contain; background: #fff; border-radius: 7px;
    display: flex; align-items: center; justify-content: center; font-size: 20px; }
  .tr .trt { display: block; min-width: 0; flex: 1 1 auto; }
  .tr b { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 12px; font-weight: 600; line-height: 1.35; white-space: normal; }
  .tr small { display: block; margin-top: 2px; font-size: 10.5px; color: var(--leise); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .msg b { color: var(--tinte); font-size: 14px; }
  .msg a { color: var(--tinte); font-weight: 600; }
  .spin { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--linie); border-top-color: var(--tinte); border-radius: 50%;
          animation: s .7s linear infinite; vertical-align: -2px; }
  @keyframes s { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spin { animation-duration: 2.4s; } }

  /* Märkte als Reiter */
  .tabs { display: grid; grid-template-columns: repeat(4, 1fr); border-bottom: 1px solid var(--linie); margin-bottom: 9px; }
  .tab { border: 0; background: none; padding: 7px 0 8px; font-size: 12px; font-weight: 600; cursor: pointer; color: var(--leise); border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .tab:hover { color: var(--tinte); }
  .tab.an { color: var(--tinte); border-bottom-color: var(--tinte); }
  .tab.aus { opacity: .4; }

  /* Kennzahlen: Raster mit Haarlinien statt einzelner Kästen */
  .grid { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid var(--linie); border-radius: 10px; overflow: hidden; margin-bottom: 8px; }
  .g3 { grid-template-columns: 1fr 1fr 1.25fr; }
  .k { padding: 6px 10px 7px; min-width: 0; box-shadow: 1px 0 0 var(--linie), 0 1px 0 var(--linie); }
  .k i { display: block; font-style: normal; font-size: 10.5px; color: var(--leise); line-height: 1.3; margin-bottom: 1px; }
  .k b { font-size: 13px; font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
  .k small { display: block; font-size: 10.5px; font-weight: 400; color: var(--leise); }
  .badgetxt { color: var(--plus); }
  .abo { color: var(--tinte); text-decoration: underline; font-weight: 600; }

  /* Kalkulation */
  .eingabe { margin: 2px 0 12px; }
  .ehead { display: none; }
  .fakten { display: grid; grid-template-columns: 1fr 1fr 1.25fr; border: 1px solid var(--linie); border-radius: 10px; overflow: hidden; margin-bottom: 9px; }
  .fk { padding: 5px 9px 6px; min-width: 0; box-shadow: 1px 0 0 var(--linie), 0 1px 0 var(--linie); }
  .fk i { display: block; font-style: normal; font-size: 10px; color: var(--leise); line-height: 1.3; }
  .fk b { display: block; font-size: 13px; font-weight: 600; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fk small { display: block; font-size: 10px; color: var(--leise); line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fk small a { color: var(--leise); }
  .fk .mut { font-size: 12px; }
  .ein { display: grid; grid-template-columns: 1.15fr 1.15fr .7fr; gap: 8px; margin-bottom: 7px; }
  .ein label, .url { display: flex; flex-direction: column; font-size: 10.5px; color: var(--leise); gap: 3px; }
  input { font-size: 14px; font-weight: 600; border: 1px solid var(--rand); border-radius: 8px; padding: 6px 9px; width: 100%; background: var(--feld); color: var(--tinte);
          font-variant-numeric: tabular-nums; }
  input::placeholder { color: #66736c; font-weight: 400; }
  input:hover { border-color: #4a5952; }
  input:focus { outline: 2px solid var(--plus); outline-offset: -1px; border-color: var(--plus); }
  button:focus-visible, a:focus-visible { outline: 2px solid var(--plus); outline-offset: 1px; }
  .opt { display: flex; gap: 6px 10px; align-items: center; font-size: 11.5px; color: var(--leise); margin-bottom: 7px; flex-wrap: wrap; }
  .opt label { display: flex; align-items: center; gap: 5px; }
  .opt input[type=checkbox] { width: 14px; height: 14px; margin: 0; accent-color: var(--akzent); }
  .opt input:not([type]) { width: 40px; padding: 4px 6px; font-size: 12px; }
  .opt { flex-wrap: nowrap; white-space: nowrap; }
  .opt { gap: 6px 6px; flex-wrap: wrap; }
  .opt input:not([type]) { width: 36px; padding: 4px 5px; }
  .opt .seg button { padding: 3px 8px; }
  .opt label { gap: 4px; }
  .lz { display: flex; justify-content: space-between; align-items: center; gap: 4px; }
  .ustk { border: 0; background: var(--heller); color: var(--tinte); border-radius: 5px; padding: 0 5px; font-size: 10px; font-weight: 600; line-height: 14px; cursor: pointer; }
  .ustk:hover { background: #3a4741; }
  .ustg { display: inline-flex; gap: 3px; }
  .ustk.fest { cursor: default; }
  .ustk.fest:hover { background: var(--heller); }
  .ustk.warn { box-shadow: inset 0 0 0 1px #d9a441; }
  .seg { display: inline-flex; background: var(--flaeche); border-radius: 8px; padding: 2px; }
  .seg button { border: 0; background: transparent; color: var(--leise); padding: 3px 10px; font-size: 11.5px; font-weight: 600; cursor: pointer; border-radius: 6px; }
  .seg button.an { background: #3a4741; color: var(--tinte); }
  .seg.mini { margin-left: 6px; }
  .seg.mini button { padding: 2px 7px; font-size: 10.5px; }
  .tarif { border: 1px solid var(--rand); background: var(--feld); color: var(--tinte); border-radius: 7px; padding: 3px 8px; font-size: 11.5px; font-weight: 600; cursor: pointer; }
  .tarif:hover { background: var(--flaeche); }
  .url input { font-size: 12px; font-weight: 400; padding: 6px 9px; }
  .landhinweis { font-size: 11px; color: #e5b45a; margin-top: 5px; }
  .kaufgrid { display: grid; grid-template-columns: 1.6fr 1fr; gap: 6px 8px; margin-bottom: 8px; }
  .kaufgrid label { display: flex; flex-direction: column; font-size: 10.5px; color: var(--leise); gap: 3px; min-width: 0; }
  .kaufgrid .voll { grid-column: 1 / -1; }
  .kaufgrid input, select { font-size: 12px; font-weight: 400; padding: 6px 9px; border: 1px solid var(--rand); border-radius: 8px; width: 100%;
                            background: var(--feld); color: var(--tinte); font-family: inherit; }
  select { font-weight: 600; color-scheme: dark; }
  select:focus { outline: 2px solid var(--plus); outline-offset: -1px; }
  .skunote { font-size: 11px; color: #e5b45a; line-height: 1.3; }
  .kaufres:empty { display: none; }
  .kaufres { margin-bottom: 8px; }
  .kok, .kerr { font-size: 12px; font-weight: 600; padding: 8px 10px; border-radius: 9px; }
  .kok { background: rgba(70,211,154,.14); color: var(--plus); }
  .kok small { display: block; font-weight: 400; margin-top: 3px; color: var(--tinte); }
  .kerr { background: rgba(255,128,115,.14); color: var(--minus); }
  .kauf:disabled { opacity: .6; cursor: default; }
  .einst { margin-top: 10px; }
  .einst .er { display: flex; gap: 7px; align-items: center; margin: 6px 0; font-size: 12px; }
  .einst .er.sub { margin-left: 20px; }
  .einst .er input[type=radio], .einst .er input[type=checkbox] { width: 14px; height: 14px; margin: 0; accent-color: var(--akzent); flex: 0 0 auto; }
  .einst .er input:not([type]) { width: 64px; padding: 4px 7px; font-size: 12px; margin-left: auto; }
  .einst .mut { display: block; line-height: 1.45; margin: 6px 0 4px; }
  .landhinweis:empty { display: none; }

  /* Ergebnis: die eine laute Stelle */
  .erg { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; background: var(--flaeche); border-radius: 10px; padding: 7px 12px 7px; margin: 7px 0 7px; }
  .erg:empty { display: none; }
  .erg .k { padding: 0; box-shadow: none; }
  .erg .k i { font-size: 10.5px; }
  .erg .k b { font-size: 13px; }
  .erg .k.gross { padding-bottom: 3px; }
  .erg .k.gross b { font-size: 17px; font-weight: 600; letter-spacing: -.01em; }
  .erg .k.gross:first-of-type b, .erg .k.voll + .k.gross b { font-size: 24px; font-weight: 700; letter-spacing: -.02em; line-height: 1.15; }
  .erg .k.voll { grid-column: 1 / -1; padding-bottom: 6px; }
  .erg .k.voll i { font-size: 11px; line-height: 1.4; }
  .erg > .neg { grid-column: 1 / -1; font-size: 12px; }
  .kauf { width: 100%; background: var(--akzent); color: #fff; border: 0; border-radius: 9px; padding: 10px; font-size: 13px; font-weight: 600; cursor: pointer; }
  .kauf:hover { background: #24b079; }
  a.kauf { color: #fff; }

  /* Aufklappbare Abschnitte und Tabellen */
  .box { border-top: 1px solid var(--linie); padding: 9px 0 2px; margin: 0; font-size: 12px; }
  .box summary { cursor: pointer; font-weight: 600; font-size: 13px; list-style: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-bottom: 7px; }
  .box summary::-webkit-details-marker { display: none; }
  .box summary::after { content: ""; width: 7px; height: 7px; border-right: 1.5px solid var(--leise); border-bottom: 1.5px solid var(--leise);
                        transform: rotate(-45deg); flex: 0 0 auto; margin-right: 3px; }
  .box[open] summary::after { transform: rotate(45deg); margin-top: -3px; }
  .box summary .mut, .box summary .neg { font-weight: 400; margin-right: auto; }
  table { width: 100%; border-collapse: collapse; }
  .fee { margin-bottom: 8px; }
  .fee td { padding: 4px 0; border-top: 1px solid var(--linie); font-size: 12px; }
  .fee tr:first-child td { border-top: 0; }
  .fee tr.sum td { font-weight: 600; border-top: 1px solid #6c7a73; }
  .rechnung td { font-size: 11.5px; }
  .rechnung .mut { display: block; font-size: 10.5px; line-height: 1.35; }
  .r { text-align: right; white-space: nowrap; vertical-align: top; }
  .sub { margin: 4px 0 2px; font-size: 11px; font-weight: 600; color: var(--leise); }
  .alle { font-size: 12px; margin: 2px 0 10px; }
  .alle th { font-size: 10.5px; font-weight: 400; color: var(--leise); text-align: left; padding: 4px 6px; }
  .alle td { padding: 6px; border-top: 1px solid var(--linie); cursor: pointer; }
  .alle tr:hover td { background: #1a2320; }
  .alle tr.an td { background: var(--flaeche); font-weight: 600; }
  .sl { font-size: 11.5px; table-layout: fixed; margin-bottom: 6px; }
  .sl th { font-size: 10.5px; font-weight: 400; color: var(--leise); text-align: left; padding: 3px 3px; }
  .sl th.r { text-align: right; }
  .sl td { padding: 5px 3px; border-top: 1px solid var(--linie); vertical-align: top; line-height: 1.3; }
  .sl tr.bb td { background: rgba(229,180,90,.11); }
  .sl tr.ich td { background: var(--flaeche); }
  .sl .nm { overflow: hidden; }
  .sl .nm a, .sl .nm span, .fr a { color: var(--tinte); text-decoration: none; font-weight: 600; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sl .nm a:hover, .fr a:hover { text-decoration: underline; }
  .sl .du { color: var(--plus); }
  .sl .nm small { display: block; color: var(--leise); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
  .sl .nm small .kn, .sl .nm small b { display: inline-block; margin-right: 3px; }
  .sl td b { font-weight: 600; }
  .sl td:first-child { color: var(--leise); }
  .kn { display: inline-block; border-radius: 4px; padding: 0 4px; font-size: 9.5px; font-weight: 600; line-height: 1.5; }
  .kn.fba { color: var(--plus); background: rgba(70,211,154,.14); }
  .kn.fbm { color: #e5b45a; background: rgba(229,180,90,.14); }
  .fr { display: flex; gap: 6px; align-items: center; padding: 4px 0; border-top: 1px solid var(--linie); font-size: 11.5px; }
  .fr a { display: inline; max-width: 130px; }

  /* Verlauf (1.9.32: zugänglich, feste Lesezeile, Linien-Filter, EK, Keepa, Tabelle, Großansicht) */
  .chart-box { padding-bottom: 8px; }
  .chead { display: flex; align-items: center; justify-content: space-between; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
  .chead b { font-size: 13px; font-weight: 600; }
  .chead-r { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
  .cbtn, .ckeepa { border: 1px solid var(--rand); background: var(--flaeche); color: var(--tinte); border-radius: 6px; padding: 2px 7px; font-size: 10.5px; font-weight: 600; cursor: pointer; text-decoration: none; line-height: 1.5; font-family: inherit; }
  .cbtn:hover, .ckeepa:hover { background: #2d3933; border-color: #4a5952; }
  .cstats { display: grid; grid-template-columns: repeat(auto-fit, minmax(60px, 1fr)); gap: 4px; margin-bottom: 6px; font-variant-numeric: tabular-nums; }
  .cstats span { background: var(--flaeche); border: 1px solid var(--linie); border-radius: 7px; padding: 4px 6px; }
  .cstats i { display: block; font-style: normal; font-size: 9.5px; color: var(--leise); line-height: 1.25; }
  .cstats b { display: block; font-size: 11.5px; font-weight: 600; color: var(--tinte); margin-top: 1px; }
  .clese { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; background: #141c19; border: 1px solid var(--linie); border-radius: 7px; padding: 5px 8px; margin-bottom: 6px; font-size: 10.5px; line-height: 1.4; font-variant-numeric: tabular-nums; min-height: 24px; }
  .clese .ctag { color: var(--tinte); font-weight: 600; margin-right: 2px; }
  .clese .cw { display: inline-flex; align-items: center; gap: 3px; color: var(--leise); white-space: nowrap; }
  .clese .cw b { color: var(--tinte); font-weight: 600; }
  .cstrich { vertical-align: middle; flex: 0 0 auto; }
  .cwrap { position: relative; border-radius: 6px; touch-action: pan-y; cursor: crosshair; }
  .cwrap:focus-visible { outline: 2px solid var(--plus); outline-offset: 2px; }
  .chart { width: 100%; height: auto; display: block; }
  .chart.klein { margin-top: 4px; background: #1a2320; border-radius: 5px; }
  .chart .ax { font: 7.5px -apple-system, "Segoe UI", sans-serif; fill: #9ba8a1; font-variant-numeric: tabular-nums; }
  .chart-box.gross .chart .ax { font-size: 10px; }
  .chart .ekax { fill: #c4b5fd; font-weight: 600; }
  .chart .gitter { stroke: #2a3530; stroke-width: 1; }
  .chart .flaeche { fill: rgba(240,243,240,.07); }
  .chart .hover { stroke: var(--tinte); stroke-width: .8; stroke-dasharray: 2 2; }
  .leg { display: flex; gap: 4px 6px; flex-wrap: wrap; font-size: 10.5px; color: var(--leise); margin-top: 6px; align-items: center; }
  .leg i { display: inline-block; width: 7px; height: 7px; border-radius: 2px; margin-right: 4px; }
  .cleg-btn { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--linie); background: var(--flaeche); color: var(--tinte); border-radius: 6px; padding: 2px 6px; font-size: 10.5px; cursor: pointer; font-family: inherit; }
  .cleg-btn:hover { border-color: #4a5952; }
  .cleg-btn[aria-pressed="false"] { opacity: .42; text-decoration: line-through; background: transparent; }
  .cleg-fest { display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px; font-size: 10.5px; color: var(--leise); }
  .ctbl-det { margin-top: 6px; border-top: 1px solid var(--linie); padding-top: 4px; }
  .ctbl-det summary { cursor: pointer; font-size: 11px; font-weight: 600; color: var(--leise); padding: 3px 0; list-style: none; display: flex; align-items: center; justify-content: space-between; }
  .ctbl-det summary::-webkit-details-marker { display: none; }
  .ctbl-det summary:hover { color: var(--tinte); }
  .ctbl-wrap { max-height: 180px; overflow: auto; margin-top: 4px; border: 1px solid var(--linie); border-radius: 6px; }
  .chart-box.gross .ctbl-wrap { max-height: 220px; }
  .ctbl { width: 100%; border-collapse: collapse; font-size: 11px; font-variant-numeric: tabular-nums; }
  .ctbl th, .ctbl td { padding: 4px 6px; border-top: 1px solid var(--linie); text-align: left; white-space: nowrap; }
  .ctbl thead th { position: sticky; top: 0; background: #18211d; color: var(--leise); font-weight: 600; border-top: 0; }
  .ctbl tbody th { font-weight: 500; color: var(--leise); }
  .ctbl .r { text-align: right; }
  .cmodal[hidden] { display: none; }
  .cmodal { position: fixed; inset: 0; z-index: 2147483647; background: rgba(7,12,10,.76); backdrop-filter: blur(3px); display: flex; align-items: center; justify-content: center; padding: 20px; box-sizing: border-box; }
  .cm-dialog { width: min(820px, 100%); max-height: 92vh; overflow: auto; background: var(--bg); color: var(--tinte); border: 1px solid var(--rand); border-radius: 14px; padding: 16px 18px 14px; box-shadow: 0 24px 64px rgba(0,0,0,.55); }
  .cm-dialog .chart-box.gross { border-top: 0; padding-top: 0; }
  .cm-dialog .cstats b { font-size: 14px; }
  .cm-dialog .clese { font-size: 12px; padding: 7px 10px; }
  .cm-dialog .cleg-btn { padding: 4px 8px; font-size: 11.5px; }
  .leer { padding: 8px 0; }
  .streifen { margin-top: 4px; font-size: 10.5px; line-height: 1.4; }
  .streifen b { color: var(--tinte); }
  .spin.mini { width: 8px; height: 8px; border-width: 1.5px; vertical-align: 0; }
  .pos { color: var(--plus); } .neg { color: var(--minus); } .mut { color: var(--leise); font-size: 11px; font-weight: 400; }
  `;
})();
