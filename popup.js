const DEFAULT_BASE = "https://arbitrage.anwaltx.de";

function api(path) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ path, method: "GET" }, (r) => resolve(r || { ok: false, status: 0 }));
  });
}

async function refresh() {
  const { baseUrl } = await chrome.storage.sync.get("baseUrl");
  document.getElementById("baseUrl").value = baseUrl || DEFAULT_BASE;
  const st = document.getElementById("status"), hint = document.getElementById("hint");
  const me = await api("/api/ext/me");
  if (me.ok && me.data && me.data.email) {
    st.textContent = "✓ Eingeloggt: " + me.data.email;
    st.className = "st ok";
    hint.innerHTML = me.data.connected
      ? "Amazon-Konto verbunden. Öffne eine Amazon-Produktseite und klick das AX-Icon."
      : '<span class="bad">Kein Amazon-Konto verbunden.</span> In Arbitragex → Einstellungen verbinden.';
  } else {
    st.textContent = "✗ Nicht eingeloggt";
    st.className = "st bad";
    hint.innerHTML = '<a href="' + (baseUrl || DEFAULT_BASE) + '/login" target="_blank">Bei Arbitragex anmelden</a>, dann hier erneut öffnen.';
  }
}

document.getElementById("save").addEventListener("click", async () => {
  const v = document.getElementById("baseUrl").value.trim().replace(/\/+$/, "");
  await chrome.storage.sync.set({ baseUrl: v || DEFAULT_BASE });
  refresh();
});

refresh();
