/* Arbitragex Content-Script — Chip auf der Seite + Datenlieferant fuers Popup.
 *
 * Seit v1.8.0 gibt es KEIN eingeblendetes Panel mehr. Der bodenhohe Drawer hat
 * auf der Amazon-Produktseite den halben Bildschirm verdeckt und liess sich nur
 * ueber sein eigenes Kreuz schliessen — das war im Alltag stoerender als
 * hilfreich. Die Kalkulation und "Einkauf registrieren" sitzen jetzt im
 * Extension-Popup oben rechts (popup.html), also da, wo man es von anderen
 * Shopping-Extensions kennt.
 *
 * Was hier bleibt:
 *  - Der Chip (ASIN, EAN, Quick-Links) — klein, verschiebbar, stoert nicht.
 *  - Die EAN-Erkennung auf allen Shop-Seiten.
 *  - Das Vorabladen der Analyse. Es laeuft weiter beim Seitenaufruf, damit das
 *    Popup die Zahlen ohne Wartezeit zeigt: Das Popup fragt sie hier ab, statt
 *    selbst zu laden.
 */
(function () {
  "use strict";

  /* Ab v1.6 laeuft das Script auf allen Seiten statt nur auf Amazon.
     Auf Amazon gibt es ASIN, Kalkulation und Einkauf; ueberall sonst
     beschraenkt sich die Extension auf die EAN aus dem Quelltext. Der Chip
     erscheint auf fremden Seiten nur, wenn wirklich eine gueltige EAN
     gefunden wurde; sonst bleibt die Seite unberuehrt. */
  const IS_AMAZON = /(^|\.)amazon\.(de|fr|it|es|nl|pl|se|com|co\.uk)$/i.test(location.hostname);

  function api(path, method, body) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ path, method, body }, (r) => resolve(r || { ok: false, status: 0 }));
    });
  }
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function getAsin() {
    const m = location.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d|gp\/offer-listing)\/([A-Z0-9]{10})/);
    if (m) return m[1];
    const dp = document.querySelector("[data-asin]");
    const a = dp && dp.getAttribute("data-asin");
    return a && /^[A-Z0-9]{10}$/.test(a) ? a : null;
  }

  const state = { asin: null, prefetch: null, catalogEan: null, markup: 30 };

  /* --- Vorab laden ---------------------------------------------------------
     Läuft direkt beim Seitenaufruf los. Das Ergebnis liegt im Cache, bevor der
     Nutzer überhaupt aufs Extension-Icon klickt. */
  /* --- EAN vorab, getrennt von der Analyse ---------------------------------
     Der Chip steht sofort, die Katalog-EAN kam aber bisher erst mit
     /api/ext/analyze — und die braucht mehrere Sekunden, weil sie nebenbei
     Buy-Box-Preise aus vier Marktplaetzen, Gebuehren und Verkaufszahlen holt
     (gemessen bis 11 s). So lange trugen die Links zu idealo und Google die
     ASIN, und wer vorher klickte, suchte nach der ASIN statt nach dem Produkt.
     /api/ext/ean macht nur den einen Katalog-Aufruf (~0,6 s, danach aus dem
     Cache) und baut den Chip mit der richtigen EAN neu auf. Die Analyse laeuft
     davon unberuehrt weiter — faellt dieser Aufruf aus, greift wie bisher der
     Katalogwert aus der Analyse. */
  function prefetchEan(asin) {
    if (state.catalogEan) return;
    api("/api/ext/ean?asin=" + encodeURIComponent(asin)).then((r) => {
      if (!r || !r.ok || !r.data || !r.data.ean) return;
      if (state.catalogEan) return;            // Analyse war schneller
      if (state.asin && state.asin !== asin) return;  // Produkt inzwischen gewechselt
      state.catalogEan = r.data.ean;
      const chip = document.getElementById(CHIP_ID);
      if (chip && !chip.querySelector(".axx-cp.ean")) buildChip();
    }).catch(() => { /* still bleiben: der Chip funktioniert auch ohne */ });
  }

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

  /* Die aktuell beste EAN: erst die Seite, dann der Amazon-Katalog.
     Amazon zeigt die EAN auf der PDP oft gar nicht an, im Katalog steht sie
     trotzdem — der Katalogwert kommt aus dem Prefetch. */
  function besteEan() {
    const eans = findEans();
    return eans.length ? eans[0] : (state.catalogEan || null);
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

    const ean = eans.length ? eans[0] : (state.catalogEan || null);

    // Der AX-Knopf oeffnet seit v1.8.0 das Extension-Popup (dasselbe wie ein
    // Klick aufs Icon oben rechts). chrome.action.openPopup() gibt es erst ab
    // Chrome 127 und nur aus dem Service-Worker heraus — klappt es nicht,
    // faellt der Knopf auf arbitragex.de im neuen Tab zurueck.
    let html = '<button class="axx-chip-ax" title="' +
      (IS_AMAZON ? "Arbitragex-Popup öffnen (oder oben rechts aufs Icon klicken)"
                 : "Diese EAN in Arbitragex suchen") + '">AX</button>';
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
      if (IS_AMAZON) {
        chrome.runtime.sendMessage({ type: "axx-open-popup" }, (r) => {
          // Kein Rueckfall bei Erfolg. Schlaegt openPopup fehl (aeltere
          // Chrome-Version, kein Nutzergesten-Kontext), lieber die Weboberflaeche.
          if (chrome.runtime.lastError || !r || !r.ok) {
            const t = "https://arbitragex.de/" + (ean ? "?ean=" + encodeURIComponent(ean) : "");
            window.open(t, "_blank", "noopener");
          }
        });
        return;
      }
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

  /* ======================================================================
     Draht zum Popup
     Das Popup kennt die Seite nicht — es fragt hier nach. "page" antwortet
     sofort (ASIN, EAN, Adresse), "analyze" wartet auf das Vorabladen und
     liefert damit meist ohne spuerbare Verzoegerung.
     ====================================================================== */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === "axx-page") {
      const info = pageAsin();
      sendResponse({
        amazon: IS_AMAZON,
        asin: IS_AMAZON ? (getAsin() || info.asin) : info.asin,
        ean: besteEan(),
        url: location.href,
        title: document.title
      });
      return; // synchron beantwortet
    }

    if (msg.type === "axx-analyze") {
      const asin = getAsin();
      if (!IS_AMAZON || !asin) { sendResponse({ step: "noasin" }); return; }
      if (state.asin !== asin || !state.prefetch) prefetch(asin);
      state.prefetch.then((r) => sendResponse(r)).catch((e) =>
        sendResponse({ step: "error", error: String((e && e.message) || e) }));
      return true; // asynchron
    }

    if (msg.type === "axx-reload") {
      // Das Popup hat einen neuen Versuch angefordert (z. B. nach Login).
      const asin = getAsin();
      state.prefetch = null;
      if (asin) prefetch(asin);
      sendResponse({ ok: true });
      return;
    }
  });

  /* --- Init ---------------------------------------------------------------- */
  function init() {
    buildChip();
    if (!IS_AMAZON) return;     // fremde Seite: nur EAN, kein Katalog-Abruf
    const asin = getAsin();
    if (asin) {
      prefetchEan(asin);        // schnell, korrigiert die Links im Chip
      prefetch(asin);           // <- ohne Zutun, direkt beim Laden
    }
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
        // Nur bei echtem Produktwechsel neu laden.
        if (asin && asin !== state.asin) {
          state.prefetch = null; state.catalogEan = null;
          prefetchEan(asin);
          prefetch(asin);
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
  // (nachgeladene Styles, Tracking-Tags); dort wuerde der Beobachter den Chip
  // im Sekundentakt neu zeichnen.
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
