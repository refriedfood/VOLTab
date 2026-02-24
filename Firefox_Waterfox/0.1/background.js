const api = (typeof browser !== "undefined") ? browser : chrome;

const sessionArea = (api.storage && api.storage.session) ? api.storage.session : api.storage.local;
const syncArea = api.storage.sync;

function pGet(area, keys) {
  return new Promise(resolve => {
    try {
      const maybe = area.get(keys, r => resolve(r || {}));
      if (maybe && typeof maybe.then === "function") maybe.then(resolve).catch(() => resolve({}));
    } catch (e) { resolve({}); }
  });
}

function pSet(area, obj) {
  return new Promise(resolve => {
    try {
      const maybe = area.set(obj, () => resolve(true));
      if (maybe && typeof maybe.then === "function") maybe.then(() => resolve(true)).catch(() => resolve(false));
    } catch (e) { resolve(false); }
  });
}

function pExecAllFrames(tabId, code) {
  return new Promise(resolve => {
    try {
      api.tabs.executeScript(tabId, { code, allFrames: true }, (res) => {
        const err = api.runtime && api.runtime.lastError ? api.runtime.lastError.message : "";
        resolve({ ok: !err, error: err, res: res || null });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message ? e.message : e), res: null });
    }
  });
}

function pSendToTab(tabId, msg) {
  return new Promise(resolve => {
    try {
      api.tabs.sendMessage(tabId, msg, (res) => {
        const err = api.runtime && api.runtime.lastError ? api.runtime.lastError.message : "";
        resolve({ ok: !err, error: err, res: res || null });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message ? e.message : e), res: null });
    }
  });
}

function pTabsGet(tabId) {
  return new Promise(resolve => {
    try { api.tabs.get(tabId, t => resolve(t || null)); }
    catch (e) { resolve(null); }
  });
}

function pTabsQuery(q) {
  return new Promise(resolve => {
    try { api.tabs.query(q, t => resolve(t || [])); }
    catch (e) { resolve([]); }
  });
}

function clampPct(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return 100;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

async function getNonLinear() {
  const s = await pGet(syncArea, ["nonLinearVolume"]);
  return !!s.nonLinearVolume;
}

function pctTo01(pct, nonLinear) {
  const p = clampPct(pct) / 100;
  return nonLinear ? (p * p) : p;
}

function isSoundCloudUrl(url) {
  try {
    const h = new URL(url).hostname;
    return h === "soundcloud.com" || h.endsWith(".soundcloud.com");
  } catch (e) {
    return false;
  }
}

async function applyHtmlMediaVolume(tabId, pct) {
  const nonLinear = await getNonLinear();
  const v01 = pctTo01(pct, nonLinear);

  const code = `
    (function(){
      try {
        var els = document.querySelectorAll("audio, video");
        for (var i=0; i<els.length; i++) {
          try { els[i].muted = false; els[i].volume = ${v01}; } catch(e) {}
        }
      } catch(e) {}
    })();
  `;
  await pExecAllFrames(tabId, code);
}

async function toggleHtmlMediaPlay(tabId) {
  const code = `
    (function(){
      try {
        var els = document.querySelectorAll("audio, video");
        if (!els || !els.length) return false;
        var el = els[0];
        for (var i=0;i<els.length;i++){
          if (!els[i].paused) { el = els[i]; break; }
        }
        if (el.paused) { var p = el.play(); if (p && p.catch) p.catch(function(){}); }
        else { el.pause(); }
        return true;
      } catch(e) { return false; }
    })();
  `;
  await pExecAllFrames(tabId, code);
}

async function detectHtmlMedia(tabId) {
  const code = `
    (function(){
      try {
        var els = document.querySelectorAll("audio, video");
        return els ? els.length : 0;
      } catch(e) { return 0; }
    })();
  `;
  const r = await pExecAllFrames(tabId, code);
  if (!r.ok || !r.res) return { ok: false, count: 0 };

  let sum = 0;
  try {
    for (let i = 0; i < r.res.length; i++) {
      const v = Number(r.res[i]);
      if (Number.isFinite(v)) sum += v;
    }
  } catch (e) {}

  return { ok: true, count: sum };
}

async function applySoundCloudUiVolume(tabId, pct) {
  await pSendToTab(tabId, { type: "SC_SET_VOL", pct: clampPct(pct) });
}

async function toggleSoundCloudPlay(tabId) {
  await pSendToTab(tabId, { type: "SC_TOGGLE_PLAY" });
}

async function setMuteAllForWindow(mutedAll, windowId) {
  const tabs = await pTabsQuery((typeof windowId === 'number') ? { windowId } : { currentWindow: true });
  const data = await pGet(sessionArea, ["volumes", "muteAllPrev"]);
  const volumes = (data.volumes && typeof data.volumes === "object") ? data.volumes : {};
  const muteAllPrev = (data.muteAllPrev && typeof data.muteAllPrev === "object") ? data.muteAllPrev : {};

  if (mutedAll) {
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      if (!tab || typeof tab.id !== "number") continue;
      if (!tab.url || !tab.url.startsWith("http")) continue;

      const id = String(tab.id);
      if (muteAllPrev[id] === undefined) muteAllPrev[id] = (volumes[id] ?? 100);
      volumes[id] = 0;

      if (isSoundCloudUrl(tab.url)) await applySoundCloudUiVolume(tab.id, 0);
      else await applyHtmlMediaVolume(tab.id, 0);
    }
  } else {
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      if (!tab || typeof tab.id !== "number") continue;
      if (!tab.url || !tab.url.startsWith("http")) continue;

      const id = String(tab.id);
      const restore = muteAllPrev[id];
      if (restore === undefined) continue;

      volumes[id] = restore;
      if (isSoundCloudUrl(tab.url)) await applySoundCloudUiVolume(tab.id, restore);
      else await applyHtmlMediaVolume(tab.id, restore);

      delete muteAllPrev[id];
    }
  }

  await pSet(sessionArea, { volumes, muteAllPrev, mutedAll });
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || !msg.type) return;

    if (msg.type === "TMV_SET_VOLUME") {
      const tabId = Number(msg.tabId);
      const pct = clampPct(msg.pct);

      const data = await pGet(sessionArea, ["volumes"]);
      const volumes = (data.volumes && typeof data.volumes === "object") ? data.volumes : {};
      volumes[String(tabId)] = pct;
      await pSet(sessionArea, { volumes });

      const tab = await pTabsGet(tabId);
      const url = tab && tab.url ? tab.url : "";

      if (isSoundCloudUrl(url)) await applySoundCloudUiVolume(tabId, pct);
      else await applyHtmlMediaVolume(tabId, pct);

      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "TMV_TOGGLE_PLAY") {
      const tabId = Number(msg.tabId);
      const tab = await pTabsGet(tabId);
      const url = tab && tab.url ? tab.url : "";

      if (isSoundCloudUrl(url)) await toggleSoundCloudPlay(tabId);
      else await toggleHtmlMediaPlay(tabId);

      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "TMV_GET_VOLUMES") {
      const data = await pGet(sessionArea, ["volumes"]);
      sendResponse({ ok: true, volumes: data.volumes || {} });
      return;
    }

    if (msg.type === "TMV_SET_NONLINEAR") {
      await pSet(syncArea, { nonLinearVolume: !!msg.nonLinearVolume });
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "TMV_GET_NONLINEAR") {
      const s = await pGet(syncArea, ["nonLinearVolume"]);
      sendResponse({ ok: true, nonLinearVolume: !!s.nonLinearVolume });
      return;
    }

    if (msg.type === "TMV_DETECT_MEDIA") {
      const tabId = Number(msg.tabId);
      const r = await detectHtmlMedia(tabId);
      sendResponse({ ok: r.ok, count: r.count });
      return;
    }

    if (msg.type === "TMV_GET_MUTE_ALL") {
      const s = await pGet(sessionArea, ["mutedAll"]);
      sendResponse({ ok: true, mutedAll: !!s.mutedAll });
      return;
    }

    if (msg.type === "TMV_SET_MUTE_ALL") {
      const mutedAll = !!msg.mutedAll;
      await setMuteAllForWindow(mutedAll, (typeof msg.windowId === 'number' ? msg.windowId : undefined));
      sendResponse({ ok: true });
      return;
    }
  })().catch(() => {
    try { sendResponse({ ok: false }); } catch (e) {}
  });

  return true;
});

api.tabs.onUpdated.addListener(async (tabId) => {
  const data = await pGet(sessionArea, ["volumes"]);
  const volumes = (data.volumes && typeof data.volumes === "object") ? data.volumes : {};
  const pct = volumes[String(tabId)];
  if (pct === undefined) return;

  const tab = await pTabsGet(tabId);
  const url = tab && tab.url ? tab.url : "";

  if (isSoundCloudUrl(url)) await applySoundCloudUiVolume(tabId, pct);
  else await applyHtmlMediaVolume(tabId, pct);
});


// --- Optional page context menu (toggled in Options) ---

const TMV_MENU_ID = "tmv_open_popup";
const TMV_OPT_KEY_PAGE_MENU = "pageMenu";

function tmv_pRemoveMenu() {
  return new Promise(resolve => {
    try {
      if (!api.contextMenus || !api.contextMenus.remove) return resolve(false);
      api.contextMenus.remove(TMV_MENU_ID, () => resolve(true));
    } catch (e) { resolve(false); }
  });
}

function tmv_pCreateMenu() {
  return new Promise(resolve => {
    try {
      if (!api.contextMenus || !api.contextMenus.create) return resolve(false);
      api.contextMenus.create(
        { id: TMV_MENU_ID, title: "Tab Volume", contexts: ["page"] },
        () => resolve(true)
      );
    } catch (e) { resolve(false); }
  });
}

async function tmv_getPageMenuEnabled() {
  const s = await pGet(syncArea, [TMV_OPT_KEY_PAGE_MENU]);
  // Default OFF (must be enabled in options)
  if (s[TMV_OPT_KEY_PAGE_MENU] === undefined) return false;
  return !!s[TMV_OPT_KEY_PAGE_MENU];
}

async function tmv_syncContextMenu() {
  await tmv_pRemoveMenu();
  const enabled = await tmv_getPageMenuEnabled();
  if (enabled) await tmv_pCreateMenu();
}

function tmv_openPopupWindow(srcWindowId) {
  try {
    if (!api.windows || !api.windows.create) return;
    const url0 = api.runtime.getURL("popup.html");
    const url = (typeof srcWindowId === "number") ? (url0 + "?w=" + String(srcWindowId)) : url0;
    api.windows.create({ url, type: "popup", width: 420, height: 680 });
  } catch (e) {}
}

try {
  if (api.contextMenus && api.contextMenus.onClicked) {
    api.contextMenus.onClicked.addListener((info, tab) => {
      if (!info || info.menuItemId !== TMV_MENU_ID) return;
      tmv_openPopupWindow(tab && typeof tab.windowId === "number" ? tab.windowId : undefined);
    });
  }
} catch (e) {}

try {
  if (api.runtime && api.runtime.onInstalled) {
    api.runtime.onInstalled.addListener(() => tmv_syncContextMenu());
  }
} catch (e) {}

try {
  if (api.runtime && api.runtime.onStartup) {
    api.runtime.onStartup.addListener(() => tmv_syncContextMenu());
  }
} catch (e) {}

try {
  if (api.storage && api.storage.onChanged) {
    api.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync") return;
      if (!changes || !changes[TMV_OPT_KEY_PAGE_MENU]) return;
      tmv_syncContextMenu();
    });
  }
} catch (e) {}

// Also run once immediately
tmv_syncContextMenu();
