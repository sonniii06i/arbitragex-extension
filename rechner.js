/* Arbitragex Profit-Formel — EINE Stelle fuer Popup und Produktseiten-Panel.
 *
 * Identisch mit ext_profit.gewinn auf dem Server (Test tests/test_ext_profit_2710.py):
 *   gewinn = VK/(1+USt Zielland) − vf·(fix + satz·VK) − EK netto − Prep − Versand (FBM)
 * vf = 1, weil die USt auf Amazon-Gebuehren als Vorsteuer zurueckkommt (Betreiber 27.10.:
 * „eig wie SellerAmp“); o.vorsteuer === false rechnet sie als Kosten.
 * Gebuehrenmodell je Markt kommt von GET /api/ext/profit (Fees-API wie die Abrechnung:
 * FBA lokal/Pan-EU, FBA EFN, FBM; Digitalsteuer FR/IT/ES).
 * EK netto wie beim Einkauf (config.ek_to_netto): brutto aus DE ÷ (1+USt der ASIN, 7 % bei ermaessigter Ware), brutto aus dem
 * Ausland bleibt (keine deutsche Vorsteuer), netto unveraendert.
 */
(function (g) {
  const AUSLAND_TLD = /\.(co\.uk|fr|it|es|nl|pl|se|be|at|ch|ie|pt|dk|cz)(?![a-z])/i;

  function einkaufsland(url) {
    const m = AUSLAND_TLD.exec(String(url || "").toLowerCase());
    return m ? (m[1] === "co.uk" ? "uk" : m[1]) : "de";
  }

  /* Gebuehr = fix + satz·VK stimmt nur am Preis, an dem das Modell gebildet wurde (preis_basis).
     Amazon staffelt nach Preis (z. B. Baby/Beauty 8 % bis 10 €, 15 % darueber; FBA-Niedrigpreistarif).
     Deshalb holt exaktHolen() beim eingetragenen VK die echten Modelle vom Server (m.exakt[preis]). */
  const pk = (vk) => (Math.round(vk * 100) / 100).toFixed(2);

  function modell(m, kanal, efn, vk) {
    const wahl = (q) => !q ? null : kanal === "fbm" ? q.modell_fbm : (efn ? q.modell_efn : q.modell_lokal);
    const ex = vk > 0 && m && m.exakt ? wahl(m.exakt[pk(vk)]) : null;
    return ex && ex.ok ? ex : wahl(m);
  }

  function istExakt(mod, vk) {
    return !!mod && mod.preis_basis != null && Math.abs(mod.preis_basis - vk) < 0.005;
  }

  const laeuft = {}, fehlschlag = {};
  // api: (pfad) => Promise<{ok, data}> (Background-Proxy); fertig(): neu rechnen. true = Abruf laeuft.
  function exaktHolen(api, d, mk, vk, fertig) {
    const m = d && d.maerkte && d.maerkte[mk];
    if (!m || !m.vorhanden || !d.exakt_abruf || !(vk > 0) || vk > 100000) return false;
    const key = pk(vk);
    if (m.exakt && m.exakt[key]) return false;
    const lok = m.modell_lokal || m.modell_fbm;
    if (lok && lok.ok && istExakt(lok, vk)) return false;
    const lk = d.asin + "|" + mk + "|" + key;
    if (laeuft[lk]) return true;
    if (fehlschlag[lk] && Date.now() - fehlschlag[lk] < 60000) return false;
    laeuft[lk] = 1;
    api("/api/ext/profit?asin=" + encodeURIComponent(d.asin) + "&mk=" + mk + "&vk=" + key).then((r) => {
      delete laeuft[lk];
      if (r && r.ok && r.data && r.data.exakt) {
        m.exakt = m.exakt || {};
        m.exakt[key] = r.data;
        if (fertig) fertig();
      } else fehlschlag[lk] = Date.now();
    });
    return true;
  }

  // m: Markt aus /api/ext/profit; vk: Verkaufspreis brutto; ek: Eingabe (oder null)
  // o: { kanal: "fba"|"fbm", efn, ekNetto, land, ekUst, prep, ziel, menge, versand, vorsteuer }
  function rechne(m, efnAlt, vk, ek, o) {
    // Alte Signatur rechne(m, efn, vk, ek, o) bleibt gueltig
    const kanal = o.kanal || "fba";
    const efn = o.efn != null ? o.efn : efnAlt;
    const mod = modell(m, kanal, efn, vk);
    if (!mod || !mod.ok) return { ok: false, fehler: (kanal === "fba" && efn ? "EFN-Gebühren nicht ermittelbar" : "Gebühren nicht ermittelbar") + (mod && mod.fehler ? ": " + mod.fehler : "") };
    if (vk == null || !(vk > 0)) return { ok: false, fehler: "VK eintragen" };
    const ust = o.ekUst || 19;
    const vonEingabe = (x) => o.ekNetto ? x : (o.land !== "de" ? x : x / (1 + ust / 100));
    const zuEingabe = (x) => o.ekNetto ? x : (o.land !== "de" ? x : x * (1 + ust / 100));
    const vf = o.vorsteuer === false ? mod.vf : 1;
    const prep = kanal === "fbm" ? 0 : (o.prep || 0);
    const versand = kanal === "fbm" ? (o.versand || 0) : 0;
    const r = (o.ziel || 0) / 100;
    // USt auf den Verkauf: OSS = Satz des Ziellands, DE = deutsche USt (unter der Lieferschwelle)
    // Pan-EU/lokaler FBA-Versand = Lieferung aus dem Lager im Land -> immer USt des Landes (1.9.17)
    const modusVk = ustModus(kanal, efn, o.ustModus);
    const satzVk = (modusVk === "de" ? m.ust_de : modusVk === "oss" ? m.ust_oss : null) ?? m.ust ?? 19;
    const uVk = satzVk / 100;
    const gebuehrNetto = mod.fix + mod.satz * vk;
    const gebuehr = vf * gebuehrNetto;
    const vkNetto = vk / (1 + uVk);
    const vorEk = vkNetto - gebuehr - prep - versand;
    const nenner = 1 / (1 + uVk) - vf * mod.satz;
    const out = { ok: true, kanal, efn: kanal === "fba" && !!(efn && m.modell_efn), gebuehr, gebuehrNetto,
                  gebuehrUst: (mod.vf - 1) * gebuehrNetto, vorsteuerGebuehren: vf === 1, vkNetto,
                  vkUst: vk - vkNetto, vkUstSatz: satzVk, vkUstModus: modusVk, prep, versand,
                  maxEk: zuEingabe(Math.max((vorEk - prep * r) / (1 + r), 0)),
                  breakEvenEk: zuEingabe(Math.max(vorEk, 0)),
                  auszahlung: vk - mod.vf * gebuehrNetto,
                  // exakt: Gebuehr stammt von Amazon fuer genau diesen VK; sonst vom Buy-Box-Preis hochgerechnet
                  exakt: istExakt(mod, vk), fbaFehlt: kanal !== "fbm" && !!mod.fba_fehlt,
                  fbaTarif: kanal !== "fbm" && mod.fba_quelle === "tarifkarte",
                  aufstellung: aufstellung(m, mod, vk, kanal) };
    if (ek != null && ek > 0) {
      const ekNet = Math.round(vonEingabe(ek) * 100) / 100;
      out.ekNetto = ekNet;
      out.gewinn = vorEk - ekNet;
      out.roi = (ekNet + prep) > 0 ? out.gewinn / (ekNet + prep) * 100 : null;
      out.marge = vkNetto > 0 ? out.gewinn / vkNetto * 100 : null;
      out.breakEvenVk = nenner > 0 ? (vf * mod.fix + ekNet + prep + versand) / nenner : null;
      const n = Math.max(1, Math.floor(o.menge || 1));
      out.menge = n;
      out.gesamt = out.gewinn * n;
      out.einsatz = (ekNet + prep) * n;
    }
    return out;
  }

  /* Einzelne Gebuehren beim gewaehlten VK (netto). Die Provision skaliert mit dem Preis,
     FBA/Abschluss/EFN sind fix; Digitalsteuer FR auf alle, IT/ES nur auf die Provision. */
  function aufstellung(m, mod, vk, kanal) {
    const det = mod.details || [];
    const betrag = (t) => det.filter((d) => d.type === t).reduce((s, d) => s + (d.amount || 0), 0);
    const basis = mod.preis_basis || vk;
    const prov = basis > 0 ? betrag("ReferralFee") / basis * vk : 0;
    const zeilen = [["Verkaufsprovision", prov]];
    const absch = betrag("VariableClosingFee") + betrag("PerItemFee") + betrag("FixedClosingFee");
    if (absch) zeilen.push(["Abschlussgebühr", absch]);
    if (kanal !== "fbm") zeilen.push([mod.efn ? "FBA-Versand (EFN)" : "FBA-Versand", betrag("FBAFees")]);
    const efnZ = betrag("EFNNichtCEPZuschlag");
    if (efnZ) zeilen.push(["Zuschlag ohne CEP", efnZ]);
    const dstSatz = mod.dst_satz || 0;
    if (dstSatz) {
      const dstBasis = det.some((d) => d.type === "DigitalServicesFee") && betrag("DigitalServicesFee") > betrag("ReferralFee") * dstSatz + 0.01
        ? zeilen.reduce((s, z) => s + z[1], 0) : prov + absch;
      zeilen.push(["Digitalsteuer " + Math.round(dstSatz * 100) + " %", dstBasis * dstSatz]);
    }
    return zeilen;
  }

  // Mehrere Preise auf einmal (Preise der anderen Verkaeufer): ein Abruf je 6 Preise.
  function exaktHolenMehr(api, d, mk, preise, fertig) {
    const m = d && d.maerkte && d.maerkte[mk];
    if (!m || !m.vorhanden || !d.exakt_abruf) return false;
    const lok = m.modell_lokal || m.modell_fbm;
    const offen = [];
    (preise || []).forEach((vk) => {
      if (!(vk > 0) || vk > 100000) return;
      const key = pk(vk), lk = d.asin + "|" + mk + "|" + key;
      if ((m.exakt && m.exakt[key]) || (lok && lok.ok && istExakt(lok, vk)) || laeuft[lk]) return;
      if (fehlschlag[lk] && Date.now() - fehlschlag[lk] < 60000) return;
      if (!offen.includes(key)) offen.push(key);
    });
    if (!offen.length) return false;
    for (let i = 0; i < offen.length && i < 18; i += 6) {
      const teil = offen.slice(i, i + 6);
      teil.forEach((key) => { laeuft[d.asin + "|" + mk + "|" + key] = 1; });
      api("/api/ext/profit?asin=" + encodeURIComponent(d.asin) + "&mk=" + mk + "&vk=" + teil.join(";")).then((r) => {
        teil.forEach((key) => { delete laeuft[d.asin + "|" + mk + "|" + key]; });
        const liste = r && r.ok && r.data && r.data.exakt ? (r.data.liste || [r.data]) : null;
        if (!liste) { teil.forEach((key) => { fehlschlag[d.asin + "|" + mk + "|" + key] = Date.now(); }); return; }
        m.exakt = m.exakt || {};
        liste.forEach((x) => { if (x && x.vk > 0) m.exakt[pk(x.vk)] = x; });
        if (fertig) fertig();
      });
    }
    return true;
  }

  /* Kennzahlen eines Markts als sechs Zellen — EINE Stelle für Panel und Popup (11.11.2026, Betreiber:
     Freigabe, BSR, Angebote und Sales stehen über den Eingaben). d: Antwort von /api/ext/profit,
     badgeSeite: Text des Verkäufe-Abzeichens von der Produktseite (oder null), basis: arbitragex.de. */
  function fakten(d, mk, badgeSeite, basis) {
    const m = (d && d.maerkte && d.maerkte[mk]) || {};
    const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const zahl = (n) => Number(n).toLocaleString("de-DE");
    const zelle = (titel, wert, klein, tip) => '<div class="fk"' + (tip ? ' title="' + esc(tip) + '"' : "") + "><i>" + titel + "</i><b>" + wert + "</b>" +
      (klein ? "<small>" + klein + "</small>" : "") + "</div>";
    const frei = m.frei === true ? '<span class="pos">Ja</span>' : m.frei === false ? '<span class="neg">Nein</span>' : '<span class="mut">unbekannt</span>';
    const rang = mk === "de" && d.bsr && d.bsr.rank ? d.bsr.rank : m.rang;
    const badge = badgeSeite ? { text: badgeSeite, quelle: "pdp" } : m.badge;
    let badgeKurz = null;
    if (badge && badge.text) {
      const t = String(badge.text).match(/([\d.,]+)\s*(k|tsd)?\+?/i);
      badgeKurz = !t ? badge.text : (t[2] ? zahl(Math.round(parseFloat(t[1].replace(",", ".")) * 1000)) : t[1]) + "+";
    }
    const kp = m.keepa || {}, s = m.sales_andere || {};
    const gesperrt = d.abo === false;                           // Keepa-Werte nur mit Abo (Keepa-AGB)
    const andere = s.pro_monat != null ? "~" + zahl(s.pro_monat) : null;
    const keepa = !gesperrt && kp.verkauft_monat != null ? "~" + zahl(kp.verkauft_monat) : null;
    let schaetzWert = keepa || andere || '<span class="mut">' + (s.beobachtungen ? "läuft" : "noch keine") + "</span>";
    let schaetzKlein = (keepa ? "Keepa" + (andere ? ", Bestand " + andere : "")
      : andere ? "aus Bestandsdrops" : (gesperrt ? '<a href="' + basis + '/billing?src=extension-keepa" target="_blank" rel="noopener">Keepa mit Abo</a>' : "Messung je Besuch")) +
      (keepa || andere ? " / Monat" : "");
    let schaetzTip = "Keepa: geschätzte Verkäufe je Monat (aus Delta). Bestand: Rückgänge im Bestand anderer Verkäufer zwischen zwei Besuchen" +
      (s.beobachtungen ? " (" + s.beobachtungen + " Messungen, " + (s.seller || 0) + " Verkäufer)" : "");
    // 1.9.25: vorsichtige Sales-Schätzung des Servers (sales_schaetzer.py). Untergrenzen sind beobachtet
    // (Abzeichen, eigene Sales, Bestandsdrops, BSR-Sprünge), Schätzungen sind Modelle (BSR-Kurve, Bewertungen
    // der letzten 45 Tage). Es gilt die kleinste Schätzung, nie weniger als die größte Untergrenze.
    let sx = m.sales && !m.sales.fehler ? m.sales : null;
    // Das Abzeichen der offenen Seite kennt der Server beim ersten Laden noch nicht: es gilt sofort.
    const bz = badgeKurz ? parseInt(String(badgeKurz).replace(/\D/g, ""), 10) : null;
    // 1.9.30: Das Abzeichen ist eine Untergrenze („50+“). Belegt eine andere Untergrenze mehr (Keepa, eigene Sales,
    // Bestandsdrops), gilt die höhere – wie auf dem Server (sales_schaetzer.schaetzung).
    if (sx && bz && sx.art !== "badge") {
      const oben = (sx.teile || []).filter((t) => t.typ === "untergrenze" && t.k !== "badge" && t.wert > bz)
        .sort((a, b) => b.wert - a.wert)[0];
      sx = oben
        ? Object.assign({}, sx, { pro_monat: oben.wert, art: "untergrenze", kurz: oben.name,
            hinweise: (sx.hinweise || []).concat(["Abzeichen " + zahl(bz) + "+, " + oben.name + " belegt mehr: " + zahl(oben.wert)]) })
        : Object.assign({}, sx, { pro_monat: bz, art: "badge", kurz: "Amazon-Abzeichen" });
    }
    if (sx) {
      const teile = (sx.teile || []).filter((t) => t.wert != null);
      if (sx.pro_monat != null) {
        schaetzWert = (sx.art === "schaetzung" ? "~" : "≥ ") + zahl(sx.pro_monat);
        schaetzKlein = (sx.art === "schaetzung" ? "vorsichtig, " : "mind., ") + esc(sx.kurz || "") + " / Monat";
      } else {
        schaetzWert = '<span class="mut">noch keine</span>';
        schaetzKlein = gesperrt ? '<a href="' + basis + '/billing?src=extension-keepa" target="_blank" rel="noopener">BSR-Kurve mit Abo</a>' : "zu wenig Daten";
      }
      schaetzTip = "Vorsichtige Schätzung der Verkäufe je Monat. Es gilt die kleinste Schätzung, nie weniger als der größte beobachtete Mindestwert. Das Amazon-Abzeichen zählt als Mindestwert.\n" +
        (teile.length ? teile.map((t) => "· " + t.name + ": " + (t.typ === "untergrenze" ? "mind. " : "~") + zahl(t.wert) + " (" + t.text + ")").join("\n")
          : "Noch keine Quelle mit Daten: kein Abzeichen, kein Rangverlauf, keine Bewertungen gelesen.") +
        ((sx.hinweise || []).length ? "\n" + sx.hinweise.map((h) => "· " + h).join("\n") : "");
    }
    return '<div class="fakten">' +
      zelle("Freigabe", frei, m.frei === false ? "Freischaltung nötig" : "", m.frei === false ? (m.frei_detail || "") : "") +
      zelle("BSR", rang ? "#" + zahl(rang) : "—", "", mk === "de" && d.bsr ? (d.bsr.kategorie || "") : "Rang in der Unterkategorie") +
      zelle("Angebote", (m.fba_anzahl || 0) + " FBA, " + (m.fbm_anzahl || 0) + " FBM", m.amazon_dabei ? '<span class="neg" title="Amazon verkauft selbst">Amazon ist dabei</span>' : "") +
      zelle("Sales-Badge", badgeKurz ? '<span class="pos">' + esc(badgeKurz) + "</span>" : '<span class="mut">keins</span>', badgeKurz ? "im letzten Monat" : "",
            badge ? badge.text + " (Quelle: " + (badge.quelle === "delta" ? "Delta" : "Produktseite") + ")" : "Amazon zeigt auf dieser Seite kein Verkäufe-Abzeichen") +
      zelle("Sales-Schätzung", schaetzWert, schaetzKlein, schaetzTip) +
      zelle("Deine Sales", (m.eigene_sales_30t || 0) + " Stk", "in 30 Tagen") +
      "</div>";
  }

  /* USt-Satz je ASIN und Land (ab 1.9.16). Der Server nennt je Markt den Satz DIESER ASIN (ust_oss fuer das
     Land des Markts, ust_de fuer Fernverkauf mit deutscher USt), woher er stammt (ust_quelle: "amazon" = von
     Amazon in den eigenen Bestellungen ausgewiesen, "manuell" = hier gewaehlt, "standard" = Regelsatz) und
     welche Saetze es im Land gibt (ust_wahl). Amazon nennt den Satz sonst nirgends, daher die Wahl von Hand. */
  const MARKT_LAND = { de: "DE", fr: "FR", it: "IT", es: "ES" };
  /* Welche USt gilt fuer den Verkauf? FBA aus dem Lager im Verkaufsland (Pan-EU/lokal) ist eine Lieferung im Land:
     immer der Satz des Landes. Nur bei Versand aus Deutschland (EFN, FBM) zaehlt die Einstellung OSS | DE-USt. */
  function ustModus(kanal, efn, modus) {
    return (kanal || "fba") === "fba" && !efn ? "oss" : (modus === "de" ? "de" : modus === "oss" ? "oss" : modus);
  }
  // Beide Knoepfe am VK-Feld: Umschalter OSS/DE-USt (nur Auslandsmarkt, bei Pan-EU fest) + Satz des Produkts
  function ustKnoepfe(d, mk, kanal, efn, modus) {
    const lokal = ustModus(kanal, efn, "de") === "oss";
    let u = "";
    if (mk !== "de") u = lokal
      ? '<span class="ustk fest" title="Pan-EU / lokaler FBA-Versand: Die Ware geht aus dem Lager im Land an den Kunden, es gilt immer die USt des Landes. Die Wahl OSS oder DE-USt zählt nur bei Versand aus Deutschland (EFN, FBM).">lokal</span>'
      : '<button type="button" class="ustk" data-ust="' + (modus === "de" ? "oss" : "de") + '" title="USt auf den Verkauf bei Versand aus Deutschland: OSS = Satz des Ziellands, DE-USt = deutscher Satz (unter der Lieferschwelle). Klick schaltet um.">' + (modus === "de" ? "DE-USt" : "OSS") + "</button>";
    return u + ustKnopf(d, mk, ustModus(kanal, efn, modus || "oss"));
  }
  const pz = (x) => String(x).replace(".", ",") + " %";
  function ustStand(m, mk, modus) {
    const de = modus === "de" && mk !== "de";
    return { land: de ? "DE" : (MARKT_LAND[mk] || String(mk).toUpperCase()),
             satz: (de ? m.ust_de : m.ust_oss) ?? m.ust ?? 19,
             quelle: (de ? m.ust_quelle_de : m.ust_quelle) || "standard",
             wahl: (de ? m.ust_wahl_de : m.ust_wahl) || [] };
  }
  function ustKnopf(d, mk, modus) {
    const m = d && d.maerkte && d.maerkte[mk];
    if (!m) return "";
    const s = ustStand(m, mk, modus);
    if (!s.wahl.length) return "";                       // aelterer Server ohne Satz je ASIN
    if (s.quelle === "amazon")
      return '<span class="ustk fest" title="USt-Satz laut Amazon: so hat Amazon dieses Produkt in deinen Bestellungen nach ' + s.land + ' besteuert.">' + pz(s.satz) + "</span>";
    const i = s.wahl.findIndex((x) => Math.abs(x - s.satz) < 0.01);
    const next = s.wahl[(i + 1) % s.wahl.length];
    const deM = d.maerkte.de, deErm = deM && deM.ust_wahl && deM.ust_oss != null && deM.ust_oss < deM.ust_wahl[0];
    const pruefen = s.land !== "DE" && s.quelle === "standard" && deErm;
    return '<button type="button" class="ustk' + (pruefen ? " warn" : "") + '" data-ustsatz="' + next + '" data-ustland="' + s.land + '" title="USt-Satz dieses Produkts in ' + s.land + ": " + pz(s.satz) +
      (s.quelle === "manuell" ? " (von dir gewählt)" : " (Regelsatz)") + ". Klick wechselt auf " + pz(next) + "." +
      (pruefen ? " In DE gilt für dieses Produkt ein ermäßigter Satz – bitte den Satz für " + s.land + " prüfen." : "") +
      ' Weist Amazon in deinen Bestellungen einen Satz aus, gilt der.">' + pz(s.satz) + "</button>";
  }
  // Antwort des Servers auf die Wahl in die geladenen Daten uebernehmen (ohne neu zu laden)
  function ustGewaehlt(d, land, satz, quelle) {
    Object.keys((d && d.maerkte) || {}).forEach((k) => {
      const m = d.maerkte[k];
      if (land === "DE") { m.ust_de = satz; m.ust_quelle_de = quelle; }
      if (MARKT_LAND[k] === land) { m.ust_oss = satz; m.ust_quelle = quelle; }
    });
    if (land === "DE") d.ek_ust = satz;                  // deutscher Brutto-EK enthaelt denselben Satz
  }

  g.AxxRechner = { einkaufsland, rechne, modell, exaktHolen, exaktHolenMehr, istExakt, fakten, ustKnopf, ustGewaehlt, ustModus, ustKnoepfe };
})(typeof window !== "undefined" ? window : self);
