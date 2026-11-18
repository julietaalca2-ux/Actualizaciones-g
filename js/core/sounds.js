/* ÖG — Sonidos de la app (sintetizados con Web Audio: no hace falta ningún archivo de audio)
   Depende de: state.js (currentUser) — solo para leer la preferencia del usuario
   Expone: ogPlaySound(nombre)  ·  nombres: 'send' | 'receive' | 'notif' | 'publish' | 'pop' */

const ogSound = (() => {
  const VOLUME = 0.9;
  const MIN_GAP_MS = 120;   // evita que el mismo sonido se solape si llegan varios eventos juntos
  let ctx = null;
  let master = null;
  let listening = false;
  const lastPlayed = {};

  function enabled() {
    try {
      const raw = localStorage.getItem('og_user_settings_' + (currentUser?.id || 'guest'));
      return !raw || JSON.parse(raw).soundEffects !== false;
    } catch (e) { return true; }
  }

  function getCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = VOLUME;
      const comp = ctx.createDynamicsCompressor();
      master.connect(comp);
      comp.connect(ctx.destination);
    } catch (e) { ctx = null; }
    return ctx;
  }

  // iPhone/Chrome solo dejan sonar después de un toque del usuario
  function unlock() {
    const c = getCtx();
    if (!c) return;
    if (c.state === 'suspended') c.resume().catch(() => {});
    try {
      const b = c.createBuffer(1, 1, 22050);
      const s = c.createBufferSource();
      s.buffer = b; s.connect(c.destination); s.start(0);
    } catch (e) {}
    if (c.state === 'running') stopListening();
  }
  function startListening() {
    if (listening) return;
    listening = true;
    ['pointerdown', 'touchend', 'keydown', 'click'].forEach(ev =>
      window.addEventListener(ev, unlock, { capture: true, passive: true }));
  }
  function stopListening() {
    if (!listening) return;
    listening = false;
    ['pointerdown', 'touchend', 'keydown', 'click'].forEach(ev =>
      window.removeEventListener(ev, unlock, { capture: true }));
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ctx && ctx.state !== 'running') {
      ctx.resume().catch(() => {});
    }
  });
  startListening();

  // Una nota con ataque/caída suave. bell = añade un armónico para sonar a campanita.
  function tone(freq, start, dur, o = {}) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(freq, start);
    if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(o.slideTo, start + dur);
    const peak = o.gain ?? 0.25;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g); g.connect(master);
    osc.start(start); osc.stop(start + dur + 0.03);

    if (o.bell) {
      const o2 = ctx.createOscillator();
      const g2 = ctx.createGain();
      o2.type = 'sine';
      o2.frequency.setValueAtTime(freq * 2.01, start);
      g2.gain.setValueAtTime(0.0001, start);
      g2.gain.exponentialRampToValueAtTime(peak * 0.35, start + 0.01);
      g2.gain.exponentialRampToValueAtTime(0.0001, start + dur * 0.6);
      o2.connect(g2); g2.connect(master);
      o2.start(start); o2.stop(start + dur + 0.03);
    }
  }

  const SOUNDS = {
    // mensaje enviado: "pop" corto que sube
    send:    t => { tone(520, t, 0.10, { slideTo: 900, gain: 0.22 }); },
    // mensaje recibido con el chat abierto: dos notas suaves
    receive: t => { tone(740, t, 0.14, { gain: 0.18 }); tone(988, t + 0.09, 0.22, { gain: 0.16 }); },
    // notificación: campanita de dos tonos
    notif:   t => { tone(1175, t, 0.38, { bell: true, gain: 0.22 }); tone(1568, t + 0.15, 0.55, { bell: true, gain: 0.2 }); },
    // publicación subida: arpegio ascendente
    publish: t => {
      [523.25, 659.25, 783.99].forEach((f, i) => tone(f, t + i * 0.075, 0.22, { gain: 0.2 }));
      tone(1046.5, t + 0.24, 0.5, { bell: true, gain: 0.2 });
    },
    // acción corta (aprobar solicitud, etc.)
    pop:     t => { tone(680, t, 0.09, { slideTo: 1020, gain: 0.2 }); }
  };

  function play(name) {
    if (!enabled()) return;
    const fn = SOUNDS[name];
    if (!fn) return;
    const now = Date.now();
    if (lastPlayed[name] && now - lastPlayed[name] < MIN_GAP_MS) return;
    lastPlayed[name] = now;
    const c = getCtx();
    if (!c) return;
    if (c.state === 'suspended') c.resume().catch(() => {});
    if (c.state !== 'running' && c.state !== 'suspended') return;
    try { fn(c.currentTime + 0.01); } catch (e) { /* un sonido nunca debe romper la app */ }
  }

  return { play };
})();

function ogPlaySound(name) { ogSound.play(name); }
