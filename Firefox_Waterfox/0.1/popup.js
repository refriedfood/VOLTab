const api = (typeof browser !== "undefined") ? browser : chrome;

function getSrcWindowId() {
  try {
    const u = new URL(window.location.href);
    const w = u.searchParams.get("w");
    if (!w) return null;
    const n = Number(w);
    if (!Number.isFinite(n)) return null;
    return n;
  } catch (e) {
    return null;
  }
}


function pSend(msg) {
  return new Promise(resolve => {
    try {
      api.runtime.sendMessage(msg, (res) => {
        const err = api.runtime && api.runtime.lastError ? api.runtime.lastError.message : "";
        if (err) resolve({ ok: false, error: err });
        else resolve(res || { ok: false });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  });
}

function pTabsQuery(q) {
  return new Promise(resolve => {
    try { api.tabs.query(q, t => resolve(t || [])); }
    catch (e) { resolve([]); }
  });
}

function pTabSend(tabId, msg) {
  return new Promise(resolve => {
    try {
      api.tabs.sendMessage(tabId, msg, (res) => {
        const err = api.runtime && api.runtime.lastError ? api.runtime.lastError.message : "";
        if (err) resolve({ ok: false, error: err });
        else resolve(res || { ok: false });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  });
}

function clampPct(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return 100;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

function throttle(fn, delay) {
  let waiting = false;
  let lastArgs = null;

  const tick = () => {
    if (!lastArgs) { waiting = false; return; }
    const args = lastArgs;
    lastArgs = null;
    fn(...args);
    setTimeout(tick, delay);
  };

  return (...args) => {
    if (waiting) { lastArgs = args; return; }
    waiting = true;
    fn(...args);
    setTimeout(tick, delay);
  };
}

function isSoundCloudUrl(url) {
  try {
    const h = new URL(url).hostname;
    return h === "soundcloud.com" || h.endsWith(".soundcloud.com");
  } catch (e) {
    return false;
  }
}

const setVolThrottled = throttle(async (tabId, pct) => {
  await pSend({ type: "TMV_SET_VOLUME", tabId, pct });
}, 35);

const togglePlayThrottled = throttle(async (tabId) => {
  await pSend({ type: "TMV_TOGGLE_PLAY", tabId });
}, 120);

async function render() {
  const list = document.getElementById("list");
  const empty = document.getElementById("empty");
  list.textContent = "";

  const volsRes = await pSend({ type: "TMV_GET_VOLUMES" });
  const volumes = (volsRes && volsRes.ok && volsRes.volumes) ? volsRes.volumes : {};

  const srcWindowId = getSrcWindowId();
  const tabs = await pTabsQuery((typeof srcWindowId === 'number') ? { windowId: srcWindowId } : { currentWindow: true });

  const shown = [];
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    if (!tab || typeof tab.id !== "number") continue;
    if (!tab.url || !tab.url.startsWith("http")) continue;

    if (isSoundCloudUrl(tab.url)) {
      shown.push({ tab, kind: "soundcloud", mediaCount: -1 });
      continue;
    }

    const det = await pSend({ type: "TMV_DETECT_MEDIA", tabId: tab.id });
    const cnt = (det && det.ok) ? Number(det.count) : 0;

    if (Number.isFinite(cnt) && cnt > 0) {
      shown.push({ tab, kind: "html", mediaCount: cnt });
    }
  }

  if (!shown.length) {
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  for (let i = 0; i < shown.length; i++) {
    const { tab, kind, mediaCount } = shown[i];

    const card = document.createElement("div");
    card.className = "card";

    const row1 = document.createElement("div");
    row1.className = "row1";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = tab.title || "(untitled)";

    const badge = document.createElement("div");
    badge.className = "badge";
    badge.textContent = (kind === "soundcloud") ? "SoundCloud" : ("Media: " + mediaCount);

    row1.appendChild(title);
    row1.appendChild(badge);

    const row2 = document.createElement("div");
    row2.className = "row2";

    const wrap = document.createElement("div");
    wrap.className = "rangeWrap";

    const range = document.createElement("input");
    range.className = "range";
    range.type = "range";
    range.min = "0";
    range.max = "100";
    range.step = "1";

    const pbtn = document.createElement("button");
    pbtn.className = "pbtn";
    pbtn.type = "button";
    pbtn.textContent = "⏯";
    pbtn.addEventListener("click", () => togglePlayThrottled(tab.id));

    const value = document.createElement("div");
    value.className = "value";

    const stored = clampPct(volumes[String(tab.id)] ?? 100);
    range.value = String(stored);
    value.textContent = range.value;

    if (kind === "soundcloud") {
      const r = await pTabSend(tab.id, { type: "SC_GET_VOL" });
      if (r && r.ok && typeof r.pct === "number") {
        const pct = clampPct(r.pct);
        range.value = String(pct);
        value.textContent = range.value;
      }
    }

    range.addEventListener("input", () => {
      value.textContent = range.value;
      setVolThrottled(tab.id, clampPct(range.value));
    });

    wrap.appendChild(range);
    wrap.appendChild(pbtn);
    wrap.appendChild(value);

    row2.appendChild(wrap);

    card.appendChild(row1);
    card.appendChild(row2);

    list.appendChild(card);
  }
}

(async () => {
  const nlBtn = document.getElementById("nl");
  const maBtn = document.getElementById("ma");

  const nlRes = await pSend({ type: "TMV_GET_NONLINEAR" });
  let nl = !!(nlRes && nlRes.ok && nlRes.nonLinearVolume);

  const maRes = await pSend({ type: "TMV_GET_MUTE_ALL" });
  let mutedAll = !!(maRes && maRes.ok && maRes.mutedAll);

  const labelNl = () => { nlBtn.textContent = nl ? "Non-linear: On" : "Non-linear: Off"; };
  const labelMa = () => { maBtn.textContent = mutedAll ? "Unmute" : "Mute"; };

  labelNl();
  labelMa();

  nlBtn.addEventListener("click", async () => {
    nl = !nl;
    labelNl();
    await pSend({ type: "TMV_SET_NONLINEAR", nonLinearVolume: nl });
  });

  maBtn.addEventListener("click", async () => {
    mutedAll = !mutedAll;
    labelMa();
    const srcWindowId2 = getSrcWindowId();
    await pSend({ type: "TMV_SET_MUTE_ALL", mutedAll, windowId: (typeof srcWindowId2 === "number" ? srcWindowId2 : undefined) });
  });

  await render();
})();
