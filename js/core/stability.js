/* ==========================================================================
   STABILITY.JS - ÖG
   Capa NUEVA y aditiva (no reemplaza código existente). Se carga justo antes
   de app.js, cuando todas las funciones de features/ ya existen.

   Qué hace:
   1. Atrapa errores globales para que un fallo no deje la app congelada.
   2. Quita la pantalla de carga si algo tarda demasiado (watchdog).
   3. Evita que se apilen recargas simultáneas (actividad, historias, chats).
   4. Imágenes: carga diferida + decodificación asíncrona + aparición suave.
   5. Pausa videos/audio al salir de la app y los reanuda al volver.
   6. Detecta teléfonos de pocos recursos y activa el modo liviano.
   7. Avisa cuando se pierde / vuelve la conexión.
   8. Animación al cambiar de pestaña desde la barra inferior.
   ========================================================================== */
(function () {
  'use strict';
  var root = document.documentElement;

  /* ---------- 1. Errores globales: se registran, la app sigue viva ---------- */
  var lastErrAt = 0;
  function logOnce(label, err) {
    var now = Date.now();
    if (now - lastErrAt < 1500) return;
    lastErrAt = now;
    try { console.error('[ÖG] ' + label + ':', err); } catch (e) {}
  }
  window.addEventListener('error', function (ev) { logOnce('Error', ev && (ev.error || ev.message)); });
  window.addEventListener('unhandledrejection', function (ev) { logOnce('Promesa rechazada', ev && ev.reason); });

  /* ---------- 2. Watchdog de la pantalla de carga ---------- */
  setTimeout(function () {
    var splash = document.getElementById('appSplashScreen');
    if (!splash) return;
    if (typeof hideSplashScreen === 'function') hideSplashScreen();
    else splash.remove();
    // Si ni siquiera hay sesión cargada, deja ver el acceso para no quedar en blanco
    try {
      if (typeof currentUser !== 'undefined' && !currentUser && typeof showAuthOverlay === 'function') showAuthOverlay();
    } catch (e) {}
  }, 10000);

  /* ---------- 3. Evitar recargas apiladas ----------
     Si una carga ya está en curso, las llamadas nuevas se unen en UNA sola
     repetición al terminar (así siempre queda el dato más reciente). */
  function coalesce(name) {
    var orig = window[name];
    if (typeof orig !== 'function' || orig.__ogCoalesced) return;
    var running = null, again = false, lastCtx = null, lastArgs = null;
    function run(ctx, args) {
      running = Promise.resolve()
        .then(function () { return orig.apply(ctx, args); })
        .catch(function (err) { logOnce(name, err); })
        .then(function () {
          running = null;
          if (again) { again = false; run(lastCtx, lastArgs); }
        });
      return running;
    }
    var wrapped = function () {
      if (running) { again = true; lastCtx = this; lastArgs = arguments; return running; }
      return run(this, arguments);
    };
    wrapped.__ogCoalesced = true;
    window[name] = wrapped;
  }
  ['loadActivity', 'loadStoriesData', 'loadConversations'].forEach(coalesce);

  /* ---------- 4. Imágenes ---------- */
  var EAGER_ZONES = '#storyViewer, #highlightViewer, #cameraModal, .chat-lightbox, #appSplashScreen, #authWelcomeOverlay';
  function tuneImg(img) {
    if (!img || img.__ogTuned) return;
    img.__ogTuned = true;
    if (!img.hasAttribute('decoding')) img.decoding = 'async';
    var eager = false;
    try { eager = !!img.closest(EAGER_ZONES); } catch (e) {}
    if (!eager && !img.hasAttribute('loading')) img.loading = 'lazy';
    if (eager || img.complete) return;
    // Aparición suave (solo si todavía no cargó)
    img.classList.add('og-img-fade');
    var done = function () { img.classList.add('og-img-loaded'); };
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
  }
  function scanNode(n) {
    if (n.nodeType !== 1) return;
    if (n.tagName === 'IMG') tuneImg(n);
    else if (n.querySelectorAll) {
      var imgs = n.querySelectorAll('img');
      for (var i = 0; i < imgs.length; i++) tuneImg(imgs[i]);
    }
  }
  function startImageObserver() {
    if (!('MutationObserver' in window) || !document.body) return;
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) scanNode(added[j]);
      }
    }).observe(document.body, { childList: true, subtree: true });
    scanNode(document.body);
  }
  if (document.body) startImageObserver();
  else document.addEventListener('DOMContentLoaded', startImageObserver);

  /* ---------- 5. Segundo plano: pausar y reanudar medios ---------- */
  var resumeList = [];
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      root.classList.add('og-hidden');
      resumeList = [];
      document.querySelectorAll('video, audio').forEach(function (m) {
        // Las llamadas usan audio/video en vivo: no se tocan
        if (m.srcObject) return;
        // Los medios de Loors (videos y el <audio> de música) los pausa/reanuda el motor de Loors, sincronizados
        if (m.hasAttribute('data-og-managed') || (m.closest && m.closest('#loors-section'))) return;
        if (!m.paused) { resumeList.push(m); try { m.pause(); } catch (e) {} }
      });
    } else {
      root.classList.remove('og-hidden');
      resumeList.forEach(function (m) {
        if (m.isConnected) { var p = m.play(); if (p && p.catch) p.catch(function () {}); }
      });
      resumeList = [];
    }
  });

  /* ---------- 6. Modo liviano para teléfonos modestos ---------- */
  try {
    var mem = navigator.deviceMemory || 8;
    var cores = navigator.hardwareConcurrency || 8;
    var conn = navigator.connection || {};
    if (mem <= 3 || cores <= 4 || conn.saveData) root.classList.add('og-lite');
  } catch (e) {}

  /* ---------- 7. Aviso de conexión ---------- */
  var toastTimer = null;
  function toast(msg, cls, ms) {
    var el = document.getElementById('ogToast');
    if (el) el.remove();
    el = document.createElement('div');
    el.id = 'ogToast';
    el.className = cls || '';
    el.textContent = msg;
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.remove(); }, ms || 2600);
  }
  window.addEventListener('offline', function () { toast('Sin conexión', 'warn', 4000); });
  window.addEventListener('online', function () { toast('Conexión restablecida', 'ok', 2200); });

  /* ---------- 8. Animación al cambiar de pestaña ---------- */
  var origShowTab = window.showTab;
  if (typeof origShowTab === 'function') {
    window.showTab = function (id) {
      var result = origShowTab.apply(this, arguments);
      try {
        // En los gestos swipe ya hay animación propia (isSwipeLocked = true)
        if (typeof isSwipeLocked !== 'undefined' && isSwipeLocked) return result;
        var el = document.getElementById(id);
        if (el) {
          el.classList.remove('og-tab-enter');
          void el.offsetWidth;
          el.classList.add('og-tab-enter');
          setTimeout(function () { el.classList.remove('og-tab-enter'); }, 300);
        }
      } catch (e) {}
      return result;
    };
  }
})();
