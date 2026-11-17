/* =====================================================================
   verification-admin.js — Panel de administración de verificaciones.
   Requiere: verified-badge.js, verification.js (ya inicializado) y verification.css.

   Uso:
     <div id="verification-admin"></div>
     <script>
       VerificationAdmin.mount('#verification-admin');
     </script>

   Solo funciona para usuarios que estén en la tabla verification_admins
   (tu UID ya queda como admin con el SQL). Toda la seguridad real está en
   las políticas RLS y funciones RPC de Supabase, no solo en este archivo.
   ===================================================================== */
(function (global) {
  'use strict';

  var VS = function () { return global.VerificationSystem; };
  var esc = function (v) { return global.VerifiedBadge.escapeHtml(v); };

  var state = { root: null, tab: 'pending', counts: { pending: 0, approved: 0, rejected: 0 }, busy: false };

  var TABS = [
    { id: 'pending', label: 'Pendientes' },
    { id: 'approved', label: 'Aprobadas' },
    { id: 'rejected', label: 'Rechazadas' },
    { id: 'verified', label: 'Verificados' }
  ];

  function sb() { return VS().client(); }
  function fields() { return VS().CFG.fields; }
  function profilesTable() { return VS().CFG.profilesTable; }

  /* ---------------------------- Acceso ---------------------------- */
  async function isAdmin() {
    var res = await VS().withTimeout(sb().rpc('is_verification_admin'), 12000, 'permisos');
    if (res.error) throw new Error(res.error.message);
    return res.data === true;
  }

  /* ----------------------------- Datos ----------------------------- */
  async function loadCounts() {
    var statuses = ['pending', 'approved', 'rejected'];
    var results = await Promise.all(statuses.map(function (s) {
      return sb().from(VS().CFG.requestsTable)
        .select('id', { count: 'exact', head: true })
        .eq('status', s);
    }));
    statuses.forEach(function (s, i) { state.counts[s] = results[i].count || 0; });
  }

  async function loadRequests(status) {
    var f = fields();
    var res = await sb().from(VS().CFG.requestsTable)
      .select('*')
      .eq('status', status)
      .order('created_at', { ascending: status === 'pending' })
      .limit(100);
    if (res.error) throw new Error(res.error.message);
    var rows = res.data || [];

    // Perfiles en una consulta aparte (no requiere foreign key en Supabase)
    var ids = Array.from(new Set(rows.map(function (r) { return r.user_id; }).filter(Boolean)));
    if (ids.length) {
      var pr = await sb().from(profilesTable())
        .select('id,' + f.username + ',' + f.fullName + ',' + f.avatar)
        .in('id', ids);
      var map = {};
      (pr.data || []).forEach(function (p) { map[p.id] = p; });
      rows.forEach(function (r) { r.profile = map[r.user_id] || {}; });
    }
    return rows;
  }

  async function loadVerified() {
    var f = fields();
    var res = await sb().from(profilesTable())
      .select('id,is_verified,verified_type,verified_at,' + f.username + ',' + f.fullName + ',' + f.avatar)
      .eq('is_verified', true)
      .order('verified_at', { ascending: false })
      .limit(200);
    if (res.error) throw new Error(res.error.message);
    return res.data || [];
  }

  /* --------------------------- Utilidades --------------------------- */
  function safeUrl(u) {
    try {
      var url = new URL(u);
      return /^https?:$/.test(url.protocol) ? url.href : null;
    } catch (e) { return null; }
  }

  function safeImg(u) {
    return safeUrl(u);
  }

  function avatarHtml(profile) {
    var f = fields();
    var name = (profile && (profile[f.fullName] || profile[f.username])) || '?';
    var img = profile && safeImg(profile[f.avatar]);
    return '<div class="vadm-avatar">' +
      (img ? '<img src="' + esc(img) + '" alt="" loading="lazy">' : esc(String(name).charAt(0).toUpperCase())) +
      '</div>';
  }

  function typeSelect(selected) {
    var types = global.VerifiedBadge.TYPES;
    return '<select class="vf-input" data-role="type" aria-label="Tipo de insignia">' +
      Object.keys(types).map(function (k) {
        return '<option value="' + k + '"' + (k === selected ? ' selected' : '') + '>' + esc(types[k].label) + '</option>';
      }).join('') + '</select>';
  }

  /* ----------------------------- Render ----------------------------- */
  function shell() {
    state.root.innerHTML =
      '<section class="vadm">' +
      '<h2 class="vadm__title">' + global.VerifiedBadge.withName('Verificaciones', true, 'blue', { size: 'lg' }) + '</h2>' +
      '<div class="vadm__tabs" role="tablist"></div>' +
      '<div class="vadm__body" role="tabpanel"></div>' +
      '</section>';
    state.root.querySelector('.vadm__tabs').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-tab]');
      if (btn) setTab(btn.getAttribute('data-tab'));
    });
    state.root.querySelector('.vadm__body').addEventListener('click', onBodyClick);
    state.root.querySelector('.vadm__body').addEventListener('submit', onBodySubmit);
  }

  function renderTabs() {
    state.root.querySelector('.vadm__tabs').innerHTML = TABS.map(function (t) {
      var count = state.counts[t.id];
      return '<button type="button" class="vf-tab" role="tab" data-tab="' + t.id + '" aria-selected="' +
        (t.id === state.tab) + '">' + t.label +
        (t.id === 'pending' && count ? '<span class="vf-count">' + count + '</span>' : '') +
        '</button>';
    }).join('');
  }

  function requestCard(r) {
    var f = fields();
    var p = r.profile || {};
    var links = (r.links || []).map(safeUrl).filter(Boolean);
    var isPending = r.status === 'pending';
    var statusLabel = { pending: 'Pendiente', approved: 'Aprobada', rejected: 'Rechazada' }[r.status];

    return '<article class="vadm-card" data-id="' + esc(r.id) + '">' +
      '<div class="vadm-card__top">' + avatarHtml(p) +
      '<div class="vadm-card__who">' +
      '<div class="vadm-card__name">' + esc(r.full_name) + '</div>' +
      '<div class="vadm-card__meta">@' + esc(p[f.username] || 'desconocido') + ' · ' + esc(r.category) +
      ' · ' + esc(new Date(r.created_at).toLocaleDateString()) + '</div></div>' +
      '<span class="vadm-pill vadm-pill--' + esc(r.status) + '">' + statusLabel + '</span></div>' +
      '<p class="vadm-card__reason">' + esc(r.reason) + '</p>' +
      (links.length
        ? '<ul class="vadm-links">' + links.map(function (l) {
            return '<li><a href="' + esc(l) + '" target="_blank" rel="noopener noreferrer nofollow">' + esc(l) + '</a></li>';
          }).join('') + '</ul>'
        : '') +
      (!isPending && r.admin_note ? '<p class="vf-hint">Nota: ' + esc(r.admin_note) + '</p>' : '') +
      '<div class="vadm-card__actions">' +
      (r.document_path ? '<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" data-action="doc">Ver documento</button>' : '') +
      (isPending
        ? typeSelect('blue') +
          '<button type="button" class="vf-btn vf-btn--success vf-btn--sm" data-action="approve">Aprobar</button>' +
          '<button type="button" class="vf-btn vf-btn--danger vf-btn--sm" data-action="reject-open">Rechazar</button>'
        : '') +
      '</div>' +
      (isPending
        ? '<form class="vadm-note" data-form="reject" hidden>' +
          '<label class="vf-label" for="note-' + esc(r.id) + '">Motivo del rechazo (el usuario lo verá)</label>' +
          '<textarea class="vf-input" id="note-' + esc(r.id) + '" name="note" maxlength="500"></textarea>' +
          '<div class="vf-actions"><button type="submit" class="vf-btn vf-btn--danger vf-btn--sm">Confirmar rechazo</button></div>' +
          '</form>'
        : '') +
      '</article>';
  }

  function verifiedCard(p) {
    var f = fields();
    var name = p[f.fullName] || p[f.username] || 'Sin nombre';
    return '<article class="vadm-card" data-user="' + esc(p.id) + '">' +
      '<div class="vadm-card__top">' + avatarHtml(p) +
      '<div class="vadm-card__who">' +
      '<div class="vadm-card__name">' + global.VerifiedBadge.withName(name, true, p.verified_type) + '</div>' +
      '<div class="vadm-card__meta">@' + esc(p[f.username] || '') +
      (p.verified_at ? ' · desde ' + esc(new Date(p.verified_at).toLocaleDateString()) : '') + '</div></div></div>' +
      '<div class="vadm-card__actions">' + typeSelect(p.verified_type) +
      '<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" data-action="change-type">Cambiar tipo</button>' +
      '<button type="button" class="vf-btn vf-btn--danger vf-btn--sm" data-action="revoke">Quitar verificación</button>' +
      '</div></article>';
  }

  function manualForm() {
    return '<form class="vadm-manual" data-form="manual">' +
      '<input class="vf-input" name="username" placeholder="Nombre de usuario (sin @)" autocomplete="off" required>' +
      typeSelect('blue') +
      '<button type="submit" class="vf-btn vf-btn--sm">Verificar manualmente</button></form>';
  }

  async function render() {
    var body = state.root.querySelector('.vadm__body');
    renderTabs();
    body.innerHTML = '<div class="vadm__empty">Cargando…</div>';

    try {
      if (state.tab === 'verified') {
        var users = await loadVerified();
        body.innerHTML = manualForm() + '<div class="vadm__list">' +
          (users.length ? users.map(verifiedCard).join('') : '<div class="vadm__empty">Todavía no hay cuentas verificadas.</div>') +
          '</div>';
      } else {
        var list = await loadRequests(state.tab);
        body.innerHTML = '<div class="vadm__list">' +
          (list.length ? list.map(requestCard).join('') : '<div class="vadm__empty">No hay solicitudes en esta pestaña.</div>') +
          '</div>';
      }
    } catch (err) {
      body.innerHTML = '<div class="vadm__empty">No se pudo cargar: ' + esc(err.message) + '</div>';
    }
  }

  async function setTab(tab) {
    state.tab = tab;
    await render();
  }

  async function reload() {
    await loadCounts();
    await render();
    VS().refresh();
  }

  /* ---------------------------- Acciones ---------------------------- */
  async function run(btn, fn, okMessage) {
    if (state.busy) return;
    state.busy = true;
    if (btn) btn.disabled = true;
    try {
      await fn();
      VS().toast(okMessage, 'success');
      await reload();
    } catch (err) {
      VS().toast(err.message || 'Algo salió mal', 'error');
      if (btn) btn.disabled = false;
    } finally {
      state.busy = false;
    }
  }

  async function onBodyClick(e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var card = btn.closest('.vadm-card');
    var action = btn.getAttribute('data-action');
    var typeEl = card.querySelector('[data-role="type"]');
    var type = typeEl ? typeEl.value : 'blue';

    if (action === 'doc') {
      var req = card.getAttribute('data-id');
      var row = await sb().from(VS().CFG.requestsTable).select('document_path').eq('id', req).single();
      if (row.error || !row.data.document_path) return VS().toast('No se encontró el documento.', 'error');
      var signed = await sb().storage.from(VS().CFG.bucket).createSignedUrl(row.data.document_path, 120);
      if (signed.error) return VS().toast(signed.error.message, 'error');
      window.open(signed.data.signedUrl, '_blank', 'noopener,noreferrer');
      return;
    }

    if (action === 'approve') {
      var id = card.getAttribute('data-id');
      run(btn, async function () {
        var res = await sb().rpc('review_verification_request', {
          p_request_id: id, p_approve: true, p_type: type, p_note: null
        });
        if (res.error) throw new Error(res.error.message);
      }, 'Solicitud aprobada. La insignia ya está activa.');
      return;
    }

    if (action === 'reject-open') {
      var form = card.querySelector('[data-form="reject"]');
      form.hidden = !form.hidden;
      if (!form.hidden) form.querySelector('textarea').focus();
      return;
    }

    if (action === 'change-type' || action === 'revoke') {
      var userId = card.getAttribute('data-user');
      var verified = action === 'change-type';
      if (!verified && !global.confirm('¿Quitar la verificación a esta cuenta?')) return;
      run(btn, async function () {
        var res = await sb().rpc('set_user_verified', { p_user_id: userId, p_verified: verified, p_type: type });
        if (res.error) throw new Error(res.error.message);
      }, verified ? 'Tipo de insignia actualizado.' : 'Verificación retirada.');
    }
  }

  async function onBodySubmit(e) {
    e.preventDefault();
    var form = e.target;
    var kind = form.getAttribute('data-form');
    var submit = form.querySelector('[type="submit"]');

    if (kind === 'reject') {
      var id = form.closest('.vadm-card').getAttribute('data-id');
      var note = form.note.value.trim();
      run(submit, async function () {
        var res = await sb().rpc('review_verification_request', {
          p_request_id: id, p_approve: false, p_type: 'blue', p_note: note || null
        });
        if (res.error) throw new Error(res.error.message);
      }, 'Solicitud rechazada.');
      return;
    }

    if (kind === 'manual') {
      var username = form.username.value.trim().replace(/^@/, '');
      var type = form.querySelector('[data-role="type"]').value;
      run(submit, async function () {
        var f = fields();
        var found = await sb().from(profilesTable()).select('id').eq(f.username, username).maybeSingle();
        if (found.error) throw new Error(found.error.message);
        if (!found.data) throw new Error('No existe el usuario @' + username);
        var res = await sb().rpc('set_user_verified', { p_user_id: found.data.id, p_verified: true, p_type: type });
        if (res.error) throw new Error(res.error.message);
        form.reset();
      }, '@' + username + ' ahora está verificado.');
    }
  }

  /* ------------------------------ Mount ------------------------------ */
  async function mount(target) {
    var root = typeof target === 'string' ? document.querySelector(target) : target;
    if (!root) throw new Error('VerificationAdmin.mount(): contenedor no encontrado.');
    state.root = root;
    root.innerHTML = '<div class="vadm__denied">Comprobando permisos…</div>';

    var ok = false;
    try {
      ok = await isAdmin();
    } catch (err) {
      root.innerHTML = '<div class="vadm__denied">No se pudo comprobar tu acceso: ' + esc(err.message) + '</div>';
      return false;
    }

    if (!ok) {
      root.innerHTML = '<div class="vadm__denied">No tienes permisos para ver este panel.</div>';
      return false;
    }

    shell();
    await loadCounts();
    await render();
    return true;
  }

  global.VerificationAdmin = { mount: mount, reload: reload, isAdmin: isAdmin };
})(window);
