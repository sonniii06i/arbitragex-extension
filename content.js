/* Arbitragex Content-Script — Panel auf Amazon-Produktseiten.
 *
 * Grundsätze dieses Panels:
 *  - Die Produktdaten werden SOFORT beim Laden der Seite geholt, nicht erst beim
 *    Klick. Wer das Panel öffnet, sieht die Zahlen ohne Wartezeit.
 *  - Alles ist auf einen Blick da: keine Ausklapp-Bereiche, kein Scrollen, um an
 *    ein Eingabefeld zu kommen.
 *  - EIN Button. "Einkauf registrieren" legt den Einkauf an; Listing und
 *    Prep-Ankündigung stößt das Backend im selben Zug an.
 *  - Zustand ist immer "neu" — Arbitrage-Ware ist Neuware, die Auswahl war nur
 *    ein Klick, den nie jemand geändert hat.
 */
(function () {
  "use strict";
  const MPS = ["de", "fr", "it", "es"];
  const FLAG = { de: "🇩🇪", fr: "🇫🇷", it: "🇮🇹", es: "🇪🇸" };

  /* Ab v1.6 laeuft das Script auf allen Seiten statt nur auf Amazon.
     Auf Amazon bleibt alles wie bisher (Panel, Kalkulation, Einkauf erfassen).
     Ueberall sonst gibt es keine ASIN und damit nichts zu kalkulieren — dort
     beschraenkt sich die Extension auf die EAN aus dem Quelltext. Der Chip
     erscheint auf fremden Seiten nur, wenn wirklich eine gueltige EAN
     gefunden wurde; sonst bleibt die Seite unberuehrt. */
  const IS_AMAZON = /(^|\.)amazon\.(de|fr|it|es|nl|pl|se|com|co\.uk)$/i.test(location.hostname);

  function api(path, method, body) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ path, method, body }, (r) => resolve(r || { ok: false, status: 0 }));
    });
  }
  function eur(n) {
    if (n == null || isNaN(n)) return "—";
    return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(n);
  }
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function num(v) {
    const n = parseFloat(String(v == null ? "" : v).replace(",", "."));
    return isNaN(n) ? null : n;
  }
  function getAsin() {
    const m = location.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d|gp\/offer-listing)\/([A-Z0-9]{10})/);
    if (m) return m[1];
    const dp = document.querySelector("[data-asin]");
    const a = dp && dp.getAttribute("data-asin");
    return a && /^[A-Z0-9]{10}$/.test(a) ? a : null;
  }
  function shopName(url) {
    // Vollstaendige Domain inkl. Laenderendung: "amazon.de" statt "amazon" —
    // amazon.de und amazon.fr sind verschiedene Quellen.
    try { return new URL(url).hostname.replace(/^www\./, ""); }
    catch (e) { return ""; }
  }

  let panel;
  const state = { asin: null, data: null, prices: {}, markup: 30, qty: 1, prefetch: null,
                  catalogEan: null, side: "left" };

  /* Panel-Seite. Standard LINKS, weil rechts meist SellerAmp/ProfitGo sitzt. */
  async function loadSide() {
    try {
      const r = await chrome.storage.sync.get("panelSide");
      state.side = (r && r.panelSide === "right") ? "right" : "left";
    } catch (e) { state.side = "left"; }
    return state.side;
  }
  function applySide() {
    if (!panel) return;
    panel.classList.remove("side-left", "side-right");
    panel.classList.add("side-" + state.side);
  }
  function flipSide() {
    state.side = state.side === "left" ? "right" : "left";
    try { chrome.storage.sync.set({ panelSide: state.side }); } catch (e) { }
    // Erst Seite wechseln, dann wieder aufklappen — sonst springt es hart.
    panel.classList.remove("open");
    applySide();
    setTimeout(() => panel.classList.add("open"), 30);
    const b = document.getElementById("axx-side");
    if (b) b.title = state.side === "left" ? "Nach rechts schieben" : "Nach links schieben";
  }

  /* --- Vorab laden ---------------------------------------------------------
     Läuft direkt beim Seitenaufruf los. Das Ergebnis liegt im Cache, bevor der
     Nutzer überhaupt klickt — deshalb fühlt sich das Panel sofort an. */
  function prefetch(asin) {
    state.asin = asin;
    state.prefetch = (async () => {
      const me = await api("/api/ext/me");
      if (me.status === 401 || !me.ok) return { step: "login" };
      if (!me.data || !me.data.connected) return { step: "noaccount" };
      const r = await api("/api/ext/analyze?asin=" + encodeURIComponent(asin) + "&markup=" + state.markup);
      if (!r.ok) return { step: "error", error: (r.data && r.data.error) || ("HTTP " + r.status) };
      if (r.data && r.data.error) return { step: "error", error: r.data.error };
      // Katalog-EAN merken; wenn die Seite selbst keine hergab, Chip neu bauen.
      if (r.data && r.data.ean) {
        state.catalogEan = r.data.ean;
        const chip = document.getElementById(CHIP_ID);
        if (chip && !chip.querySelector(".axx-cp.ean")) buildChip();
      }
      return { step: "ok", data: r.data };
    })();
    return state.prefetch;
  }

  /* ======================================================================
     EAN-Erkennung
     Portiert aus der bewährten „EAN Quick Copy"-Extension: JSON-LD, Microdata,
     Inline-JSON und sichtbare Spec-Tabellen, am Ende gefiltert über die
     Mod-10-Prüfziffer. Ohne gültige Prüfziffer fliegt ein Fund raus — sonst
     landen Artikelnummern und Modellnummern im Ergebnis.
     ====================================================================== */
  const GTIN_KEYS = ["gtin13", "gtin", "gtin12", "gtin14", "gtin8", "ean", "eancode", "ean13", "barcode"];

  function isValidChecksum(code) {
    const digits = code.split("").map(Number);
    const check = digits.pop();
    let sum = 0;
    digits.reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1); });
    return (10 - (sum % 10)) % 10 === check;
  }
  function isPlausibleEan(code) {
    if (!/^\d+$/.test(code)) return false;
    if (![8, 12, 13, 14].includes(code.length)) return false;
    if (/^(\d)\1+$/.test(code)) return false;
    return true;
  }
  function collectFromObject(obj, out, depth) {
    depth = depth || 0;
    if (!obj || typeof obj !== "object" || depth > 12) return;
    if (Array.isArray(obj)) { obj.forEach((it) => collectFromObject(it, out, depth + 1)); return; }
    Object.keys(obj).forEach((key) => {
      const value = obj[key], k = key.toLowerCase();
      if (GTIN_KEYS.indexOf(k) >= 0 && (typeof value === "string" || typeof value === "number")) {
        const code = String(value).trim();
        if (isPlausibleEan(code)) out.push({ code: code, weight: k.indexOf("gtin") === 0 ? 3 : 2 });
      } else if (value && typeof value === "object") {
        collectFromObject(value, out, depth + 1);
      }
    });
  }
  /* Ist das ueberhaupt eine Produktseite?
     Auf Kategorie- und Suchseiten stehen Dutzende EANs im Quelltext (Kacheln,
     Werbebanner). Eine davon anzuzeigen waere geraten — genau wie bei den
     ASINs, wo der Code das schon laenger ablehnt. Deshalb hier dieselbe
     Strenge: nur auf erkennbaren Produktseiten ueberhaupt etwas anbieten. */
  function isProductPage() {
    /* Die Adresse zuerst: Sie ist das einzige Merkmal, das bei einer
       Single-Page-App sofort stimmt. Meta-Tags und JSON-LD hinken beim
       Wechsel hinterher und behaupten teils noch, man stehe auf dem
       vorherigen Produkt. */
    const pfad = location.pathname.toLowerCase();
    const listenSeite = /\/(category|categories|kategorie|search|suche|s\/|c\/|marken?|brand|sale|angebote)(\/|$|\?)/.test(pfad)
      || /[?&](q|query|search|suchbegriff)=/.test(location.search.toLowerCase());
    if (listenSeite) return false;
    // 1. JSON-LD mit @type Product — der verlaesslichste Hinweis
    const nodes = document.querySelectorAll('script[type="application/ld+json"]');
    for (const n of nodes) {
      try {
        const stack = [JSON.parse(n.textContent)];
        while (stack.length) {
          const cur = stack.pop();
          if (!cur || typeof cur !== "object") continue;
          if (Array.isArray(cur)) { stack.push(...cur); continue; }
          const t = cur["@type"];
          const types = Array.isArray(t) ? t : [t];
          if (types.some((x) => String(x).toLowerCase() === "product")) return true;
          Object.values(cur).forEach((v) => { if (v && typeof v === "object") stack.push(v); });
        }
      } catch (e) { }
    }
    // 2. OpenGraph
    const og = document.querySelector('meta[property="og:type"]');
    if (og && /product/i.test(og.getAttribute("content") || "")) return true;
    // 3. Mikrodaten
    if (document.querySelector('[itemtype*="schema.org/Product" i]')) return true;
    return false;
  }

  function findEans() {
    const out = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try { collectFromObject(JSON.parse(s.textContent), out); } catch (e) { }
    });
    // Hoechstes Gewicht: Diese Angaben beziehen sich auf die gerade
    // ausgewaehlte Variante. JSON-LD listet dagegen oft alle Farben und
    // Groessen auf einmal — daher dort niedrigeres Gewicht.
    document.querySelectorAll('[itemprop="gtin13"],[itemprop="gtin"],[itemprop="gtin12"],[itemprop="gtin14"],meta[property="product:ean"],meta[name="ean"],meta[property="og:gtin13"],meta[property="product:retailer_item_id"]')
      .forEach((e) => {
        const code = (e.getAttribute("content") || e.textContent || "").trim();
        if (isPlausibleEan(code)) out.push({ code: code, weight: 8 });
      });
    // Steht eine EAN in der Adresszeile (haeufig bei Variantenwechsel), gilt sie.
    const inUrl = (location.href.match(/\b\d{13}\b/g) || []);
    inUrl.forEach((c) => { if (isPlausibleEan(c)) out.push({ code: c, weight: 9 }); });
    const keyRe = /["'](?:gtin1[234]|gtin8?|ean(?:13|Code|_code)?|barcode)["']\s*[:=]\s*["']?(\d{8,14})["']?/gi;
    document.querySelectorAll("script:not([src])").forEach((s) => {
      const text = s.textContent;
      if (!text || text.length > 2000000) return;
      let m; keyRe.lastIndex = 0;
      while ((m = keyRe.exec(text)) !== null) {
        if (isPlausibleEan(m[1])) out.push({ code: m[1], weight: 1 });
      }
    });
    // Amazon-Detailtabellen: "EAN ‏ : ‎ 4059584014958" — teils mehrere Codes in
    // EINER Zelle, deshalb am Whitespace/Komma zerlegen statt die Zelle zu verwerfen.
    document.querySelectorAll("td, dd, span, div, li").forEach((e) => {
      if (e.children.length > 0) return;
      const label = ((e.previousElementSibling && e.previousElementSibling.textContent) || "").trim();
      if (!/^(EAN|GTIN|EAN\/GTIN)\b/i.test(label)) return;
      String(e.textContent || "").split(/[\s,;]+/).forEach((part) => {
        const code = part.trim();
        if (isPlausibleEan(code)) out.push({ code: code, weight: 3 });
      });
    });

    const scores = new Map();
    out.forEach((o) => {
      const bonus = (isValidChecksum(o.code) ? 10 : 0) + (o.code.length === 13 ? 2 : 0);
      scores.set(o.code, (scores.get(o.code) || 0) + o.weight + bonus);
    });
    return Array.from(scores.entries())
      .filter((e) => isValidChecksum(e[0]))
      .sort((a, b) => b[1] - a[1])
      .map((e) => e[0]);
  }

  /* ======================================================================
     Chip: AX-Knopf + ASIN + EAN, frei verschiebbar
     Position wird gespeichert, damit der Chip nicht bei jedem Seitenaufruf
     wieder dort liegt, wo er stört.
     ====================================================================== */
  const CHIP_ID = "axx-launch";

  function pageAsin() {
    const m = location.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d|gp\/offer-listing)\/([A-Z0-9]{10})/);
    if (m) return { asin: m[1], sure: true };
    const tiles = document.querySelectorAll("[data-asin]");
    const list = [];
    tiles.forEach((t) => {
      const a = t.getAttribute("data-asin");
      if (a && /^[A-Z0-9]{10}$/.test(a) && list.indexOf(a) < 0) list.push(a);
    });
    // Genau ein Treffer = eindeutig. Mehrere = Übersichtsseite, dann NICHT einen
    // beliebigen davon als "die" ASIN ausgeben — das wäre geraten.
    if (list.length === 1) return { asin: list[0], sure: true };
    if (list.length > 1) return { asin: null, sure: false, list: list };

    // Fremde Shops fuehren keine ASIN. Manche verlinken aber auf Amazon
    // (Partnerlinks, "auch erhaeltlich bei"). Solche Verweise werden hier
    // ausgewertet — allerdings nur, wenn genau eine ASIN vorkommt. Mehrere
    // Treffer heisst: die Seite listet fremde Produkte mit, und dann waere
    // jede Auswahl geraten.
    if (!IS_AMAZON) {
      const fromLinks = [];
      const re = /amazon\.[a-z.]{2,6}\/(?:[^\s"'<>]*?\/)?(?:dp|gp\/product)\/([A-Z0-9]{10})/gi;
      document.querySelectorAll('a[href*="amazon."]').forEach((a) => {
        const m = re.exec(a.getAttribute("href") || "");
        re.lastIndex = 0;
        if (m && fromLinks.indexOf(m[1]) < 0) fromLinks.push(m[1]);
      });
      if (fromLinks.length === 1) return { asin: fromLinks[0], sure: false };
    }
    return { asin: null, sure: false, list: list };
  }

  async function savedPos() {
    try {
      const r = await chrome.storage.sync.get("chipPos");
      return r && r.chipPos ? r.chipPos : null;
    } catch (e) { return null; }
  }
  function storePos(p) {
    try { chrome.storage.sync.set({ chipPos: p }); } catch (e) { }
  }

  function copyText(txt, node, label) {
    const done = () => {
      const prev = node.textContent;
      node.classList.add("copied");
      node.textContent = "kopiert ✓";
      setTimeout(() => { node.classList.remove("copied"); node.textContent = prev; }, 900);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done, () => fallbackCopy(txt, done));
    } else fallbackCopy(txt, done);
  }
  function fallbackCopy(txt, done) {
    const ta = document.createElement("textarea");
    ta.value = txt; ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { }
    ta.remove();
  }

  async function buildChip() {
    const old = document.getElementById(CHIP_ID);
    if (old) old.remove();

    const info = pageAsin();
    const eans = findEans();
    // Auf fremden Seiten gilt: nur echte Produktseiten, und dort nur ein
    // eindeutiges Ergebnis. Eine Kategorieseite listet Dutzende EANs — eine
    // davon herauszugreifen waere geraten.
    // Produktseiten fuehren regelmaessig mehrere EANs (Farb- und
    // Groessenvarianten) — das ist normal und kein Grund zu schweigen.
    // findEans() sortiert nach Verlaesslichkeit, die erste passt. Vor
    // Kategorieseiten schuetzt bereits isProductPage().
    if (!IS_AMAZON) {
      if (!isProductPage()) return;
      if (!eans.length && !info.asin) return;
    }
    const chip = el("div", "axx-chip");
    chip.id = CHIP_ID;

    // Seite zuerst, SP-API als Rückfall: Amazon zeigt die EAN auf der PDP oft
    // gar nicht an, im Katalog steht sie trotzdem. Der Katalogwert kommt aus dem
    // Prefetch, ist also meist schon da, wenn der Chip gebaut wird.
    const ean = eans.length ? eans[0] : (state.catalogEan || null);

    let html = '<button class="axx-chip-ax" title="' +
      (IS_AMAZON ? "Arbitragex öffnen" : "Diese EAN in Arbitragex suchen") + '">AX</button>';
    if (info.asin) {
      html += '<button class="axx-cp" data-copy="' + info.asin + '" title="ASIN kopieren">' + info.asin + "</button>";
    } else if (info.list && info.list.length > 1) {
      html += '<button class="axx-cp" data-copy="' + info.list.join("\\n") + '" title="Alle ASINs dieser Seite kopieren">' +
        info.list.length + " ASINs</button>";
    }
    if (ean) {
      html += '<button class="axx-cp ean" data-copy="' + ean + '" title="EAN kopieren' +
        (eans.length ? "" : " (aus dem Amazon-Katalog)") + '">' + ean + "</button>";
    }
    // Quick-Links: mit EAN suchen ist treffsicherer als mit dem Titel; ohne EAN
    // bleibt die ASIN für Amazon und der Titel für idealo.
    const q = ean || info.asin || "";
    if (q) {
      html += '<a class="axx-lnk idealo" target="_blank" rel="noopener" title="Auf idealo suchen" href="' +
        "https://www.idealo.de/preisvergleich/MainSearchProductCategory.html?q=" + encodeURIComponent(q) + '">idealo</a>';
      if (info.asin) {
        html += '<a class="axx-lnk amazon" target="_blank" rel="noopener" title="Auf Amazon öffnen" href="' +
          "https://www.amazon.de/dp/" + info.asin + '">amazon</a>';
      } else {
        html += '<a class="axx-lnk amazon" target="_blank" rel="noopener" title="Auf Amazon suchen" href="' +
          "https://www.amazon.de/s?k=" + encodeURIComponent(q) + '">amazon</a>';
      }
      html += '<a class="axx-lnk goog" target="_blank" rel="noopener" title="Bei Google suchen" href="' +
        "https://www.google.com/search?q=" + encodeURIComponent(q) + '">google</a>';
    }
    html += '<span class="axx-grip" title="Verschieben">⠿</span>';
    chip.innerHTML = html;
    document.body.appendChild(chip);

    const pos = await savedPos();
    if (pos) { chip.style.left = pos.x + "px"; chip.style.top = pos.y + "px"; chip.style.right = "auto"; chip.style.bottom = "auto"; }

    chip.querySelector(".axx-chip-ax").addEventListener("click", (e) => {
      e.stopPropagation();
      // Ohne ASIN kann das Panel nichts berechnen — dann lieber Arbitragex
      // mit der gefundenen EAN oeffnen, statt ein leeres Panel zu zeigen.
      if (IS_AMAZON) { togglePanel(); return; }
      const target = "https://arbitragex.de/" + (ean ? "?ean=" + encodeURIComponent(ean) : "");
      window.open(target, "_blank", "noopener");
    });
    chip.querySelectorAll(".axx-cp").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation(); e.preventDefault();
      copyText(b.getAttribute("data-copy").replace(/\\n/g, "\n"), b);
    }));
    makeDraggable(chip, chip.querySelector(".axx-grip"));
  }

  /* Ziehen am Griff. Bewusst NICHT der ganze Chip als Ziehfläche: sonst müsste
     man Klick und Zug per Schwellwert auseinanderhalten, und ein leicht
     verwackelter Klick auf die ASIN würde nicht mehr kopieren. */
  function makeDraggable(node, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const r = node.getBoundingClientRect();
      dragging = true; sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      node.classList.add("dragging");
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    function onMove(e) {
      if (!dragging) return;
      const w = node.offsetWidth, h = node.offsetHeight;
      // im Viewport halten, sonst ist der Chip nicht mehr erreichbar
      const x = Math.min(Math.max(0, ox + e.clientX - sx), window.innerWidth - w);
      const y = Math.min(Math.max(0, oy + e.clientY - sy), window.innerHeight - h);
      node.style.left = x + "px"; node.style.top = y + "px";
      node.style.right = "auto"; node.style.bottom = "auto";
    }
    function onUp() {
      if (!dragging) return;
      dragging = false;
      node.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const r = node.getBoundingClientRect();
      storePos({ x: Math.round(r.left), y: Math.round(r.top) });
    }
  }

  function launcher() { buildChip(); }

  function togglePanel() {
    if (panel && panel.classList.contains("open")) { panel.classList.remove("open"); return; }
    openPanel();
  }

  async function openPanel() {
    if (!panel) {
      panel = el("div", "axx-panel");
      panel.id = "axx-panel";
      document.body.appendChild(panel);
      await loadSide();
    }
    applySide();
    panel.classList.add("open");
    const asin = getAsin();
    if (!asin) {
      panel.innerHTML = header() + '<div class="axx-body"></div>';
      wireHeader();
      renderMsg("Keine ASIN erkannt", "Öffne eine Amazon-Produktseite (/dp/…).");
      return;
    }
    if (state.asin !== asin || !state.prefetch) prefetch(asin);
    panel.innerHTML = header() + '<div class="axx-body">' + loading("Lade Produktdaten…") + "</div>";
    wireHeader();

    /* Der Abruf holt Buy-Box-Preise fuer vier Marktplaetze ueber die SP-API —
       das dauert serverseitig und laesst sich hier nicht beschleunigen. Statt
       eines stummen Spinners sagt das Panel deshalb, woran es gerade haengt,
       und bricht nach 20 s mit einem klaren Hinweis ab, statt ewig zu drehen. */
    const startedAt = Date.now();
    const ticker = setInterval(() => {
      const box = body();
      if (!box) return;
      const sek = Math.round((Date.now() - startedAt) / 1000);
      if (sek >= 4) {
        box.innerHTML = loading("Buy-Box-Preise werden geholt… (" + sek + " s)");
      } else if (sek >= 1) {
        box.innerHTML = loading("Frage Amazon-Katalog ab…");
      }
    }, 1000);

    const abbruch = new Promise((r) => setTimeout(
      () => r({ step: "error", error: "Zeitüberschreitung — Arbitragex antwortet nicht. Später erneut versuchen." }),
      20000));
    const res = await Promise.race([state.prefetch, abbruch]);
    clearInterval(ticker);
    if (res.step === "login") return renderLogin();
    if (res.step === "noaccount") return renderMsg("Kein Amazon-Konto verbunden",
      "Verbinde dein Konto in Arbitragex → Einstellungen.");
    if (res.step === "error") return renderMsg("Nicht gefunden", res.error);

    state.data = res.data;
    state.prices = {};
    MPS.forEach((k) => { state.prices[k] = res.data.suggested[k] != null ? res.data.suggested[k] : ""; });
    render();
  }

  function header() {
    return '<div class="axx-head"><div class="axx-brand"><b>Arbitragex</b><span>' +
      (state.asin || "") + '</span></div>' +
      '<button class="axx-side" id="axx-side" title="' +
      (state.side === "left" ? "Nach rechts schieben" : "Nach links schieben") + '">⇄</button>' +
      '<button class="axx-x" id="axx-close">✕</button></div>';
  }
  function wireHeader() {
    const x = document.getElementById("axx-close");
    if (x) x.addEventListener("click", () => panel.classList.remove("open"));
    const sd = document.getElementById("axx-side");
    if (sd) sd.addEventListener("click", flipSide);
  }
  function loading(t) { return '<div class="axx-load"><span class="axx-spin"></span>' + (t || "Lade…") + "</div>"; }
  function body() { return panel.querySelector(".axx-body"); }
  function renderMsg(title, sub) {
    body().innerHTML = '<div class="axx-msg"><b>' + esc(title) + "</b><p>" + esc(sub || "") + "</p></div>";
  }
  function renderLogin() {
    body().innerHTML = '<div class="axx-msg"><b>Nicht eingeloggt</b><p>Einmal bei Arbitragex anmelden, dann Seite neu laden.</p>' +
      '<a class="axx-btn primary" href="https://arbitragex.de/login" target="_blank">Zu Arbitragex-Login</a></div>';
  }

  /* --- Panel ---------------------------------------------------------------
     Reihenfolge nach Blickverlauf: Was ist das? Was bringt es? Was gebe ich ein?
     Alles ohne Ausklappen sichtbar. */
  function render() {
    const d = state.data;
    const sells = d.sells || {};
    const sold = (sells.units || 0) > 0
      ? '<span class="axx-sold">✓ verkaufst du schon · ' + sells.units + " Stk</span>"
      : '<span class="axx-sold new">neu für dich</span>';

    // Preise sind ANZEIGE, keine Eingabe: das Backend rechnet den Listing-Preis
    // beim Anlegen aus Aufschlag + tagesaktueller Buy-Box neu. Ein hier
    // eingetippter Einzelpreis würde stillschweigend überschrieben — deshalb
    // steuert nur der Aufschlag, und das Ergebnis ist sichtbar.
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
        '<label>EK € / Stück<input id="axx-b-cost" type="text" inputmode="decimal" placeholder="0,00" autofocus></label>' +
        '<label>Menge<input id="axx-b-qty" type="number" min="1" value="1"></label>' +
        '<label>VK €<input id="axx-b-sell" type="text" inputmode="decimal" value="' + vk + '"></label>' +
        '<label>Bestellnr.<input id="axx-b-order" type="text" placeholder="optional"></label>' +
        '<label class="axx-full">Gekauft bei<input id="axx-b-url" type="url" value="' + esc(location.href) + '"></label>' +
      "</div>" +

      '<div class="axx-margin" id="axx-b-margin">EK eintragen für Marge</div>' +

      '<button class="axx-btn primary axx-go" id="axx-save">Einkauf registrieren</button>' +
      '<div class="axx-note">Legt den Einkauf an, listet auf den Märkten mit Preis und meldet ihn ' +
        (prepOk ? "beim Prep-Center an." : "— Prep ist nicht verbunden.") + "</div>" +
      '<div class="axx-result" id="axx-result"></div>';

    wire();
  }

  function wire() {
    body().querySelectorAll(".axx-mk").forEach((b) => b.addEventListener("click", () => {
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
    if (cost) cost.addEventListener("keydown", (e) => { if (e.key === "Enter") save({ currentTarget: document.getElementById("axx-save") }); });
    if (cost) cost.focus();
  }

  function applyMarkup() {
    const bb = state.data.buybox;
    MPS.forEach((k) => {
      state.prices[k] = bb[k] != null ? Math.round(bb[k] * (1 + state.markup / 100) * 100) / 100 : "";
    });
    body().querySelectorAll(".axx-mpout").forEach((cell) => {
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

  async function save(e) {
    const btn = (e && e.currentTarget) || document.getElementById("axx-save");
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

  /* --- Init ---------------------------------------------------------------- */
  function init() {
    launcher();
    if (!IS_AMAZON) return;     // fremde Seite: nur EAN, kein Katalog-Abruf
    const asin = getAsin();
    if (asin) prefetch(asin);   // <- ohne Zutun, direkt beim Laden
  }
  init();

  /* ==================================================================
     Seitenwechsel und Variantenwechsel erkennen

     Shops wie MediaMarkt sind Single-Page-Apps: Beim Wechsel von einer
     Produktseite zur Kategorie wird nichts neu geladen. Die alten
     og:-Meta-Tags und JSON-LD-Bloecke bleiben teils sekundenlang stehen —
     wer sofort danach entscheidet, zeigt die EAN der vorherigen Seite.

     Deshalb: Bei jeder Aenderung erst den Chip entfernen, dann kurz warten,
     bis der neue Inhalt steht, und erst danach neu bewerten.
     ================================================================== */
  const CHIP_VERZOEGERUNG = 900;
  let neuAufbau = null;

  function chipEntfernen() {
    const c = document.getElementById(CHIP_ID);
    if (c) c.remove();
  }

  function neuBewerten(sofortEntfernen) {
    if (sofortEntfernen) chipEntfernen();
    clearTimeout(neuAufbau);
    neuAufbau = setTimeout(() => {
      buildChip();
      if (IS_AMAZON) {
        const asin = getAsin();
        // Nur bei echtem Produktwechsel neu laden. Sonst wuerde ein offenes
        // Panel mitten in der Eingabe zurueckgesetzt.
        if (asin && asin !== state.asin) {
          state.data = null; state.prefetch = null; state.catalogEan = null;
          prefetch(asin);
          if (panel && panel.classList.contains("open")) openPanel();
        }
      }
    }, CHIP_VERZOEGERUNG);
  }

  // 1. Adresswechsel (auch ohne Neuladen)
  let letzteUrl = location.href;
  setInterval(() => {
    if (location.href === letzteUrl) return;
    letzteUrl = location.href;
    neuBewerten(true);
  }, 400);

  // 2. Inhaltswechsel ohne Adressaenderung — genau das passiert beim
  //    Umschalten der Farbe. Beobachtet werden nur die Stellen, an denen
  //    Produktangaben stehen; ein Beobachter auf dem ganzen Body wuerde bei
  //    jedem Werbebanner feuern.
  // NUR auf fremden Seiten. Auf Amazon aendert sich der Kopfbereich staendig
  // (nachgeladene Styles, Tracking-Tags); dort wuerde der Beobachter das Panel
  // im Sekundentakt neu zeichnen und damit Eingaben und Klicks zerstoeren.
  const kopf = document.head;
  if (!IS_AMAZON && kopf && window.MutationObserver) {
    new MutationObserver(() => neuBewerten(false))
      .observe(kopf, { childList: true, subtree: true, attributes: true,
                       attributeFilter: ["content", "href"] });
  }

  // 3. Sicherheitsnetz: Stimmt die angezeigte EAN nicht mehr mit der besten
  //    ueberein, neu aufbauen. Faengt Shops ab, die weder Adresse noch
  //    Kopfbereich anfassen.
  setInterval(() => {
    // Bei offenem Panel nichts anfassen — der Nutzer tippt dort gerade.
    if (panel && panel.classList.contains("open")) return;
    const chip = document.getElementById(CHIP_ID);
    if (!chip) return;
    const feld = chip.querySelector(".axx-cp.ean");
    const angezeigt = feld ? feld.textContent.trim() : null;
    const beste = findEans()[0] || null;
    if (!IS_AMAZON && !isProductPage()) { chipEntfernen(); return; }
    if (beste && angezeigt && beste !== angezeigt) buildChip();
  }, 1200);

  // 4. Amazon laedt Detailtabellen nach — kurz nachfassen, bis eine EAN da ist
  let rescans = 0;
  const rescan = setInterval(() => {
    if (++rescans > 6) { clearInterval(rescan); return; }
    const chip = document.getElementById(CHIP_ID);
    if (chip && chip.querySelector(".axx-cp.ean")) { clearInterval(rescan); return; }
    if (findEans().length) buildChip();
  }, 1000);
})();
