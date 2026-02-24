const api = (typeof browser !== "undefined") ? browser : chrome;

function clampPct(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return 100;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

function qs(sel, root) {
  try { return (root || document).querySelector(sel); } catch (e) { return null; }
}

function clickFirst(selectors) {
  for (let i = 0; i < selectors.length; i++) {
    const el = qs(selectors[i]);
    if (!el) continue;
    try { el.click(); return true; } catch (e) {}
  }
  return false;
}

function injectPageHook() {
  if (window.__TMV_SC_HOOKED__) return;
  window.__TMV_SC_HOOKED__ = true;

  const code = `
  (function(){
    if (window.__TMV_SC_PAGE_HOOKED__) return;
    window.__TMV_SC_PAGE_HOOKED__ = true;

    var state = {
      lastSet: null,
      gains: [],
      mediaEls: [],
      enforceTimer: null
    };

    function markGain(g){
      if (!g || g.__tmv_marked) return;
      g.__tmv_marked = true;
      state.gains.push(g);
      if (state.lastSet !== null) {
        try { g.gain.cancelScheduledValues(0); } catch(e) {}
        try { g.gain.value = state.lastSet; } catch(e) {}
      }
    }

    function markMedia(el){
      if (!el || el.__tmv_marked_media) return;
      el.__tmv_marked_media = true;
      state.mediaEls.push(el);
      try { el.muted = false; el.volume = 1; } catch(e) {}

      try {
        el.addEventListener("volumechange", function(){
          if (state.lastSet !== null) {
            try { el.muted = false; el.volume = 1; } catch(e) {}
          }
        }, true);
      } catch(e) {}
    }

    function setOneGain(g, v){
      try {
        if (!g || !g.gain) return false;
        try { g.gain.cancelScheduledValues(0); } catch(e) {}
        try { g.gain.setValueAtTime(v, (g.context && g.context.currentTime) ? g.context.currentTime : 0); } catch(e) {}
        try { g.gain.value = v; } catch(e) {}
        return true;
      } catch(e) { return false; }
    }

    function setAllGains(v){
      var okAny = false;
      for (var i=0; i<state.gains.length; i++){
        if (setOneGain(state.gains[i], v)) okAny = true;
      }
      return okAny;
    }

    function forceMediaMax(){
      for (var i=0; i<state.mediaEls.length; i++){
        try { state.mediaEls[i].muted = false; state.mediaEls[i].volume = 1; } catch(e) {}
      }
    }

    function enforceLoop(){
      if (state.lastSet === null) return;
      forceMediaMax();
      setAllGains(state.lastSet);
    }

    function startEnforce(){
      if (state.enforceTimer) return;
      state.enforceTimer = setInterval(enforceLoop, 600);
    }

    function stopEnforce(){
      if (!state.enforceTimer) return;
      clearInterval(state.enforceTimer);
      state.enforceTimer = null;
    }

    function setMasterGain(v){
      state.lastSet = v;
      setAllGains(v);
      forceMediaMax();
      startEnforce();
      return true;
    }

    function patchCtx(Ctx){
      if (!Ctx || !Ctx.prototype) return;

      var origCreateGain = Ctx.prototype.createGain;
      if (origCreateGain && !origCreateGain.__tmv_patched) {
        Ctx.prototype.createGain = function(){
          var g = origCreateGain.apply(this, arguments);
          markGain(g);
          return g;
        };
        Ctx.prototype.createGain.__tmv_patched = true;
      }

      var origCreateMedia = Ctx.prototype.createMediaElementSource;
      if (origCreateMedia && !origCreateMedia.__tmv_patched) {
        Ctx.prototype.createMediaElementSource = function(mediaElement){
          try { markMedia(mediaElement); } catch(e) {}
          var node = origCreateMedia.apply(this, arguments);
          return node;
        };
        Ctx.prototype.createMediaElementSource.__tmv_patched = true;
      }
    }

    var origConnect = AudioNode.prototype.connect;
    if (origConnect && !origConnect.__tmv_patched) {
      AudioNode.prototype.connect = function(){
        try {
          if (this && this.constructor && this.constructor.name === "GainNode") markGain(this);
        } catch(e) {}
        return origConnect.apply(this, arguments);
      };
      AudioNode.prototype.connect.__tmv_patched = true;
    }

    function scanMediaTags(){
      try {
        var els = document.querySelectorAll("audio, video");
        for (var i=0; i<els.length; i++) markMedia(els[i]);
      } catch(e) {}
    }
    try { scanMediaTags(); } catch(e) {}
    setInterval(scanMediaTags, 2000);

    try { patchCtx(window.AudioContext); } catch(e) {}
    try { patchCtx(window.webkitAudioContext); } catch(e) {}

    window.addEventListener("message", function(ev){
      var d = ev && ev.data;
      if (!d || d.source !== "TMV_SC_CS") return;

      if (d.type === "SET_GAIN") {
        var v = Number(d.v);
        if (!isFinite(v)) v = 1;
        if (v < 0) v = 0;
        if (v > 1) v = 1;
        setMasterGain(v);
      }

      if (d.type === "SCAN_MEDIA") {
        scanMediaTags();
      }

      if (d.type === "STOP_ENFORCE") {
        stopEnforce();
      }
    }, false);
  })();
  `;

  const s = document.createElement("script");
  s.textContent = code;
  (document.documentElement || document.head || document.body).appendChild(s);
  s.remove();
}

injectPageHook();

function postToPage(obj) {
  try { window.postMessage(obj, "*"); } catch (e) {}
}

function getSlider() {
  return qs(".playControls__volume .volume__sliderWrapper[role='slider'][aria-label='Volume']")
    || qs(".volume__sliderWrapper[role='slider'][aria-label='Volume']")
    || null;
}

function setVisual(slider, v01) {
  if (!slider) return;
  try { slider.setAttribute("aria-valuenow", String(v01)); } catch (e) {}
  try {
    const vol = slider.closest(".volume");
    if (vol) vol.setAttribute("data-level", String(Math.round(v01 * 10)));
  } catch (e) {}
}

function togglePlayPause() {
  return clickFirst([
    ".playControls__play",
    ".playControls__play button",
    ".playControls__playControl",
    ".playControls__playControl button",
    ".playControls__elements .playControls__play",
    ".playControls__elements .playControls__play button"
  ]);
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "SC_SET_VOL") {
    const pct = clampPct(msg.pct);
    const v01 = pct / 100;

    const slider = getSlider();
    if (slider) setVisual(slider, v01);

    postToPage({ source: "TMV_SC_CS", type: "SCAN_MEDIA" });
    postToPage({ source: "TMV_SC_CS", type: "SET_GAIN", v: v01 });

    try { sendResponse({ ok: true }); } catch (e) {}
    return;
  }

  if (msg.type === "SC_TOGGLE_PLAY") {
    const ok = togglePlayPause();
    try { sendResponse({ ok }); } catch (e) {}
    return;
  }

  if (msg.type === "SC_GET_VOL") {
    const slider = getSlider();
    if (slider) {
      const now = Number(slider.getAttribute("aria-valuenow"));
      if (Number.isFinite(now)) {
        try { sendResponse({ ok: true, pct: Math.round(now * 100) }); } catch (e) {}
        return;
      }
    }
    try { sendResponse({ ok: false }); } catch (e) {}
    return;
  }
});
