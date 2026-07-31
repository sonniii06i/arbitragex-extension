// Die Arbitragex-Adresse ist fest verdrahtet. Sie war frueher im Popup
// aenderbar — das war eine Fussangel: ein Vertipper legte die Extension still,
// ohne dass der Grund erkennbar war.
const BASE = "https://arbitragex.de";

function api(path) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ path, method: "GET" }, (r) => resolve(r || { ok: false, status: 0 }));
  });
}

async function refresh() {
  const st = document.getElementById("status"), hint = document.getElementById("hint");
  const me = await api("/api/ext/me");
  if (me.ok && me.data && me.data.email) {
    st.textContent = "✓ Eingeloggt: " + me.data.email;
    st.className = "st ok";
    hint.innerHTML = me.data.connected
      ? "Amazon-Konto verbunden. Öffne eine Produktseite und klick das AX-Icon."
      : '<span class="bad">Kein Amazon-Konto verbunden.</span> In Arbitragex → Einstellungen verbinden.';
  } else {
    st.textContent = "✗ Nicht eingeloggt";
    st.className = "st bad";
    hint.innerHTML = '<a href="' + BASE + '/login" target="_blank">Bei Arbitragex anmelden</a>, dann hier erneut öffnen.';
  }
}

refresh();
