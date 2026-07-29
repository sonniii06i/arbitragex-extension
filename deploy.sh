#!/bin/sh
# ArbitrageX-Extension auf 1.6.4 aktualisieren + Diagnose fuer SSH-Zugang
D=~/a1-arbitrage1/static
cd "$D" || { echo "FEHLER: $D nicht gefunden"; exit 1; }

echo "=== 1. Alte Version sichern ==="
cp arbitragex-extension.zip arbitragex-extension.zip.alt 2>/dev/null && echo "gesichert als arbitragex-extension.zip.alt"

echo "=== 2. Neue Version laden ==="
curl -sL https://github.com/sonniii06i/arbitragex-extension/releases/download/v1.6.4/arbitragex-extension.zip -o arbitragex-extension.zip
ls -la arbitragex-extension.zip | awk '{print "  Groesse:", $5, "Bytes  (Soll: 456556)"}'

echo "=== 3. Versionsnummer im Frontend ==="
grep -rln "1\.5\.0" ~/a1-arbitrage1 --include=*.html --include=*.py --include=*.js 2>/dev/null | head

echo "=== 4. Warum ist SSH von aussen zu? ==="
command -v ufw >/dev/null && ufw status | head -3
nft list ruleset 2>/dev/null | grep -iE "dport 22|drop|reject|policy" | head -5
iptables -S 2>/dev/null | grep -iE " 22 | -j DROP| -j REJECT|policy" | head -5
echo "=== FERTIG ==="
