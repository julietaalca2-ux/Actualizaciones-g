/* =====================================================================
   verification.js — Lado usuario del sistema de verificación.
   Requiere: verified-badge.js, verification.css y un cliente de Supabase.

   Inicialización (una vez, después de crear tu cliente):
     VerificationSystem.init(supabaseClient);

   Uso en HTML:
     <!-- Insignia automática junto a un usuario (consulta su estado) -->
     <span data-verify-user="UUID_DEL_USUARIO">Nombre</span>

     <!-- Botón que abre el formulario de solicitud -->
     <button data-verification-request>Solicitar verificación</button>

   Uso en JS:
     VerificationSystem.openRequestModal();
     await VerificationSystem.getMyStatus();
     await VerificationSystem.decorateUsers(contenedor);   // tras renderizar el feed
   ===================================================================== */
(function (global) {
  'use strict';

  var CFG = {
    profilesTable: 'profiles',
    requestsTable: 'verification_requests',
    bucket: 'verification-docs',
    // Nombres de columnas en TU tabla profiles (ajústalos si son distintos)
    fields: { username: 'username', fullName: 'full_name', avatar: 'avatar_url' },
    maxFileMB: 5,
    allowedFiles: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    cacheMs: 5 * 60 * 1000,
    categories: [
      'Creador de contenido',
      'Artista o músico',
      'Periodista o medio',
      'Marca o negocio',
      'Figura pública o deportista',
      'Organización o institución',
      'Otro'
    ]
  };

  var sb = null;
  var userGetter = null;

  /** Evita que una llamada colgada deje la interfaz esperando para siempre */
  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () {
        reject(new Error('Tiempo agotado' + (label ? ' (' + label + ')' : '') + '. Revisa tu conexión y vuelve a intentarlo.'));
      }, ms || 12000);
      Promise.resolve(promise).then(
        function (r) { clearTimeout(t); resolve(r); },
        function (e) { clearTimeout(t); reject(e); }
      );
    });
  }
  var cache = new Map(); // userId -> { verified, type, at }
  var observer = null;
  var esc = function (v) { return global.VerifiedBadge.escapeHtml(v); };

  /* ------------------------------ Init ------------------------------ */
  function init(client, overrides) {
    var candidate = client || global.supabaseClient || global.supabase;
    if (!candidate || typeof candidate.from !== 'function') {
      throw new Error('VerificationSystem.init(): pasa tu cliente de Supabase (createClient).');
    }
    sb = candidate;
    if (overrides) {
      Object.keys(overrides).forEach(function (k) {
        if (k === 'fields') Object.assign(CFG.fields, overrides.fields);
        else if (k === 'getUser') userGetter = overrides.getUser;
        else CFG[k] = overrides[k];
      });
    }
    observe(document.body);
    decorateUsers(document);
    return api;
  }

  function requireClient() {
    if (!sb) throw new Error('VerificationSystem no está inicializado. Llama a init(supabase).');
    return sb;
  }

  async function currentUser() {
    // 1) Usuario que ya tiene la app en memoria (sin llamadas de red)
    try {
      var hint = userGetter && userGetter();
      if (hint && hint.id) return hint;
    } catch (e) {}
    // 2) Sesión guardada localmente
    var res = await withTimeout(requireClient().auth.getSession(), 8000, 'sesión');
    return res && res.data && res.data.session ? res.data.session.user : null;
  }

  /* ----------------------------- Toasts ----------------------------- */
  function toast(message, type) {
    var host = document.querySelector('.vf-toasts');
    if (!host) {
      host = document.createElement('div');
      host.className = 'vf-toasts';
      host.style.zIndex = '2147483001';
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    var el = document.createElement('div');
    el.className = 'vf-toast' + (type ? ' vf-toast--' + type : '');
    el.textContent = message;
    host.appendChild(el);
    setTimeout(function () { el.remove(); }, 4200);
  }

  /* -------------------- Estado de verificación -------------------- */
  async function fetchVerified(ids) {
    var now = Date.now();
    var missing = ids.filter(function (id) {
      var hit = cache.get(id);
      return !hit || now - hit.at > CFG.cacheMs;
    });

    for (var i = 0; i < missing.length; i += 100) {
      var chunk = missing.slice(i, i + 100);
      var res = await withTimeout(requireClient()
        .from(CFG.profilesTable)
        .select('id,is_verified,verified_type')
        .in('id', chunk), 12000, 'verificados');

      var found = {};
      (res.data || []).forEach(function (row) {
        found[row.id] = row;
        cache.set(row.id, { verified: !!row.is_verified, type: row.verified_type || 'blue', at: now });
      });
      chunk.forEach(function (id) {
        if (!found[id]) cache.set(id, { verified: false, type: 'blue', at: now });
      });
    }
  }

  /** ¿Está verificado este usuario? → { verified, type } */
  async function getUserBadge(userId) {
    await fetchVerified([userId]);
    return cache.get(userId);
  }

  /** Mi estado + mi última solicitud */
  async function getMyStatus() {
    var user = await currentUser();
    if (!user) return { loggedIn: false };

    var profileRes = await withTimeout(requireClient()
      .from(CFG.profilesTable)
      .select('is_verified,verified_type,verified_at')
      .eq('id', user.id)
      .maybeSingle(), 12000, 'perfil');
    if (profileRes.error) throw new Error(profileRes.error.message);

    var reqRes = await withTimeout(requireClient()
      .from(CFG.requestsTable)
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(), 12000, 'solicitudes');
    if (reqRes.error) throw new Error(reqRes.error.message);

    var profile = profileRes.data || {};
    return {
      loggedIn: true,
      userId: user.id,
      verified: !!profile.is_verified,
      type: profile.verified_type || 'blue',
      verifiedAt: profile.verified_at || null,
      request: reqRes.data || null
    };
  }

  /* --------------- Decorar elementos [data-verify-user] --------------- */
  async function decorateUsers(root) {
    if (!sb) return;
    root = root || document;
    var nodes = Array.prototype.slice.call(
      root.querySelectorAll('[data-verify-user]:not([data-verify-done])')
    );
    if (!nodes.length) return;

    nodes.forEach(function (n) { n.setAttribute('data-verify-done', '1'); });
    var ids = Array.from(new Set(nodes.map(function (n) { return n.getAttribute('data-verify-user'); })))
      .filter(Boolean);

    try {
      await fetchVerified(ids);
    } catch (err) {
      console.warn('[verification] No se pudo consultar verificados:', err);
      return;
    }

    nodes.forEach(function (node) {
      var info = cache.get(node.getAttribute('data-verify-user'));
      if (!info || !info.verified) return;
      var targetSel = node.getAttribute('data-verify-target');
      var target = targetSel ? node.querySelector(targetSel) : node;
      global.VerifiedBadge.append(target || node, info.type);
    });
  }

  function observe(root) {
    if (observer || !global.MutationObserver) return;
    var queued = false;
    observer = new MutationObserver(function () {
      if (queued) return;
      queued = true;
      global.requestAnimationFrame(function () {
        queued = false;
        decorateUsers(document);
      });
    });
    observer.observe(root, { childList: true, subtree: true });
  }

  /** Olvida el caché (útil tras aprobar/revocar) y repinta */
  function refresh() {
    cache.clear();
    document.querySelectorAll('[data-verify-done]').forEach(function (n) {
      n.removeAttribute('data-verify-done');
      var b = n.querySelector(':scope > [data-vbadge]');
      if (b) b.remove();
    });
    return decorateUsers(document);
  }

  /* ----------------------- Enviar solicitud ----------------------- */
  function sanitizeLinks(raw) {
    return String(raw || '')
      .split(/\r?\n/)
      .map(function (l) { return l.trim(); })
      .filter(Boolean)
      .slice(0, 5)
      .map(function (l) { return /^https?:\/\//i.test(l) ? l : 'https://' + l; })
      .filter(function (l) {
        try { return /^https?:$/.test(new URL(l).protocol); } catch (e) { return false; }
      });
  }

  async function submitRequest(data) {
    var user = await currentUser();
    if (!user) throw new Error('Debes iniciar sesión para solicitar la verificación.');

    var fullName = String(data.fullName || '').trim();
    var category = String(data.category || '').trim();
    var reason = String(data.reason || '').trim();
    var links = sanitizeLinks(data.links);
    var file = data.file || null;

    if (fullName.length < 2) throw new Error('Escribe tu nombre completo o el de tu marca.');
    if (!category) throw new Error('Elige una categoría.');
    if (reason.length < 20) throw new Error('Cuéntanos con más detalle por qué deberías estar verificado (mínimo 20 caracteres).');
    if (!file) throw new Error('Adjunta un documento que confirme tu identidad.');
    if (CFG.allowedFiles.indexOf(file.type) === -1) throw new Error('El documento debe ser JPG, PNG, WEBP o PDF.');
    if (file.size > CFG.maxFileMB * 1024 * 1024) throw new Error('El documento supera los ' + CFG.maxFileMB + ' MB.');

    var safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60);
    var path = user.id + '/' + Date.now() + '-' + safeName;

    var up = await requireClient().storage.from(CFG.bucket).upload(path, file, {
      contentType: file.type,
      upsert: false
    });
    if (up.error) throw new Error('No se pudo subir el documento: ' + up.error.message);

    var ins = await requireClient().from(CFG.requestsTable).insert({
      user_id: user.id,
      full_name: fullName,
      category: category,
      reason: reason,
      links: links,
      document_path: path
    });

    if (ins.error) {
      await requireClient().storage.from(CFG.bucket).remove([path]);
      if (ins.error.code === '23505') throw new Error('Ya tienes una solicitud pendiente de revisión.');
      throw new Error(ins.error.message);
    }
  }

  async function cancelRequest(requestId) {
    var res = await requireClient().from(CFG.requestsTable).delete().eq('id', requestId);
    if (res.error) throw new Error(res.error.message);
  }

  /* -------------------------- Modal UI -------------------------- */
  function openModal(innerHtml, labelledBy) {
    closeModal();
    var overlay = document.createElement('div');
    overlay.className = 'vf-overlay';
    overlay.style.position = 'fixed';
    overlay.style.zIndex = '2147483000';
    overlay.innerHTML =
      '<div class="vf-modal" role="dialog" aria-modal="true" aria-labelledby="' + labelledBy + '">' +
      '<button type="button" class="vf-close" aria-label="Cerrar">&times;</button>' +
      innerHtml + '</div>';
    document.body.appendChild(overlay);

    var previous = document.activeElement;
    function onKey(e) { if (e.key === 'Escape') closeModal(); }
    overlay._cleanup = function () {
      document.removeEventListener('keydown', onKey);
      if (previous && previous.focus) previous.focus();
    };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closeModal(); });
    overlay.querySelector('.vf-close').addEventListener('click', closeModal);

    var first = overlay.querySelector('input,select,textarea,button:not(.vf-close)');
    if (first) first.focus();
    return overlay;
  }

  function closeModal() {
    var overlay = document.querySelector('.vf-overlay');
    if (!overlay) return;
    if (overlay._cleanup) overlay._cleanup();
    overlay.remove();
  }

  function head(title) {
    return '<div class="vf-modal__head">' + global.VerifiedBadge.html('blue', { size: 'xl' }) +
      '<h2 id="vf-title">' + esc(title) + '</h2></div>';
  }

  async function openRequestModal() {
    var status;
    try {
      status = await getMyStatus();
    } catch (err) {
      toast('No se pudo cargar tu estado: ' + err.message, 'error');
      return;
    }

    if (!status.loggedIn) {
      toast('Inicia sesión para solicitar la verificación.', 'error');
      return;
    }

    if (status.verified) {
      var done = openModal(
        head('Tu cuenta está verificada') +
        '<div class="vf-status vf-status--approved"><strong>Insignia activa</strong>' +
        'Tu perfil muestra la insignia ' + global.VerifiedBadge.html(status.type) + '</div>' +
        '<div class="vf-actions"><button type="button" class="vf-btn" data-close>Listo</button></div>',
        'vf-title');
      done.querySelector('[data-close]').addEventListener('click', closeModal);
      return;
    }

    var req = status.request;
    if (req && req.status === 'pending') {
      var pending = openModal(
        head('Solicitud en revisión') +
        '<div class="vf-status vf-status--pending"><strong>Estamos revisando tu solicitud</strong>' +
        'Enviada el ' + esc(new Date(req.created_at).toLocaleDateString()) +
        '. Te aparecerá la insignia en cuanto se apruebe.</div>' +
        '<div class="vf-actions">' +
        '<button type="button" class="vf-btn vf-btn--ghost" data-cancel>Cancelar solicitud</button>' +
        '<button type="button" class="vf-btn" data-close>Entendido</button></div>',
        'vf-title');
      pending.querySelector('[data-close]').addEventListener('click', closeModal);
      pending.querySelector('[data-cancel]').addEventListener('click', async function () {
        try {
          await cancelRequest(req.id);
          toast('Solicitud cancelada.', 'success');
          closeModal();
        } catch (err) { toast(err.message, 'error'); }
      });
      return;
    }

    var rejectedNote = '';
    if (req && req.status === 'rejected') {
      rejectedNote = '<div class="vf-status vf-status--rejected" style="margin-bottom:16px">' +
        '<strong>Tu última solicitud no fue aprobada</strong>' +
        (req.admin_note ? esc(req.admin_note) : 'Puedes volver a intentarlo con más información.') +
        '</div>';
    }

    var options = CFG.categories.map(function (c) {
      return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
    }).join('');

    var modal = openModal(
      head('Solicitar verificación') +
      '<p class="vf-lead">La insignia confirma que tu cuenta es auténtica y representa a una persona, marca u organización real.</p>' +
      rejectedNote +
      '<div class="vf-error" hidden role="alert"></div>' +
      '<form novalidate>' +
      '<div class="vf-field"><label class="vf-label" for="vf-name">Nombre completo o de la marca</label>' +
      '<input class="vf-input" id="vf-name" name="fullName" maxlength="120" autocomplete="name" required></div>' +
      '<div class="vf-field"><label class="vf-label" for="vf-cat">Categoría</label>' +
      '<select class="vf-input" id="vf-cat" name="category" required>' + options + '</select></div>' +
      '<div class="vf-field"><label class="vf-label" for="vf-reason">¿Por qué deberías estar verificado?</label>' +
      '<textarea class="vf-input" id="vf-reason" name="reason" maxlength="1000" required></textarea></div>' +
      '<div class="vf-field"><label class="vf-label" for="vf-links">Enlaces que lo demuestren</label>' +
      '<textarea class="vf-input" id="vf-links" name="links" placeholder="https://..."></textarea>' +
      '<p class="vf-hint">Uno por línea, máximo 5 (web oficial, prensa, otras redes).</p></div>' +
      '<div class="vf-field"><label class="vf-label" for="vf-file">Documento de identidad</label>' +
      '<input class="vf-input" id="vf-file" name="file" type="file" accept=".jpg,.jpeg,.png,.webp,.pdf" required>' +
      '<p class="vf-hint">JPG, PNG, WEBP o PDF, máximo ' + CFG.maxFileMB + ' MB. Solo lo ven los administradores.</p></div>' +
      '<div class="vf-actions">' +
      '<button type="button" class="vf-btn vf-btn--ghost" data-close>Cancelar</button>' +
      '<button type="submit" class="vf-btn">Enviar solicitud</button></div>' +
      '</form>',
      'vf-title');

    var form = modal.querySelector('form');
    var errBox = modal.querySelector('.vf-error');
    var submit = form.querySelector('[type="submit"]');
    modal.querySelector('[data-close]').addEventListener('click', closeModal);

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      errBox.hidden = true;
      submit.disabled = true;
      submit.textContent = 'Enviando…';
      try {
        await submitRequest({
          fullName: form.fullName.value,
          category: form.category.value,
          reason: form.reason.value,
          links: form.links.value,
          file: form.file.files[0]
        });
        closeModal();
        toast('Solicitud enviada. Te avisaremos cuando se revise.', 'success');
        document.dispatchEvent(new CustomEvent('verification:submitted'));
      } catch (err) {
        errBox.textContent = err.message;
        errBox.hidden = false;
        submit.disabled = false;
        submit.textContent = 'Enviar solicitud';
      }
    });
  }

  // Cualquier elemento con data-verification-request abre el formulario
  document.addEventListener('click', function (e) {
    var trigger = e.target.closest && e.target.closest('[data-verification-request]');
    if (trigger) {
      e.preventDefault();
      openRequestModal();
    }
  });

  var api = {
    CFG: CFG,
    init: init,
    client: function () { return requireClient(); },
    toast: toast,
    withTimeout: withTimeout,
    getMyStatus: getMyStatus,
    getUserBadge: getUserBadge,
    decorateUsers: decorateUsers,
    refresh: refresh,
    submitRequest: submitRequest,
    cancelRequest: cancelRequest,
    openRequestModal: openRequestModal,
    closeModal: closeModal
  };

  global.VerificationSystem = api;
})(window);
