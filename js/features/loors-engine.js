/* ==========================================
   LOORS ENGINE (video + audio + sonido)
   Cargar ANTES de loors.js. No depende de Supabase ni de otros módulos.

   Red y precarga (igual que antes):
   1) Ventana de videos: solo el Loor activo y sus vecinos tienen el video "conectado" (src).
   2) Precarga escalonada: el siguiente video se prepara cuando el actual ya puede reproducirse.
   3) Red adaptativa (navigator.connection + latencia real de arranque medida).
   4) Un solo IntersectionObserver: reproduce solo el video activo.
   5) Arranque anticipado del primer video (warmFirst / adopt).
   6) HLS listo (nativo en iPhone; hls.js solo si la página lo cargó).

   Audio y sonido (NUEVO, causa raíz del retraso / silencio):
   A) Una sola vía de sonido por Loor:
        - Sin música elegida  -> suena el audio propio del video (un solo elemento, sin desfase posible).
        - Con música elegida  -> el video va mudo y suena UN <audio> global reutilizado.
      Ya no hay un <audio> por tarjeta: Safari de iPhone exige un toque real por CADA elemento de audio,
      por eso los audios creados al deslizar nunca sonaban. El elemento global se desbloquea una vez y se reutiliza.
   B) La música se precarga como Blob en memoria (funciona en iPhone, donde preload="auto" se ignora)
      y el video espera hasta MUSIC_GATE_MS a que la música esté lista: imagen y sonido arrancan juntos.
   C) Sincronización continua: si el video se atasca (waiting/stalled) la música se pausa y vuelve alineada
      en "playing"; al dar la vuelta el loop se reinicia la música; la deriva se corrige cada ~2 s.
   D) Preferencia de sonido por sesión. Si el navegador bloquea el sonido sin toque, el video sigue mudo
      y se pide un toque (needTap); ese toque lo desbloquea. Si la persona eligió silencio, nunca se activa solo.
   E) Diagnóstico de archivos (inspectFile / inspectUrl / diagnose): detecta pista de audio, códecs y
      posición de los metadatos (faststart) leyendo solo cabeceras MP4.
   ========================================== */

window.LoorsEngine = (function () {
  'use strict';

  const TIERS = {
    high: { ahead: 2, behind: 1, next: 'auto',     gate: 3, waitMs: 1500 },
    mid:  { ahead: 1, behind: 1, next: 'auto',     gate: 3, waitMs: 4000 },
    low:  { ahead: 1, behind: 0, next: 'metadata', gate: 4, waitMs: 0 },
    none: { ahead: 0, behind: 0, next: 'none',     gate: 4, waitMs: 0 }
  };
  const RANK = { none: 0, low: 1, mid: 2, high: 3 };
  const POSTER_AHEAD = 4;
  const ACTIVATE_DELAY_MS = 90;
  const WARM_TTL_MS = 20000;
  const HLS_RE = /\.m3u8(\?|#|$)/i;

  const MUSIC_GATE_MS = 450;          // espera máxima de la imagen por la música (si no llega, la música entra alineada después)
  const DRIFT_MAX_S = 0.35;           // desfase tolerado entre música y video
  const MUSIC_BLOB_MAX = 8 * 1024 * 1024;
  const MUSIC_BLOB_KEEP = 5;
  const SOUND_KEY = 'og_loors_sound';
  const SILENT = 'data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';

  let observer = null;
  let observerRoot = null;
  let cards = [];
  let activeCard = null;
  let activateTimer = 0;
  let pendingAhead = null;
  let startAvg = null;
  let hooks = { play: null, pause: null, onActivate: null };
  let seq = 0;                        // token creciente: invalida arranques viejos al deslizar rápido

  const info = new WeakMap();         // tarjeta -> { idx, attached, userPaused, v, t0, measuring, tok }
  const attached = new Set();
  const hlsByVideo = new WeakMap();
  const warmed = new Map();

  /* ---------- Estado de sonido ---------- */
  let soundOn = readPref();           // lo que la persona quiere (por defecto: con sonido)
  let needTap = false;                // el navegador bloqueó el sonido: hace falta un toque real
  let primed = false;                 // el <audio> global ya fue desbloqueado
  let music = null;                   // ÚNICO <audio> de música, reutilizado
  let musicUrl = '';                  // url lógica cargada en `music`
  let musicCard = null;               // tarjeta dueña de la música actual
  const soundListeners = [];
  const blobs = new Map();            // url -> { state: loading|ready|fail, obj, p }

  function readPref() {
    try { return sessionStorage.getItem(SOUND_KEY) !== '0'; } catch (e) { return true; }
  }
  function savePref() {
    try { sessionStorage.setItem(SOUND_KEY, soundOn ? '1' : '0'); } catch (e) {}
  }
  function emitSound() {
    const st = { on: soundOn, needTap: soundOn && needTap };
    soundListeners.forEach(function (fn) { try { fn(st); } catch (e) {} });
  }
  function noop() {}

  /* iPhone (sobre todo con la app instalada en inicio): la sesión de audio por defecto respeta el interruptor
     de silencio y el sonido de los videos no sale. 'playback' lo trata como reproductor de medios (iOS 16.4+). */
  function audioSession(playback) {
    try { if (navigator.audioSession) navigator.audioSession.type = playback ? 'playback' : 'auto'; } catch (e) {}
  }

  function S(card) {
    let s = info.get(card);
    if (!s) {
      s = { idx: -1, attached: false, userPaused: false, v: null, t0: 0, measuring: false, tok: 0 };
      info.set(card, s);
    }
    if (!s.v) {
      s.v = card.querySelector('.loor-video');
      if (s.v) bindVideo(card, s.v);
    }
    return s;
  }

  function musicOf(card) {
    if (!card || !card.dataset || card.dataset.audioFailed) return '';
    return card.dataset.audio || '';
  }

  /* ---------- Red ---------- */
  function conn() {
    return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
  }

  function tierName() {
    let t = 'high';
    const c = conn();
    if (c) {
      const et = c.effectiveType || '';
      if (c.saveData || et === 'slow-2g' || et === '2g') return 'none';
      if (et === '3g') t = 'mid';
      else if (c.downlink && c.downlink < 1.5) t = 'mid';
    }
    if (startAvg != null) {
      const m = startAvg > 3500 ? 'low' : (startAvg > 1800 ? 'mid' : 'high');
      if (RANK[m] < RANK[t]) t = m;
    }
    return t;
  }

  function measureStart(card) {
    const s = S(card);
    s.t0 = performance.now();
    if (s.measuring || !s.v) return;
    s.measuring = true;
    const v = s.v;
    v.addEventListener('playing', function onPlaying() {
      v.removeEventListener('playing', onPlaying);
      s.measuring = false;
      const dt = performance.now() - s.t0;
      if (document.hidden || dt > 15000) return;
      startAvg = startAvg == null ? dt : startAvg * 0.5 + dt * 0.5;
    });
  }

  /* ---------- Música: precarga en memoria + elemento global ---------- */
  function prefetchMusic(url) {
    if (!url || blobs.has(url) || tierName() === 'none' || typeof fetch !== 'function') return;
    const e = { state: 'loading', obj: null, p: null };
    e.p = fetch(url, { mode: 'cors', credentials: 'omit' }).then(function (r) {
      if (!r.ok) throw new Error('http');
      const len = +r.headers.get('content-length') || 0;
      if (len > MUSIC_BLOB_MAX) throw new Error('big');
      return r.blob();
    }).then(function (b) {
      if (b.size > MUSIC_BLOB_MAX) throw new Error('big');
      e.obj = URL.createObjectURL(b);
      e.state = 'ready';
    }).catch(function () { e.state = 'fail'; });
    blobs.set(url, e);
    trimBlobs();
  }

  function trimBlobs() {
    while (blobs.size > MUSIC_BLOB_KEEP) {
      let dropped = false;
      for (const k of blobs.keys()) {
        if (k === musicUrl) continue;           // la que está sonando no se toca
        const e = blobs.get(k);
        if (e.obj) { try { URL.revokeObjectURL(e.obj); } catch (x) {} }
        blobs.delete(k);
        dropped = true;
        break;
      }
      if (!dropped) break;
    }
  }

  function sourceFor(url) {
    const e = blobs.get(url);
    return e && e.state === 'ready' && e.obj ? e.obj : url;
  }

  function getMusic() {
    if (music) return music;
    music = document.createElement('audio');
    music.preload = 'auto';
    music.loop = true;
    music.setAttribute('playsinline', '');
    music.setAttribute('data-og-managed', '1');   // stability.js no lo pausa/reanuda por su cuenta: lo gobierna el motor
    music.style.display = 'none';
    if (document.body) document.body.appendChild(music);
    music.addEventListener('error', function () {
      // La música no cargó: si el video trae sonido propio, se usa ese (nunca se inventa audio)
      const c = musicCard;
      if (!c || !musicUrl) return;
      c.dataset.audioFailed = '1';
      musicUrl = '';
      musicCard = null;
      music.removeAttribute('src');
      if (c === activeCard) playCard(c);
    });
    return music;
  }

  function loadMusic(url) {
    const m = getMusic();
    if (musicUrl !== url) {
      musicUrl = url;
      m.src = sourceFor(url);
      try { m.load(); } catch (e) {}
    }
    m.muted = false;
    return m;
  }

  function stopMusic() {
    if (music) { try { music.pause(); } catch (e) {} }
    musicCard = null;
  }

  function whenReady(m, ms, cb) {
    if (m.readyState >= 3 || ms <= 0) { cb(); return; }
    let done = false;
    const fin = function () {
      if (done) return;
      done = true;
      m.removeEventListener('canplay', fin);
      clearTimeout(t);
      cb();
    };
    const t = setTimeout(fin, ms);
    m.addEventListener('canplay', fin);
  }

  /* Prepara la música del Loor (esperando su Blob si ya viene en camino) y avisa cuando puede sonar */
  function prepareMusic(url, ms, cb) {
    const t0 = performance.now();
    const step = function () {
      const m = loadMusic(url);
      whenReady(m, Math.max(0, ms - (performance.now() - t0)), function () { cb(m); });
    };
    const e = blobs.get(url);
    if (e && e.state === 'loading') {
      let done = false;
      const go = function () { if (done) return; done = true; step(); };
      e.p.then(go);
      setTimeout(go, ms);
    } else {
      step();
    }
  }

  function alignMusic(v, m) {
    const d = m.duration;
    const t = (d && isFinite(d)) ? (v.currentTime % d) : v.currentTime;
    if (Math.abs(m.currentTime - t) > DRIFT_MAX_S) { try { m.currentTime = t; } catch (e) {} }
  }

  function startMusicPlay(m, my) {
    const p = m.play();
    if (p && p.then) {
      p.then(function () {
        if (needTap) { needTap = false; emitSound(); }
      }).catch(function (err) {
        if (err && err.name === 'AbortError') return;
        needTap = true;                // iPhone: hace falta un toque real
        emitSound();
      });
    }
  }

  /* Eventos del video: mantienen la música pegada a la imagen */
  function bindVideo(card, v) {
    if (v._loorBound) return;
    v._loorBound = true;
    let last = 0;
    let lastCheck = 0;
    const mine = function () { return card === activeCard && card === musicCard && music; };
    const hold = function () { if (mine() && !music.paused) { try { music.pause(); } catch (e) {} } };
    v.addEventListener('waiting', hold);
    v.addEventListener('stalled', hold);
    v.addEventListener('playing', function () {
      if (!mine() || !soundOn || v.paused) return;
      alignMusic(v, music);
      if (music.paused) startMusicPlay(music);
    });
    v.addEventListener('timeupdate', function () {
      const t = v.currentTime;
      if (!mine() || music.paused) { last = t; return; }
      if (t + 0.5 < last) {
        try { music.currentTime = 0; } catch (e) {}          // el video dio la vuelta: la música también
      } else if (performance.now() - lastCheck > 2000) {
        lastCheck = performance.now();
        alignMusic(v, music);
      }
      last = t;
    });
  }

  /* ---------- Reproducir / pausar una tarjeta (video + su sonido) ---------- */
  function playMuted(v, ok) {
    v.muted = true;
    const p = v.play();
    if (p && p.then) p.then(ok).catch(noop); else ok();
  }

  function playOwn(card, tok, v, ok) {
    v.muted = !soundOn;
    const p = v.play();
    if (!p || !p.then) { ok(); return; }
    p.then(function () {
      if (S(card).tok !== tok) return;
      ok();
      if (!v.muted && needTap) { needTap = false; emitSound(); }
    }).catch(function (err) {
      if (err && err.name === 'AbortError') return;      // se pausó antes de arrancar (siguió deslizando)
      if (S(card).tok !== tok) return;
      if (!v.muted) {
        // El navegador bloqueó el sonido sin toque: se ve el video mudo y se pide un toque (no se queda mudo para siempre)
        needTap = soundOn;
        emitSound();
        playMuted(v, ok);
      }
    });
  }

  function playCard(card, done) {
    const s = S(card);
    const v = s.v;
    if (!v) return;
    attach(card, 'auto');
    const tok = s.tok = ++seq;
    const ok = function () { if (done) { try { done(); } catch (e) {} } };
    const url = musicOf(card);
    audioSession(soundOn);

    if (!url) {                       // sonido propio del video
      if (musicCard) stopMusic();
      playOwn(card, tok, v, ok);
      return;
    }
    v.muted = true;                   // con música, el audio del video no suena
    if (!soundOn) {
      if (musicCard === card) stopMusic();
      playMuted(v, ok);
      return;
    }
    musicCard = card;
    prepareMusic(url, MUSIC_GATE_MS, function (m) {
      if (s.tok !== tok || activeCard !== card) return;
      alignMusic(v, m);
      startMusicPlay(m, tok);         // música e imagen arrancan en el mismo instante
      const p = v.play();
      if (p && p.then) p.then(ok).catch(noop); else ok();
    });
  }

  function pauseCard(card) {
    const s = S(card);
    s.tok = ++seq;                    // cancela arranques pendientes de esta tarjeta
    if (s.v) { try { s.v.pause(); } catch (e) {} }
    if (musicCard === card && music) { try { music.pause(); } catch (e) {} }
  }

  /* ---------- Control de sonido (se llama desde toques reales) ---------- */
  function primeSilent() {
    if (primed) return;
    if (musicCard) return;            // el <audio> está en uso: el propio play() real lo desbloquea
    const m = getMusic();
    primed = true;
    musicUrl = '';
    m.src = SILENT;
    const p = m.play();
    if (p && p.then) {
      p.then(function () { if (m.src.indexOf('data:') === 0) m.pause(); })
       .catch(function () { primed = false; });
    }
  }

  function applySound() {
    if (!activeCard) return;
    const s = S(activeCard);
    const v = s.v;
    if (!v) return;
    const url = musicOf(activeCard);
    if (!soundOn) {
      v.muted = true;
      if (music) { try { music.pause(); } catch (e) {} }
      needTap = false;
      return;
    }
    if (s.userPaused || v.paused) return;       // sigue en pausa: el sonido se aplica al reanudar
    if (url) {
      v.muted = true;
      const m = loadMusic(url);
      musicCard = activeCard;
      alignMusic(v, m);
      startMusicPlay(m);
    } else {
      v.muted = false;
      needTap = false;
    }
  }

  const sound = {
    isOn: function () { return soundOn; },
    needsTap: function () { return soundOn && needTap; },
    onChange: function (fn) { soundListeners.push(fn); fn({ on: soundOn, needTap: soundOn && needTap }); },
    prime: function () { primeSilent(); },
    /* Activa el sonido bloqueado por el navegador. Solo con un toque real. Respeta el silencio elegido. */
    unlock: function () {
      if (!soundOn) return;
      audioSession(true);
      primeSilent();
      applySound();
      emitSound();
    },
    set: function (on) {
      soundOn = !!on;
      savePref();
      audioSession(soundOn);
      if (soundOn) primeSilent();
      applySound();
      emitSound();
    },
    toggle: function () { sound.set(!soundOn); }
  };

  /* ---------- Conectar / liberar el video de una tarjeta ---------- */
  function setSource(v, url, hasPoster) {
    if (HLS_RE.test(url) && !v.canPlayType('application/vnd.apple.mpegurl') && window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls({ capLevelToPlayerSize: true, maxBufferLength: 12, startLevel: -1 });
      hlsByVideo.set(v, hls);
      hls.loadSource(url);
      hls.attachMedia(v);
      return;
    }
    v.src = (hasPoster || HLS_RE.test(url) || url.indexOf('#') !== -1) ? url : url + '#t=0.001';
  }

  function setPoster(card) {
    const v = S(card).v;
    if (v && v.dataset.poster && !v.getAttribute('poster')) v.setAttribute('poster', v.dataset.poster);
  }

  function attach(card, preload) {
    const s = S(card);
    const v = s.v;
    if (!v) return;
    if (!s.attached) {
      const url = v.dataset.src;
      if (!url) return;
      setSource(v, url, !!v.dataset.poster);
      s.attached = true;
      attached.add(card);
    }
    if (preload && preload !== 'none' && v.preload !== preload) v.preload = preload;
  }

  function detach(card) {
    const s = S(card);
    attached.delete(card);
    if (!s.attached) return;
    s.attached = false;
    const v = s.v;
    if (v) {
      try { v.pause(); } catch (e) {}
      const hls = hlsByVideo.get(v);
      if (hls) { try { hls.destroy(); } catch (e) {} hlsByVideo.delete(v); }
      v.removeAttribute('src');
      v.preload = 'none';
      try { v.load(); } catch (e) {}
      delete v.dataset.retried;
    }
  }

  /* ---------- Ventana de videos conectados alrededor del activo ---------- */
  function cancelAhead() {
    if (pendingAhead) { pendingAhead.cleanup(); pendingAhead = null; }
  }

  function scheduleAhead() {
    cancelAhead();
    if (!activeCard) return;
    const name = tierName();
    const t = TIERS[name];
    if (!t.ahead) return;
    const card = activeCard;
    const s = S(card);
    const v = s.v;
    const a = s.idx;
    if (!v) return;

    const go = function () {
      cancelAhead();
      if (activeCard !== card) return;
      for (let k = 1; k <= t.ahead; k++) {
        const c = cards[a + k];
        if (!c) break;
        attach(c, k === 1 ? t.next : 'metadata');
      }
    };

    if (v.readyState >= t.gate) { go(); return; }
    const evt = t.gate === 4 ? 'canplaythrough' : 'canplay';
    v.addEventListener(evt, go, { once: true });
    const timer = t.waitMs ? setTimeout(go, t.waitMs) : 0;
    pendingAhead = { cleanup: function () { v.removeEventListener(evt, go); if (timer) clearTimeout(timer); } };
  }

  function applyWindow() {
    if (!activeCard) return;
    const a = S(activeCard).idx;
    const name = tierName();
    const t = TIERS[name];
    const lo = a - t.behind;
    const hi = a + t.ahead;
    attached.forEach(function (c) {
      const i = S(c).idx;
      if (i < lo || i > hi) detach(c);
    });
    attach(activeCard, 'auto');
    // La música pesa poco: la de los próximos Loors se baja YA, sin esperar al video activo
    if (name !== 'none') {
      prefetchMusic(musicOf(activeCard));
      const mAhead = Math.max(t.ahead, 1);
      for (let k = 1; k <= mAhead; k++) { if (cards[a + k]) prefetchMusic(musicOf(cards[a + k])); }
    }
    for (let i = Math.max(0, a - 1); i <= Math.min(cards.length - 1, a + POSTER_AHEAD); i++) setPoster(cards[i]);
    scheduleAhead();
  }

  /* ---------- Activar / silenciar ---------- */
  function quiet(card) {
    const s = S(card);
    if (hooks.pause) hooks.pause(card);
    if (s.v && s.attached && s.v.readyState >= 1 && s.v.currentTime > 0.3) { try { s.v.currentTime = 0; } catch (e) {} }
    s.userPaused = false;
  }

  function pauseOthers(card) {
    attached.forEach(function (c) {
      if (c === card) return;
      const v = S(c).v;
      if (v && !v.paused && hooks.pause) hooks.pause(c);   // nunca suenan dos Loors a la vez
    });
  }

  function activate(card) {
    if (card === activeCard) return;
    clearTimeout(activateTimer);
    cancelAhead();
    if (activeCard) quiet(activeCard);
    activeCard = card;
    S(card).userPaused = false;

    const start = function () {
      if (activeCard !== card) return;
      attach(card, 'auto');
      measureStart(card);
      pauseOthers(card);
      if (hooks.play) hooks.play(card);
      applyWindow();
      if (hooks.onActivate) hooks.onActivate(card);
    };
    if (S(card).attached) start();
    else activateTimer = setTimeout(start, ACTIVATE_DELAY_MS);
  }

  function leave(card) {
    if (card === activeCard) {
      clearTimeout(activateTimer);
      cancelAhead();
      quiet(card);
      activeCard = null;
    } else if (S(card).attached && hooks.pause) {
      hooks.pause(card);
    }
  }

  function onIntersect(entries) {
    let best = null;
    entries.forEach(function (e) {
      if (!e.isIntersecting) leave(e.target);
      else if (!best || e.intersectionRatio > best.intersectionRatio) best = e;
    });
    if (best) activate(best.target);
  }

  /* ---------- API pública ---------- */
  function configure(h) { hooks = Object.assign(hooks, h || {}); }

  function register(newCards, root) {
    if (!root || !('IntersectionObserver' in window)) return;
    if (!observer || observerRoot !== root) {
      if (observer) observer.disconnect();
      observer = new IntersectionObserver(onIntersect, { root: root, threshold: 0.75 });
      observerRoot = root;
    }
    newCards.forEach(function (c) {
      const s = S(c);
      s.idx = cards.length;
      cards.push(c);
      if (s.idx <= POSTER_AHEAD) setPoster(c);
      observer.observe(c);
    });
    if (activeCard) applyWindow();
  }

  function ensureSource(card) { attach(card, 'auto'); }
  function setManualPause(card, paused) { S(card).userPaused = !!paused; }

  function resumeActive() {
    if (!activeCard) return;
    const section = document.getElementById('loors-section');
    if (!section || !section.classList.contains('active')) return;
    const s = S(activeCard);
    if (s.userPaused || !s.v || !s.v.paused) return;
    attach(activeCard, 'auto');
    if (hooks.play) hooks.play(activeCard);
  }

  function suspend() {
    clearTimeout(activateTimer);
    cancelAhead();
    const keep = activeCard;
    if (activeCard) { quiet(activeCard); activeCard = null; }
    stopMusic();
    audioSession(false);              // se cerró Loors: no se retiene el audio del teléfono
    attached.forEach(function (c) { if (c !== keep) detach(c); });
  }

  function reset() {
    clearTimeout(activateTimer);
    cancelAhead();
    if (observer) { observer.disconnect(); observer = null; observerRoot = null; }
    Array.from(attached).forEach(detach);
    cards = [];
    activeCard = null;
    stopMusic();
    dropWarm();
  }

  /* ---------- Arranque anticipado del primer video ---------- */
  function dropWarm() {
    warmed.forEach(function (w) {
      clearTimeout(w.timer);
      try { w.v.pause(); } catch (e) {}
      w.v.removeAttribute('src');
      try { w.v.load(); } catch (e) {}
    });
    warmed.clear();
  }

  function warmFirst(loor) {
    dropWarm();
    if (!loor || !loor.video_url || tierName() === 'none') return;
    const v = document.createElement('video');
    v.className = 'loor-video';
    v.setAttribute('playsinline', '');
    v.playsInline = true;
    v.loop = true;
    v.preload = 'auto';
    if (loor.audio_url) { v.defaultMuted = true; v.muted = true; prefetchMusic(loor.audio_url); }
    v.dataset.src = loor.video_url;
    if (loor.thumbnail_url) { v.dataset.poster = loor.thumbnail_url; v.setAttribute('poster', loor.thumbnail_url); }
    setSource(v, loor.video_url, !!loor.thumbnail_url);
    const id = String(loor.id);
    warmed.set(id, { v: v, timer: setTimeout(function () {
      const w = warmed.get(id);
      if (!w) return;
      w.v.removeAttribute('src');
      try { w.v.load(); } catch (e) {}
      warmed.delete(id);
    }, WARM_TTL_MS) });
  }

  function adopt(card, loorId) {
    const w = warmed.get(String(loorId));
    const old = card.querySelector('.loor-video');
    if (!w || !old) return false;
    clearTimeout(w.timer);
    warmed.delete(String(loorId));
    w.v.dataset.src = old.dataset.src || w.v.dataset.src;
    if (old.dataset.poster) w.v.dataset.poster = old.dataset.poster;
    old.replaceWith(w.v);
    const s = S(card);
    s.v = w.v;
    bindVideo(card, w.v);
    s.attached = true;
    attached.add(card);
    return true;
  }

  /* ==========================================
     DIAGNÓSTICO DE ARCHIVOS MP4 / MOV (solo lee cabeceras)
     ========================================== */
  function fourcc(dv, o) {
    return String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  }

  function eachBox(dv, start, end, cb) {
    let o = start;
    while (o + 8 <= end) {
      let size = dv.getUint32(o);
      const type = fourcc(dv, o + 4);
      let hdr = 8;
      if (size === 1) { size = dv.getUint32(o + 8) * 4294967296 + dv.getUint32(o + 12); hdr = 16; }
      else if (size === 0) size = end - o;
      if (size < hdr || o + size > end) break;
      cb(type, o + hdr, o + size);
      o += size;
    }
  }

  function parseMoov(dv, res) {
    eachBox(dv, 0, dv.byteLength, function (t, s, e) {
      if (t !== 'trak') return;
      const tr = { type: '', codec: '' };
      eachBox(dv, s, e, function (t2, s2, e2) {
        if (t2 !== 'mdia') return;
        eachBox(dv, s2, e2, function (t3, s3, e3) {
          if (t3 === 'hdlr') tr.type = fourcc(dv, s3 + 8);
          if (t3 === 'minf') eachBox(dv, s3, e3, function (t4, s4, e4) {
            if (t4 === 'stbl') eachBox(dv, s4, e4, function (t5, s5) { if (t5 === 'stsd') tr.codec = fourcc(dv, s5 + 12); });
          });
        });
      });
      res.tracks.push(tr);
    });
  }

  async function scanMp4(src) {
    const res = { container: 'mp4', brand: '', order: [], tracks: [], moovFirst: null };
    const head = new DataView(await src.read(0, 16));
    if (head.byteLength < 12) { res.container = 'desconocido'; return res; }
    if (head.getUint32(0) === 0x1A45DFA3) { res.container = 'webm'; return res; }
    let off = 0;
    for (let guard = 0; guard < 40 && off < src.size; guard++) {
      const b = guard === 0 ? head : new DataView(await src.read(off, 16));
      if (b.byteLength < 8) break;
      let size = b.getUint32(0);
      const type = fourcc(b, 4);
      let hdr = 8;
      if (size === 1 && b.byteLength >= 16) { size = b.getUint32(8) * 4294967296 + b.getUint32(12); hdr = 16; }
      else if (size === 0) size = src.size - off;
      res.order.push(type);
      if (type === 'ftyp') res.brand = fourcc(b, 8);
      if (type === 'moov' && size - hdr > 0 && size < 16 * 1024 * 1024) {
        parseMoov(new DataView(await src.read(off + hdr, size - hdr)), res);
      }
      if (size < 8) break;
      off += size;
    }
    const im = res.order.indexOf('moov');
    const id = res.order.indexOf('mdat');
    res.moovFirst = im !== -1 && (id === -1 || im < id);
    return res;
  }

  function verdict(res) {
    const warnings = [];
    const notes = [];
    const vid = res.tracks.filter(function (t) { return t.type === 'vide'; })[0];
    const aud = res.tracks.filter(function (t) { return t.type === 'soun'; })[0];
    if (res.container === 'webm') warnings.push('El video está en WebM: algunos iPhone no lo reproducen bien.');
    if (res.container === 'mp4') {
      if (res.moovFirst === false) warnings.push('Los metadatos están al final del archivo (sin faststart): tarda más en arrancar.');
      if (vid && /^(hvc1|hev1|dvh1|dvhe)$/.test(vid.codec)) warnings.push('Usa HEVC (H.265): muchos Android no lo reproducen.');
      else if (vid && vid.codec && vid.codec !== 'avc1') warnings.push('Códec de video ' + vid.codec + ': lo ideal es H.264 (avc1).');
      if (!aud) notes.push('El video no tiene pista de audio.');
      else if (aud.codec && aud.codec !== 'mp4a') warnings.push('Audio ' + aud.codec + ': lo ideal es AAC (mp4a).');
      if (res.brand === 'qt  ') notes.push('Contenedor QuickTime (.mov).');
    }
    return { warnings: warnings, notes: notes };
  }

  function fileSource(file) {
    return {
      size: file.size,
      read: function (start, len) { return file.slice(start, start + len).arrayBuffer(); }
    };
  }

  function remoteSource(url) {
    const meta = { total: 0, status: 0, contentType: '', acceptRanges: '' };
    return {
      meta: meta,
      get size() { return meta.total || Infinity; },
      read: async function (start, len) {
        const r = await fetch(url, { headers: { Range: 'bytes=' + start + '-' + (start + len - 1) } });
        meta.status = r.status;
        meta.contentType = r.headers.get('content-type') || meta.contentType;
        meta.acceptRanges = r.headers.get('accept-ranges') || meta.acceptRanges;
        if (r.status !== 206) {
          try { if (r.body) r.body.cancel(); } catch (e) {}
          throw new Error('El servidor no devolvió 206 (HTTP Range): ' + r.status);
        }
        const mm = (r.headers.get('content-range') || '').match(/\/(\d+)$/);
        if (mm) meta.total = +mm[1];
        return r.arrayBuffer();
      }
    };
  }

  async function inspectFile(file) {
    const res = await scanMp4(fileSource(file));
    const v = verdict(res);
    return Object.assign({ name: file.name, type: file.type, size: file.size }, res, v);
  }

  async function inspectUrl(url) {
    const src = remoteSource(url);
    let res;
    try { res = await scanMp4(src); } catch (e) { res = { error: String(e && e.message || e), tracks: [], order: [] }; }
    const v = verdict(res);
    return Object.assign({ url: url, http: src.meta }, res, v);
  }

  function diagnose() {
    const c = activeCard;
    if (!c) return Promise.resolve(null);
    const v = S(c).v;
    const out = {
      card: c.dataset.loorId,
      hasMusic: !!musicOf(c),
      sound: { on: soundOn, needTap: needTap, primed: primed },
      video: v ? {
        readyState: v.readyState, networkState: v.networkState, paused: v.paused, muted: v.muted,
        volume: v.volume, currentTime: v.currentTime, duration: v.duration,
        audioTracks: v.audioTracks ? v.audioTracks.length : undefined,
        mozHasAudio: v.mozHasAudio,
        webkitAudioDecodedByteCount: v.webkitAudioDecodedByteCount,
        errorCode: v.error ? v.error.code : null
      } : null,
      music: music ? {
        src: musicUrl, readyState: music.readyState, paused: music.paused, muted: music.muted,
        currentTime: music.currentTime, duration: music.duration
      } : null
    };
    const url = v && v.dataset.src;
    if (!url) return Promise.resolve(out);
    return inspectUrl(url).then(function (r) { out.file = r; return out; });
  }

  function stats() {
    let playing = 0;
    cards.forEach(function (c) { const v = S(c).v; if (v && !v.paused && !v.ended) playing++; });
    return {
      tier: tierName(), startAvgMs: startAvg == null ? null : Math.round(startAvg),
      cards: cards.length, attached: attached.size, playing: playing,
      activeIndex: activeCard ? S(activeCard).idx : -1,
      sound: soundOn, needTap: needTap, musicPlaying: !!(music && !music.paused)
    };
  }

  /* ---------- Eventos globales (se registran una sola vez) ---------- */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (activeCard && hooks.pause) hooks.pause(activeCard);   // sin marcar pausa manual
    } else {
      resumeActive();
    }
  });
  window.addEventListener('pageshow', resumeActive);
  window.addEventListener('pagehide', function () { if (activeCard && hooks.pause) hooks.pause(activeCard); });
  const c0 = conn();
  if (c0 && c0.addEventListener) c0.addEventListener('change', function () { applyWindow(); });

  return {
    configure: configure, register: register, reset: reset, suspend: suspend,
    ensureSource: ensureSource, setManualPause: setManualPause, resumeActive: resumeActive,
    warmFirst: warmFirst, adopt: adopt, stats: stats,
    playCard: playCard, pauseCard: pauseCard, sound: sound,
    inspectFile: inspectFile, inspectUrl: inspectUrl, diagnose: diagnose
  };
})();
