# Arbitragex — Chrome-Extension

**Neu in 1.6.0** — die EAN wird jetzt auf *allen* Shop-Seiten erkannt, nicht mehr
nur auf Amazon. Auf fremden Seiten zeigt die Extension ausschliesslich den
EAN-Chip mit Kopierknopf und den Quick-Links (idealo/Amazon/Google); Panel und
Kalkulation bleiben Amazon vorbehalten, weil es dort keine ASIN gibt. Findet die
Extension auf einer fremden Seite keine gueltige EAN, erscheint gar nichts —
sie haengt also nicht auf jeder beliebigen Website im Bild.

Auch die ASIN wird auf fremden Seiten erkannt, sofern der Shop auf Amazon
verlinkt (Partnerlinks, "auch erhaeltlich bei"). Verweist eine Seite auf mehrere
verschiedene ASINs, wird bewusst keine ausgewaehlt — das waere geraten.

Auf Amazon aendert sich nichts: Steht die EAN nicht auf der Seite, holt sie das
Backend weiterhin ueber die SP-API aus dem Katalog (`/api/ext/analyze`).

Blendet auf jeder Amazon-Produktseite (DE/FR/IT/ES) ein Arbitragex-Panel ein:
Buy-Box je EU-Markt, Vorschlagspreis (+20/30 %), „verkaufe ich das schon?", und
zwei Aktionen — **Listing anlegen** und **An Prep ankündigen** — direkt aus der Seite.

Auth: **Login-Session** deiner Arbitragex-Instanz (Cookie). Kein API-Key nötig.

## Installation (unpacked)
1. Chrome → `chrome://extensions`
2. Oben rechts **Entwicklermodus** an.
3. **Entpackte Erweiterung laden** → Ordner `~/arbitragex-extension/` wählen.
4. Einmal auf **https://arbitragex.de** einloggen (im selben Chrome-Profil).
   Wichtig: nach dem Deploy einmal **neu einloggen**, damit das Session-Cookie
   `SameSite=None` gesetzt wird (sonst sendet Chrome es der Extension nicht).
5. Amazon-Produktseite öffnen → unten rechts das **AX**-Icon klicken.

## Konfiguration
Über das Extension-Popup (Icon in der Toolbar) lässt sich die Arbitragex-URL
ändern (Standard `https://arbitragex.de`) und der Login-Status prüfen.

## Aktionen
- **Listing anlegen** → nutzt `/api/listings/create` (Offer auf die ASIN, je Markt).
  Bei fehlender Freischaltung: klarer „Freischaltung nötig"-Hinweis.
- **An Prep ankündigen** → `/api/rebelprep/announce` (PrepBusiness/E-Mail/Mock je Config).

## Dateien
`manifest.json` (MV3) · `background.js` (Service-Worker, Cookie-Fetch) ·
`content.js` (Panel) · `panel.css` · `popup.html/js` · `icon128.png`

## Einkauf registrieren (v1.2.0)

Das Panel laedt die Produktdaten **schon beim Seitenaufruf** (nicht erst beim Klick),
zeigt alles ohne Ausklappen oder Scrollen und hat genau **einen** Button.

| Feld | Herkunft |
|---|---|
| Marktplatz-Kacheln DE/FR/IT/ES | Buy-Box live + daraus berechneter Listing-Preis (**Anzeige**) |
| Aufschlag | +20 / +30 / frei — steuert die angezeigten Preise |
| EK EUR / Stueck | manuell, akzeptiert `32,50` und `32.50`, hat den Fokus |
| Menge | manuell |
| VK EUR | Buy-Box DE vorbelegt, editierbar |
| Bestellnr. | optional |
| Gekauft bei | aktuelle Seite, editierbar |

**Einkauf registrieren** legt den Einkauf an; das Backend listet daraufhin auf den
Maerkten und meldet die Sendung beim Prep-Center an (`AUTO_LIST_PREP`, Standard an).
Steht der Auto-Flow aus, zieht die Extension `POST /api/purchases/export` nach.
Enter im EK-Feld speichert ebenfalls.

**Preise sind bewusst Anzeige, keine Eingabe:** Das Backend berechnet den Listing-Preis
beim Anlegen aus Aufschlag + tagesaktueller Buy-Box neu (`_process_purchase`). Ein hier
eingetippter Einzelpreis wuerde stillschweigend ueberschrieben. Der Zustand ist immer
`new_new` — das Backend listet fest so.

### Installieren
1. ZIP entpacken (Ordner muss entpackt bleiben)
2. `chrome://extensions` -> **Entwicklermodus** einschalten
3. **Entpackte Erweiterung laden** -> Ordner waehlen
4. Einmal auf https://arbitragex.de einloggen (setzt das SameSite-Cookie)

Download fuer Kunden: **Arbitragex -> Extension** (`/static/arbitragex-extension.zip`).

## Chip: ASIN + EAN auf jeder Amazon-Seite (v1.3.0)

Statt des runden AX-Knopfes liegt jetzt ein **verschiebbarer Chip** auf der Seite:

`[AX] [B07NPQ9NHV] [4059584014954] [⠿]`

* **AX** oeffnet das Panel.
* **ASIN / EAN anklicken kopiert** sofort (kurzes „kopiert ✓" als Rueckmeldung).
* **Am Griff ⠿ ziehen** verschiebt den Chip; die Position wird in
  `chrome.storage.sync` gespeichert und gilt ab dann auf allen Seiten.
* Auf **Uebersichts-/Suchseiten** (mehrere `data-asin`) zeigt er `n ASINs` —
  ein Klick kopiert alle, zeilenweise.

**EAN-Erkennung** portiert aus `~/ean-quick-extension/`: JSON-LD, Microdata/Meta,
Inline-JSON und sichtbare Spec-Tabellen; am Ende bleibt nur, was die
**Mod-10-Pruefziffer** besteht — sonst landen Modell-/Artikelnummern im Feld.
Amazon-Zellen mit mehreren EANs werden zerlegt. Da Amazon Detailtabellen
nachlaedt, wird bis zu 6× im Sekundentakt nachgeschaut, bis eine EAN da ist.

Auf Uebersichtsseiten wird **bewusst keine** einzelne ASIN geraten: nur wenn die
URL eine ASIN enthaelt oder genau ein `data-asin` auf der Seite ist, gilt sie als
eindeutig.

## Quick-Links + EAN aus der SP-API (v1.4.0)

Der Chip hat jetzt **idealo / amazon / google** als Direktsuche. Gesucht wird mit
der **EAN**, wenn vorhanden (treffsicherer als der Titel), sonst mit der ASIN.

**EAN-Quelle in zwei Stufen:** zuerst die Seite (JSON-LD, Meta, Spec-Tabellen),
und wenn die nichts hergibt, die **SP-API** — Amazon zeigt die EAN auf der PDP
haeufig gar nicht an, im Katalog (`getCatalogItem`, `includedData=identifiers`)
steht sie trotzdem. Der Wert kommt aus dem Prefetch, der Chip baut sich neu,
sobald er da ist.

## Panel-Seite + Quelle mit Region (v1.5.0)

* Das Panel faehrt **standardmaessig LINKS** ein — rechts sitzen bei den meisten
  Nutzern SellerAmp/ProfitGo. Mit **⇄** im Panel-Kopf umschaltbar, die Wahl wird
  in `chrome.storage.sync` (`panelSide`) gespeichert.
* Die **Quelle** eines Einkaufs ist jetzt die volle Domain inkl. Region:
  `amazon.de` statt `amazon` — amazon.de und amazon.fr sind verschiedene Quellen.
* VK-Feld formatiert zweistellig (`225,90` statt `225,9`).

