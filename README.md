# Arbitragex — Chrome-Extension

**Neu in 1.8.0** — die Kalkulation sitzt jetzt im **Popup oben rechts** (Klick
aufs Extension-Icon), nicht mehr in einem eingeblendeten Panel auf der
Produktseite. Der bodenhohe Drawer verdeckte die halbe PDP und ging nur ueber
sein eigenes Kreuz wieder zu; das Popup schliesst sich mit einem Klick daneben.
Inhalt und Rechenweg sind unveraendert — Buy-Box-Kacheln, Aufschlag,
Roh-Marge, ein Button.

Auf der Seite bleibt nur der **Chip** (ASIN, EAN, Quick-Links). Sein **AX**-Knopf
oeffnet jetzt dasselbe Popup (`chrome.action.openPopup()`, ab Chrome 127); geht
das nicht, oeffnet er wie auf fremden Seiten arbitragex.de.

Weil das Popup die Seite nicht selbst kennt, fragt es das Content-Script per
`chrome.tabs.sendMessage` (`axx-page`, `axx-analyze`). Das **Vorabladen bleibt
im Content-Script** — es laeuft weiter seit dem Seitenaufruf, deshalb steht das
Popup beim Oeffnen meist sofort. Dafuer braucht das Manifest `activeTab`.

**Neu in 1.6.0** — die EAN wird jetzt auf *allen* Shop-Seiten erkannt, nicht mehr
nur auf Amazon. Auf fremden Seiten zeigt die Extension ausschliesslich den
EAN-Chip mit Kopierknopf und den Quick-Links (idealo/Amazon/Google); die
Kalkulation bleibt Amazon vorbehalten, weil es dort keine ASIN gibt. Findet die
Extension auf einer fremden Seite keine gueltige EAN, erscheint gar nichts —
sie haengt also nicht auf jeder beliebigen Website im Bild.

Auch die ASIN wird auf fremden Seiten erkannt, sofern der Shop auf Amazon
verlinkt (Partnerlinks, "auch erhaeltlich bei"). Verweist eine Seite auf mehrere
verschiedene ASINs, wird bewusst keine ausgewaehlt — das waere geraten.

Auf Amazon aendert sich nichts: Steht die EAN nicht auf der Seite, holt sie das
Backend weiterhin ueber die SP-API aus dem Katalog (`/api/ext/analyze`).

Auf jeder Amazon-Produktseite (DE/FR/IT/ES) liegen im Popup: Buy-Box je EU-Markt,
Vorschlagspreis (+20/30 %), „verkaufe ich das schon?", und die Aktionen
**Listing anlegen** und **An Prep ankündigen**.

Auth: **Login-Session** deiner Arbitragex-Instanz (Cookie). Kein API-Key nötig.

## Installation (unpacked)
1. Chrome → `chrome://extensions`
2. Oben rechts **Entwicklermodus** an.
3. **Entpackte Erweiterung laden** → Ordner `~/arbitragex-extension/` wählen.
4. Einmal auf **https://arbitragex.de** einloggen (im selben Chrome-Profil).
   Wichtig: nach dem Deploy einmal **neu einloggen**, damit das Session-Cookie
   `SameSite=None` gesetzt wird (sonst sendet Chrome es der Extension nicht).
5. Amazon-Produktseite öffnen → **oben rechts aufs Extension-Icon** klicken
   (oder unten rechts auf **AX** im Chip).

## Konfiguration
Die Arbitragex-Adresse ist seit 1.6.4 fest verdrahtet (`https://arbitragex.de`) —
ein Vertipper im frueher aenderbaren Feld legte die Extension still, ohne dass
der Grund erkennbar war. Den Login-Status zeigt das Popup an.

## Aktionen
- **Listing anlegen** → nutzt `/api/listings/create` (Offer auf die ASIN, je Markt).
  Bei fehlender Freischaltung: klarer „Freischaltung nötig"-Hinweis.
- **An Prep ankündigen** → `/api/rebelprep/announce` (PrepBusiness/E-Mail/Mock je Config).

## Dateien
`manifest.json` (MV3) · `background.js` (Service-Worker, Cookie-Fetch) ·
`content.js` (Chip + EAN-Erkennung + Vorabladen) · `chip.css` ·
`popup.html/js/css` (Kalkulation) · `icon128.png`

## Einkauf registrieren (v1.2.0)

Die Produktdaten werden **schon beim Seitenaufruf** geladen (nicht erst beim Klick),
das Popup zeigt alles ohne Ausklappen und hat genau **einen** Button.

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

* **AX** oeffnet das Popup oben rechts (seit 1.8.0; vorher das Panel).
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

* ~~Das Panel faehrt standardmaessig LINKS ein, umschaltbar mit **⇄**.~~
  **Hinfaellig seit 1.8.0** — es gibt kein Panel mehr, und das Popup sitzt
  ohnehin oben rechts am Icon. `panelSide` in `chrome.storage.sync` wird nicht
  mehr gelesen.
* Die **Quelle** eines Einkaufs ist jetzt die volle Domain inkl. Region:
  `amazon.de` statt `amazon` — amazon.de und amazon.fr sind verschiedene Quellen.
* VK-Feld formatiert zweistellig (`225,90` statt `225,9`).

