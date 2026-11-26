/* Arbitragex Automat (seit 1.9.13, 10./11.11.2026): Freischaltungen beantragen und Auszahlungen anfordern –
 * im Browser des Kunden, mit seiner eigenen Seller-Central-Sitzung (Betreiber: „per requests im Browser
 * vom Kunden“). Läuft im Service-Worker (background.js lädt diese Datei per importScripts), alle 2 h
 * über chrome.alarms oder auf Klick im Popup. Eingeschaltet wird nur im ArbitrageX-Konto (Opt-in je
 * Funktion, Auszahlungs-Takt je Konto); das Popup erteilt nur die Chrome-Berechtigung und zeigt den Stand.
 *
 * Ablauf je Lauf:
 *   1. Aufträge von Arbitragex holen (/api/ext/automat/auftraege, Login-Cookie) – erster Lauf je Konto ist
 *      ein Trockenlauf (nichts hochladen, nichts anfordern), danach scharf.
 *   2. Seller Central lesen: welches Konto, welcher Marktplatz (/account-switcher/…/merchantMarketplace);
 *      Marktwechsel per /home?mons_sel_mkid=… (wie der Konto-Wechsler), Erfolg wird nachgelesen.
 *   3. Freischaltung: Antragsseite → POST /hz/approvalrequest?asin=… (Entwurf) → Formular lesen
 *      (getRestrictionForm) → Rechnungen aus Arbitragex hochladen (/documents/upload/) → absenden
 *      (approvalEndpoint). Fragen im Formular beantwortet der Automat nicht (Meldung an Arbitragex).
 *   4. Auszahlung je Markt: Tagesauszahlung einschalten, wenn Amazon es anbietet, sonst Auszahlung
 *      anfordern (/payouts/api/disbursenow). Verlangt Amazon eine frische Anmeldung (die Auszahlungsseite
 *      leitet auf /ap/signin mit max_auth_age=300), meldet der Automat „anmeldung_noetig“ – Passwörter
 *      tippt er nie, der Kunde meldet sich selbst an und klickt „Jetzt ausführen“.
 *   5. Jedes Ergebnis geht einzeln an /api/ext/automat/ergebnis, am Ende „lauf_ende“.
 * Fehlschläge werden als Fehler gemeldet, nie als „nichts zu tun“.
 */
const AXA = {
  SC: "https://sellercentral.amazon.de",
  ORIGINS: ["https://sellercentral.amazon.de/*"],
  ALARM: "axx-automat",
  TAKT_MIN: 120,              // alle 2 h: ein angekündigter Einkauf soll zügig in allen Regionen beantragt sein
  JE_LAUF: 6,                 // Entwürfe + Einreichungen je Lauf (jeder braucht mehrere Seitenaufrufe)
  RECHNUNG_MIME: { "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png" },
  laeuft: false,
};

/* --- Arbitragex ----------------------------------------------------------------------------------------- */
async function axaApi(path, method, body) {
  const b = await base();
  const opts = { method: method || "GET", credentials: "include", headers: { Accept: "application/json" } };
  if (body != null) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const r = await fetch(b + path, opts);
  let data = null;
  try { data = await r.json(); } catch (e) { /* leer */ }
  return { ok: r.ok, status: r.status, data };
}
function axaMelden(d) { return axaApi("/api/ext/automat/ergebnis", "POST", d).catch(() => ({ ok: false })); }

/* --- Seller Central ------------------------------------------------------------------------------------- */
function scAbgemeldet(r) { try { return new URL(r.url).pathname.startsWith("/ap/"); } catch (e) { return false; } }
function scGet(path, opts) {
  return fetch(AXA.SC + path, Object.assign({ credentials: "include", redirect: "follow" }, opts || {}));
}
async function scJson(path, method, body, csrf) {
  const h = { Accept: "application/json, text/plain, */*" };
  if (body != null) h["Content-Type"] = "application/json";
  if (csrf) h["anti-csrftoken-a2z"] = csrf;
  const r = await fetch(AXA.SC + path, { method: method || "GET", credentials: "include", headers: h,
                                         body: body == null ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  const i = text.indexOf("{");
  if (i >= 0) { try { json = JSON.parse(text.slice(i)); } catch (e) { json = null; } }
  return { status: r.status, url: r.url, abgemeldet: scAbgemeldet(r), json, text: text.slice(0, 400) };
}
function scCsrf(html) {
  // 1.9.31: Amazon schreibt Attribute mal mit " und mal mit ' – beide lesen
  const m = html.match(/<meta[^>]+name=["']anti-csrftoken-a2z["'][^>]+content=["']([^"']+)["']/) ||
            html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']anti-csrftoken-a2z["']/) ||
            html.match(/name=["']anti-csrftoken-a2z["'][^>]+value=["']([^"']+)["']/);
  return m ? m[1] : "";
}
// 1.9.31: Der Antragsknopf ist ein Formular mit verstecktem Feld appFormPageCsrfToken. Ohne das Feld antwortet Amazon 403.
function fsFormToken(html) {
  const m = html.match(/name=["']appFormPageCsrfToken["'][^>]*value=["']([^"']*)["']/) ||
            html.match(/value=["']([^"']*)["'][^>]*name=["']appFormPageCsrfToken["']/);
  return m ? m[1] : "";
}
const FS_SOFORT_FREI = /Antrag auf Freischaltung ist genehmigt|application (?:to sell|for approval)[^.]{0,60}(?:is|has been) approved|demande[^.]{0,60}approuv|richiesta[^.]{0,60}approvat|solicitud[^.]{0,60}aprobad/i;
const SC_RECHTE = /Zugriff erforderlich|Access required|not authorized|nicht berechtigt/;

async function scKonto() {
  const r = await scGet("/account-switcher/global-and-regional-account/merchantMarketplace", { headers: { Accept: "application/json" } });
  if (scAbgemeldet(r)) return { fehler: "nicht in Seller Central angemeldet" };
  let j = null;
  try { j = await r.json(); } catch (e) { return { fehler: "Seller Central antwortet nicht (HTTP " + r.status + ")" }; }
  const reg = (j && j.regionalAccount) || {}, glob = (j && j.globalAccount) || {};
  const ids = reg.ids || {};
  if (!ids.mons_sel_dir_mcid || !glob.id) return { fehler: "Konto-Wechsler ohne Kennungen" };
  return { mcid: ids.mons_sel_dir_mcid, paid: glob.id, mkid: ids.mons_sel_mkid, land: reg.countryCode, label: glob.label || "" };
}
/* Verkäufer-ID (z. B. A1GJ0O22GPHV8H) aus dem Guthaben-Schlüssel <seller>.<marketplace>.PAYABLE.<Währung>;
   null ohne Zahlungs-Recht – dann gilt nur eine frühere Bestätigung dieses Seller-Central-Kontos (kontoBestaetigen). */
async function scSellerId() {
  try {
    const r = await scJson("/payouts/api/balances");
    const m = (r.text || "").match(/"([A-Z0-9]{10,16})\.([A-Z0-9]{10,16})\.PAYABLE\.([A-Z]{3})"/);
    return m ? m[1] : null;
  } catch (e) { return null; }
}
async function scZuMarkt(konto, mk, ctx) {
  const id = ctx.mkIds[mk], land = ctx.laender[mk];
  if (!id || !land) return false;
  if (konto.land === land) return true;
  await scGet("/home?mons_sel_dir_mcid=" + encodeURIComponent(konto.mcid) + "&mons_sel_mkid=amzn1.mp.o." + id +
              "&mons_sel_dir_paid=" + encodeURIComponent(konto.paid) + "&ignore_selection_changed=true");
  const k = await scKonto();
  if (k.land === land) { konto.land = land; return true; }
  return false;
}

/* --- Freischaltung -------------------------------------------------------------------------------------- */
function fsFormAuswerten(body) {
  const mm = body.moduleMap || {};
  const docs = [];
  for (const du of ((mm.DOCUMENT_REQUIREMENTS || {}).docUploads || [])) {
    const t2c = du.docTypeToClassIdMap || {};
    let reqs = du.requiredDocTypeList || [];
    if (typeof reqs === "string") { try { reqs = JSON.parse(reqs); } catch (e) { reqs = [reqs]; } }
    for (const dt of reqs) {
      const cid = t2c[dt] || Object.keys(du.classIdToDocTypeMap || {}).find((k) => k.startsWith(dt)) || null;
      const radio = (du.classIdToRadioStringMap || {})[cid] || "";
      const anf = du.requirementsStringsMap || {};
      const liste = Array.isArray(anf[cid]) ? anf[cid] : Object.values(anf);
      docs.push({ doc_type: dt, class_id: cid, text: String(radio).slice(0, 300),
                  anforderungen: liste.map((v) => String(v)).join(" ").slice(0, 800),
                  max: (du.classIdToNumberOfDocMap || {})[cid] });
    }
  }
  const fragen = [];
  for (const q of ((mm.QUESTIONNAIRE || {}).questionList || []).slice(0, 20)) {
    if (q && typeof q === "object") fragen.push({ id: q.questionId || q.id || "", typ: q.questionType || q.type || "",
      text: q.questionText || q.text || q.question || JSON.stringify(q).slice(0, 200) });
  }
  return { typ: body.applicationType, application_id: body.applicationId, doc_types: docs, fragen };
}
async function fsFormLesen(appId) {
  const r = await scGet("/sq/approvalrequest?applicationId=" + encodeURIComponent(appId));
  const html = await r.text();
  if (scAbgemeldet(r)) return { fehler: "Anmeldung verloren" };
  if (SC_RECHTE.test(html)) return { fehler: "HTTP 403 Recht „Produkte hinzufügen“ fehlt", rechte: true };
  if (FS_SOFORT_FREI.test(html)) return { frei: true };
  const csrf = scCsrf(html) || fsFormToken(html);
  let f = await scJson("/hz/getRestrictionForm?deviceType=DESKTOP", "POST", { applicationId: appId }, csrf);
  let body = f.json && ((f.json.result || f.json).body);
  if (!(body && body.moduleMap)) {
    f = await scJson("/hz/getRestrictionForm?applicationId=" + encodeURIComponent(appId) + "&deviceType=DESKTOP", "POST", { applicationId: appId }, csrf);
    body = f.json && ((f.json.result || f.json).body);
  }
  if (!(body && body.moduleMap)) {
    f = await scJson("/hz/getRestrictionForm?applicationId=" + encodeURIComponent(appId) + "&deviceType=DESKTOP", "GET", null, csrf);
    body = f.json && ((f.json.result || f.json).body);
  }
  if (!(body && body.moduleMap)) return { fehler: "Formular (getRestrictionForm) nicht lesbar: HTTP " + f.status };
  return { body, csrf };
}
async function fsListe(asin, csrf) {
  const r = await scJson("/hz/applications?filterBy=ALL&page=1&deviceType=DESKTOP&search=" + encodeURIComponent(asin), "GET", null, csrf);
  return (r.json && Array.isArray(r.json.applications)) ? r.json.applications : null;
}
async function fsAnlegen(a, konto, ctx) {
  const out = { art: "fs_form", antrag_id: a.antrag_id };
  if (!await scZuMarkt(konto, a.markt, ctx)) return Object.assign(out, { fehler: "Markt " + a.markt.toUpperCase() + " nicht sicher erreicht" });
  let pfad = "/hz/approvalrequest/restrictions/approve?asin=" + encodeURIComponent(a.asin);
  try { const u = new URL(a.link || ""); if (u.pathname.startsWith("/hz/")) pfad = u.pathname + u.search; } catch (e) { /* Standardpfad */ }
  const r = await scGet(pfad);
  const html = await r.text();
  if (scAbgemeldet(r)) return Object.assign(out, { fehler: "Anmeldung verloren" });
  if (SC_RECHTE.test(html)) return Object.assign(out, { fehler: "HTTP 403 Recht „Produkte hinzufügen“ fehlt", rechte: true });
  const knopf = /submit-request-approval|submitRequestApproval/i.test(html);
  if (!knopf) {
    if (/Sell yours|Dieses Produkt verkaufen|Vendre|Vendi|Vender/i.test(html) && !/approval|Freischaltung/i.test(html)) return Object.assign(out, { frei: true });
    if (/not accepting applications|keine Anträge|nicht angenommen werden|n'acceptons pas|non accettiamo|no aceptamos/i.test(html))
      return Object.assign(out, { fehler: "Amazon nimmt für dieses Produkt keine Anträge an" });
    return Object.assign(out, { fehler: "kein Antragsknopf: " + html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 160) });
  }
  // Knopf = POST auf /hz/approvalrequest?asin=… (Entwurf), Amazon leitet auf /sq/approvalrequest?applicationId=… um
  let url = "/hz/approvalrequest?asin=" + encodeURIComponent(a.asin);
  const m = html.replace(/&quot;/g, '"').match(/submitRequestApproval="?\{[^}]*"url":"([^"]+)"/i);
  if (m && m[1].startsWith("/hz/")) url = m[1];
  const tok = fsFormToken(html);
  const p = await fetch(AXA.SC + url, { method: "POST", credentials: "include", redirect: "follow",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(tok ? { appFormPageCsrfToken: tok } : {}).toString() });
  const t = await p.text();
  let appId = ((p.url || "").match(/application[-_]?[iI]d=([A-Za-z0-9-]{8,})/) || [])[1] ||
              (t.match(/application[-_]?[iI]d=([A-Za-z0-9-]{8,})/) || [])[1];
  // Amazon genehmigt manche Anträge sofort („aufgrund Ihrer Verkäuferleistung“) – dann gibt es kein Formular mehr
  if (p.ok && FS_SOFORT_FREI.test(t.replace(/<[^>]+>/g, " ")))
    return Object.assign(out, { frei: true, application_id: appId || null, meldung: "Amazon: sofort genehmigt (Verkäuferleistung)" });
  if (p.status === 403 && !appId) return Object.assign(out, { fehler: "Antrag abgelehnt: HTTP 403" + (tok ? "" : " (Formular-Token fehlt)") });
  if (!appId) {                                   // Entwurf besteht schon (z. B. vom Worker): jüngsten aus der Liste nehmen
    const liste = (await fsListe(a.asin, scCsrf(html))) || [];
    const d = liste.filter((x) => x && x.status === "DRAFT").sort((x, y) => String(y.dateChanged || "").localeCompare(String(x.dateChanged || "")))[0];
    appId = d && d.applicationId;
  }
  if (!appId) return Object.assign(out, { fehler: "nach dem Antrag kein Entwurf (applicationId) – HTTP " + p.status });
  const f = await fsFormLesen(appId);
  if (f.frei) return Object.assign(out, { frei: true, application_id: appId, meldung: "Amazon: sofort genehmigt (Verkäuferleistung)" });
  if (f.fehler) return Object.assign(out, { application_id: appId }, f);
  return Object.assign(out, fsFormAuswerten(f.body), { application_id: appId });
}
async function fsUpload(du, docType, classId, dateien, csrf) {
  const sig = await scJson("/hz/approvalAlexandriaUtilityEndpoint?" + encodeURIComponent(classId) + "=" + encodeURIComponent(docType), "GET", null, csrf);
  const felder = sig.json && sig.json.body;
  if (!felder || typeof felder !== "object") throw new Error("Upload-Signatur HTTP " + sig.status);
  const ziel = AXA.SC + (du.formUploadUrl || "/documents/upload/");
  const out = {};
  for (const d of dateien) {
    const fd = new FormData();
    fd.append("_utf8_enable", "✓");
    for (const [k, v] of Object.entries(felder)) fd.append(k, String(v));
    fd.append(docType, d.blob, d.name);
    const r = await fetch(ziel, { method: "POST", credentials: "include", body: fd, headers: { Accept: "application/json" } });
    const t = await r.text();
    let j = {};
    const i = t.indexOf("{");
    try { j = i >= 0 ? JSON.parse(t.slice(i)) : {}; } catch (e) { j = {}; }
    const e = (j && j[docType]) || {};
    if (!r.ok || !/200/.test(String(e.status || "")) || !e.documentVersionURN) throw new Error("Upload " + d.name + ": HTTP " + r.status + " " + t.slice(0, 160));
    out[e.documentVersionURN] = d.name;
  }
  return out;
}
async function fsRechnungen(ids) {
  const b = await base();
  const out = [];
  for (const rid of ids || []) {
    const r = await fetch(b + "/api/ext/automat/rechnung/" + encodeURIComponent(rid), { credentials: "include" });
    if (!r.ok) throw new Error("Rechnung " + rid + ": HTTP " + r.status);
    const blob = await r.blob();
    const mime = (r.headers.get("content-type") || blob.type || "").split(";")[0].trim();
    const ext = AXA.RECHNUNG_MIME[mime];
    if (!ext || !blob.size || blob.size > 10 * 1024 * 1024) throw new Error("Rechnung " + rid + " unbrauchbar (" + mime + ", " + blob.size + " B)");
    out.push({ name: "rechnung-" + rid + ext, blob });
  }
  return out;
}
async function fsEinreichen(a, konto, ctx, senden) {
  const out = { art: "fs_antrag", antrag_id: a.antrag_id, application_id: a.application_id, ok: false };
  if (!await scZuMarkt(konto, a.markt, ctx)) return Object.assign(out, { fehler: "Markt " + a.markt.toUpperCase() + " nicht sicher erreicht" });
  const f = await fsFormLesen(a.application_id);
  if (f.fehler) return Object.assign(out, f);
  const body = f.body, mm = body.moduleMap;
  const ci = (mm.CONTACT_INFO || {}).contactInfo;
  if (ci && typeof ci === "object" && a.email) ci.merchantEmail = a.email;
  const fragen = (mm.QUESTIONNAIRE || {}).questionList || [];
  if (fragen.length && !(a.antworten && Object.keys(a.antworten).length)) return Object.assign(out, { fehler: "Formular stellt Fragen – Automatik beantwortet sie nicht" });
  let rechnungen;
  try { rechnungen = await fsRechnungen(a.rechnungen); } catch (e) { return Object.assign(out, { fehler: String(e.message || e) }); }
  let hochgeladen = 0;
  for (const du of ((mm.DOCUMENT_REQUIREMENTS || {}).docUploads || [])) {
    const t2c = du.docTypeToClassIdMap || {};
    let reqs = du.requiredDocTypeList || [];
    if (typeof reqs === "string") { try { reqs = JSON.parse(reqs); } catch (e) { reqs = [reqs]; } }
    for (const dt of reqs) {
      const cid = t2c[dt];
      if (!cid) return Object.assign(out, { fehler: "Klasse für Dokumenttyp " + dt + " fehlt im Formular" });
      if (!/invoice|rechnung|factur|fattura/i.test(dt)) return Object.assign(out, { fehler: "Dokumenttyp " + dt + " kann die Automatik nicht liefern (nur Rechnungen)" });
      if (!rechnungen.length) return Object.assign(out, { fehler: "Dokumenttyp " + dt + " verlangt eine Rechnung – keine zugeordnet" });
      if (!senden) continue;
      let urns;
      try { urns = await fsUpload(du, dt, cid, rechnungen, f.csrf); } catch (e) { return Object.assign(out, { fehler: String(e.message || e), hochgeladen }); }
      const draft = du.classIdToDraftDocsMap || {};
      draft[cid] = Object.assign(draft[cid] || { docType: dt }, urns);
      du.classIdToDraftDocsMap = draft;
      hochgeladen += Object.keys(urns).length;
    }
  }
  if (!senden) return Object.assign(out, { fehler: "trockenlauf", probe: { rechnungen: rechnungen.length, fragen: fragen.length } });
  if (!f.csrf) return Object.assign(out, { fehler: "CSRF-Token der Antragsseite fehlt", hochgeladen });
  const s = await scJson("/hz/approvalEndpoint?", "POST", { body, isSubmit: true, callerIdentity: "STANDALONE_PAGE" }, f.csrf);
  const j = (s.json && typeof s.json === "object") ? s.json : {};
  const fehler = j.errorSubmitMessageList || [], erfolg = j.successSubmitMessageList || [];
  if (s.status >= 200 && s.status < 300 && !fehler.length) {
    return Object.assign(out, { ok: true, meldung: erfolg.map(String).join(" ").slice(0, 300) || "eingereicht",
                                amazon_status: String(j.applicationSubmissionStatus || "SUBMITTED"), hochgeladen });
  }
  return Object.assign(out, { fehler: ("approvalEndpoint HTTP " + s.status + ": " + (fehler.map(String).join(" ") || s.text)).slice(0, 300), hochgeladen });
}
async function fsStatus(liste, konto, ctx) {
  const out = [];
  const jeMarkt = {};
  for (const s of liste) (jeMarkt[s.markt] = jeMarkt[s.markt] || []).push(s);
  for (const mk of Object.keys(jeMarkt)) {
    if (!await scZuMarkt(konto, mk, ctx)) continue;
    const dash = await scGet("/hz/myqdashboard");
    if (scAbgemeldet(dash)) break;
    const csrf = scCsrf(await dash.text());
    for (const s of jeMarkt[mk]) {
      const apps = await fsListe(s.asin, csrf);
      if (!apps) continue;
      const t = apps.find((x) => x && x.applicationId === s.application_id);
      if (!t) continue;
      out.push({ art: "fs_status", antrag_id: s.antrag_id, application_id: s.application_id, amazon_status: t.status,
                 fall_id: t.caseId, meldung: String(t.statusMessage || t.actionButtonText || "").slice(0, 300) });
    }
  }
  return out;
}

/* --- Auszahlung ----------------------------------------------------------------------------------------- */
async function azMarkt(a, konto, ctx, senden) {
  const out = { art: "az", seller_id: a.seller_id, markt: a.markt, aktion: "probe" };
  if (!await scZuMarkt(konto, a.markt, ctx)) return Object.assign(out, { aktion: "fehler", fehler: "Markt " + a.markt.toUpperCase() + " nicht sicher erreicht" });
  const meta = await scJson("/payments/api/metadata");
  if (meta.abgemeldet) return Object.assign(out, { aktion: "fehler", fehler: "Anmeldung verloren" });
  if (meta.status === 401 || meta.status === 403) return Object.assign(out, { aktion: "rechte", fehler: "HTTP " + meta.status + " Recht „Zahlungen“ fehlt" });
  if (meta.status !== 200 || !meta.json) return Object.assign(out, { aktion: "fehler", fehler: "metadata HTTP " + meta.status });
  const feats = ((meta.json.metadata || meta.json).allowedFeatures) || {};
  const tages = !!feats.dailyDisbursementEnabled, optin = !!feats.allowDailyDisbursementOptIn;
  const bal = await scJson("/payouts/api/balances");
  let betrag = null, waehrung = null;
  try {
    const m = (bal.json || {}).estimatedPayoutBalanceMap || {};
    const erst = Object.values(m)[0];
    if (erst && typeof erst === "object") { betrag = Number(erst.value); waehrung = erst.unit; if (isNaN(betrag)) betrag = null; }
  } catch (e) { /* ohne Guthaben weiter */ }
  Object.assign(out, { betrag, waehrung, tagesauszahlung: tages });
  if (tages) return Object.assign(out, { aktion: "tagesauszahlung_aktiv" });
  if (optin) {
    if (!senden) return Object.assign(out, { hinweis: "Tagesauszahlung könnte eingeschaltet werden (Trockenlauf)" });
    const p = await scJson("/payments/api/preferences/daily-disbursement", "PUT", { optIn: true });
    if (p.status >= 200 && p.status < 300 && (!p.json || p.json.optedIn !== false)) return Object.assign(out, { aktion: "tagesauszahlung_an", tagesauszahlung: true });
    out.hinweis = "Opt-in HTTP " + p.status + ": " + p.text.slice(0, 120);
  }
  const el = await scJson("/payouts/api/eligibility");
  const j = el.json || {};
  const e = j.isEligibleResponse || (j.eligibilityMapper && Object.values(j.eligibilityMapper)[0]) || j;
  if (el.status !== 200 || !e || typeof e !== "object") return Object.assign(out, { aktion: "fehler", fehler: "eligibility HTTP " + el.status + ": " + el.text.slice(0, 120) });
  const gruende = (e.inEligibilityReasons || []).map((g) => String((g && g.stringId) || g));
  if (!e.allowDisburse) return Object.assign(out, { aktion: "nicht_moeglich", gruende: gruende.length ? gruende : ["allowDisburse=false"], protokoll: !!betrag });
  if (!senden) return Object.assign(out, { hinweis: "Auszahlung könnte angefordert werden (Trockenlauf)" });
  const d = await fetch(AXA.SC + "/payouts/api/disbursenow", { method: "POST", credentials: "include", redirect: "manual",
    headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ requesterType: "SellingPartner" }) });
  if (d.status >= 200 && d.status < 300) return Object.assign(out, { aktion: "angefordert" });
  if (d.type === "opaqueredirect" || d.status === 401 || d.status === 403 || d.status === 0) {
    return Object.assign(out, { aktion: "anmeldung_noetig", fehler: "Amazon verlangt für Auszahlungen eine frische Anmeldung – " +
      "Seller Central öffnen, anmelden und im Popup „Jetzt ausführen“ klicken (HTTP " + d.status + ")" });
  }
  return Object.assign(out, { aktion: "fehler", fehler: "disbursenow HTTP " + d.status + ": " + (await d.text()).slice(0, 160) });
}

/* --- Lauf ----------------------------------------------------------------------------------------------- */
async function axaRecht() {
  try {
    return (await chrome.permissions.contains({ origins: AXA.ORIGINS })) || (await chrome.permissions.contains({ origins: ["<all_urls>"] }));
  } catch (e) { return false; }
}
async function axaStand(st) {
  const alt = (await chrome.storage.local.get("axxAutomat")).axxAutomat || {};
  const neu = Object.assign({}, alt, st, { ts: Date.now() });
  try { await chrome.storage.local.set({ axxAutomat: neu }); } catch (e) { /* egal */ }
  return neu;
}
/* 1.9.28 (Sicherheitsprüfung 14.11.2026): Der Konto-Abgleich schließt zu. Vorher lief der Automat weiter, wenn die
   Verkäufer-ID in Seller Central nicht lesbar war und im Arbitragex-Konto genau ein Amazon-Konto hing – wer im Browser
   in einem ANDEREN Seller Central angemeldet war, hätte dort Anträge gestellt oder Auszahlungen angefordert.
   Jetzt läuft er nur, wenn
     a) die gelesene Verkäufer-ID zu einem verbundenen Konto gehört, oder
     b) die ID nicht lesbar ist (z. B. Nutzer ohne Recht „Zahlungen“), dieses Seller-Central-Konto (mcid + paid aus dem
        Konto-Wechsler) aber in einem früheren Lauf mit gelesener ID bestätigt wurde (sc_bindung vom Server).
   Rückgabe {seller} oder {stopp: Text}. */
function kontoBestaetigen(sellerId, konto, konten, bindungen) {
  const bekannt = (id) => !!id && (konten || []).some((k) => k && k.seller_id === id);
  if (sellerId) {
    return bekannt(sellerId) ? { seller: sellerId }
      : { stopp: "Seller Central zeigt ein anderes Konto (" + sellerId + ") als Arbitragex" };
  }
  const b = (bindungen || []).find((x) => x && x.mcid && x.paid && x.mcid === konto.mcid && x.paid === konto.paid && bekannt(x.seller_id));
  if (b) return { seller: b.seller_id };
  return { stopp: "Seller-Central-Konto nicht bestätigt: Die Verkäufer-ID ist nicht lesbar (fehlt das Recht „Zahlungen“?). " +
                  "Einmal als Hauptnutzer in Seller Central anmelden und „Jetzt ausführen“ klicken." };
}
async function automatLauf(grund) {
  if (AXA.laeuft) return { ok: false, text: "läuft gerade" };
  AXA.laeuft = true;
  const fehler = [];
  let nFs = 0, nAz = 0, trocken = true, sellerId = null;
  try {
    // Eingeschaltet wird nur im ArbitrageX-Konto (Betreiber 11.11.2026); der Server sagt, ob etwas zu tun ist.
    if (!await axaRecht()) return await axaStand({ text: "kein Zugriff auf Seller Central – im Popup erlauben", fehler: ["Berechtigung fehlt"] });
    const auf = await axaApi("/api/ext/automat/auftraege");
    if (auf.status === 401) return await axaStand({ text: "nicht bei Arbitragex angemeldet", fehler: ["Arbitragex-Login fehlt"] });
    if (auf.status === 402) return await axaStand({ text: "Abo nötig", fehler: ["Abo nötig"] });
    if (!auf.ok || !auf.data) return await axaStand({ text: "Arbitragex antwortet nicht (HTTP " + auf.status + ")", fehler: ["HTTP " + auf.status] });
    const d = auf.data;
    trocken = !!d.trocken;
    const ctx = { mkIds: d.mk_ids || {}, laender: d.laender || {} };
    const fsBlock = d.freischaltung || {};
    const azListe = d.auszahlung || [];
    if (!fsBlock.aktiv && !azListe.length) return await axaStand({ text: "nichts zu tun (im Arbitragex-Konto aus oder alles erledigt)", fehler: [] });
    const konto = await scKonto();
    if (konto.fehler) return await axaStand({ text: konto.fehler, fehler: [konto.fehler] });
    const start = konto.land;
    sellerId = await scSellerId();
    const konten = d.konten || [];
    const sc = { mcid: konto.mcid, paid: konto.paid };
    const pruefung = kontoBestaetigen(sellerId, konto, konten, d.sc_bindung);
    if (!pruefung.seller) {                                   // nichts hochladen, nichts beantragen, nichts anfordern
      const t = pruefung.stopp;
      await axaMelden({ art: "lauf_ende", trocken, freischaltung: 0, auszahlung: 0, fehler: [t], version: chrome.runtime.getManifest().version,
                        seller_id: sellerId || "", seller_gelesen: !!sellerId, sc });
      return await axaStand({ text: t, fehler: [t] });
    }
    const meinSeller = pruefung.seller;
    // Freischaltungen
    if (fsBlock.aktiv) {
      let rechte = false;
      for (const a of (fsBlock.einreichen || []).concat(fsBlock.anlegen || [])) {
        if (nFs >= AXA.JE_LAUF || rechte) break;
        if (a.seller_id && a.seller_id !== meinSeller) continue;      // Auftrag eines anderen Kontos
        nFs += 1;
        let e;
        try {
          e = (a.application_id && "rechnungen" in a) ? await fsEinreichen(a, konto, ctx, !trocken) : await fsAnlegen(a, konto, ctx);
        } catch (ex) {
          e = { art: ("rechnungen" in a) ? "fs_antrag" : "fs_form", antrag_id: a.antrag_id, fehler: String(ex && ex.message || ex).slice(0, 200) };
        }
        if (e.rechte) { rechte = true; await axaMelden({ art: "fs_rechte", seller_id: meinSeller, fehler: e.fehler }); fehler.push(e.fehler); break; }
        if (e.fehler === "trockenlauf") { fehler.push("Antrag " + a.antrag_id + ": Trockenlauf (" + JSON.stringify(e.probe) + ")"); continue; }
        if (e.fehler === "Anmeldung verloren") { fehler.push(e.fehler); break; }
        await axaMelden(e);
        if (e.fehler) fehler.push("Antrag " + a.antrag_id + ": " + e.fehler);
      }
      try {
        for (const e of await fsStatus(fsBlock.status || [], konto, ctx)) await axaMelden(e);
      } catch (ex) { fehler.push("Status: " + String(ex && ex.message || ex).slice(0, 160)); }
    }
    // Auszahlungen
    for (const a of azListe) {
      if (a.seller_id && a.seller_id !== meinSeller) continue;
      nAz += 1;
      let e;
      try { e = await azMarkt(a, konto, ctx, !trocken); }
      catch (ex) { e = { art: "az", seller_id: a.seller_id, markt: a.markt, aktion: "fehler", fehler: String(ex && ex.message || ex).slice(0, 200) }; }
      await axaMelden(e);
      if (e.fehler) fehler.push("Auszahlung " + String(a.markt).toUpperCase() + ": " + e.fehler);
      else if (e.hinweis) fehler.push("Auszahlung " + String(a.markt).toUpperCase() + ": " + e.hinweis);
      if (e.aktion === "rechte" || e.fehler === "Anmeldung verloren") break;
    }
    if (start && konto.land !== start) {                      // Seller Central wieder auf den Markt stellen, den der Kunde hatte
      const mk = Object.keys(ctx.laender).find((k) => ctx.laender[k] === start);
      if (mk) await scZuMarkt(konto, mk, ctx);
    }
    await axaMelden({ art: "lauf_ende", trocken, freischaltung: nFs, auszahlung: nAz, fehler, version: chrome.runtime.getManifest().version,
                      seller_id: sellerId || "", seller_gelesen: !!sellerId, sc });
    const text = (trocken ? "Trockenlauf: " : "") + nFs + " Antrag/Anträge, " + nAz + " Auszahlungsmarkt/-märkte" +
                 (fehler.length ? ", " + fehler.length + " Hinweis(e)" : "");
    return await axaStand({ text, fehler, trocken, nFs, nAz });
  } catch (ex) {
    const t = "Lauf abgebrochen: " + String(ex && ex.message || ex).slice(0, 200);
    await axaMelden({ art: "lauf_ende", trocken, freischaltung: nFs, auszahlung: nAz, fehler: fehler.concat([t]), version: chrome.runtime.getManifest().version, seller_id: sellerId });
    return await axaStand({ text: t, fehler: fehler.concat([t]) });
  } finally {
    AXA.laeuft = false;
  }
}
async function automatAlarm() {
  try {
    const a = await chrome.alarms.get(AXA.ALARM);
    if (!a) await chrome.alarms.create(AXA.ALARM, { delayInMinutes: 3, periodInMinutes: AXA.TAKT_MIN });
  } catch (e) { /* alarms fehlt (alte Chrome-Version): nur per Klick */ }
}
