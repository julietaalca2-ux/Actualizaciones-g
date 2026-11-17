/* =====================================================================
   verified-badge.js — Insignia de verificación estilo Instagram.
   No depende de Supabase. Cárgalo ANTES de verification.js.

   Uso rápido:
     VerifiedBadge.html('blue')                      → string HTML
     VerifiedBadge.element('gold', { size: 'lg' })   → elemento DOM
     VerifiedBadge.withName('Ana', true, 'blue')     → "Ana" + insignia (HTML seguro)
     VerifiedBadge.append(miElemento, 'blue')

   Automático: cualquier elemento con
     data-verified="true" data-verified-type="blue|gold|gray"
   recibe la insignia al final (también los que se añadan después al DOM).
   ===================================================================== */
(function (global) {
  'use strict';

  var TYPES = {
    blue: { label: 'Cuenta verificada', cls: 'vbadge--blue' },
    gold: { label: 'Negocio verificado', cls: 'vbadge--gold' },
    gray: { label: 'Cuenta oficial verificada', cls: 'vbadge--gray' }
  };

  var SIZES = { sm: 'vbadge--sm', md: '', lg: 'vbadge--lg', xl: 'vbadge--xl' };

  // Sello ondulado de 8 lóbulos (forma de la insignia de Instagram)
  var SEAL_PATH = (function () {
    var steps = 120, parts = [];
    for (var i = 0; i < steps; i++) {
      var t = (i / steps) * Math.PI * 2;
      var r = 10.4 + 0.95 * Math.cos(8 * t);
      var x = 12 + r * Math.cos(t);
      var y = 12 + r * Math.sin(t);
      parts.push((i ? 'L' : 'M') + x.toFixed(2) + ' ' + y.toFixed(2));
    }
    return parts.join('') + 'Z';
  })();

  var CHECK_PATH = 'M7.4 12.5l3.2 3.2 6.1-6.6';

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeType(type) {
    return TYPES[type] ? type : 'blue';
  }

  /**
   * @param {string} type  'blue' | 'gold' | 'gray'
   * @param {{size?: 'sm'|'md'|'lg'|'xl'|number, label?: string}} [opts]
   */
  function html(type, opts) {
    opts = opts || {};
    type = normalizeType(type);
    var cfg = TYPES[type];
    var label = escapeHtml(opts.label || cfg.label);
    var classes = ['vbadge', cfg.cls];
    var style = '';

    if (typeof opts.size === 'number') {
      style = ' style="width:' + opts.size + 'px;height:' + opts.size + 'px"';
    } else if (opts.size && SIZES[opts.size]) {
      classes.push(SIZES[opts.size]);
    }

    return '<span class="' + classes.join(' ').trim() + '" role="img" aria-label="' + label +
      '" title="' + label + '" data-vbadge="' + type + '"' + style + '>' +
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path class="vbadge__seal" d="' + SEAL_PATH + '"/>' +
      '<path class="vbadge__check" d="' + CHECK_PATH + '"/>' +
      '</svg></span>';
  }

  function element(type, opts) {
    var tpl = document.createElement('template');
    tpl.innerHTML = html(type, opts);
    return tpl.content.firstElementChild;
  }

  function append(target, type, opts) {
    if (!target || target.querySelector(':scope > [data-vbadge]')) return null;
    var el = element(type, opts);
    target.appendChild(el);
    return el;
  }

  /** Nombre (escapado) + insignia opcional, listo para innerHTML */
  function withName(name, isVerified, type, opts) {
    return '<span class="vname"><span class="vname__text">' + escapeHtml(name) + '</span>' +
      (isVerified ? html(type, opts) : '') + '</span>';
  }

  /** Añade insignia a todos los [data-verified="true"] dentro de root */
  function decorate(root) {
    root = root || document;
    var nodes = root.querySelectorAll('[data-verified="true"]:not([data-vbadge-done])');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      node.setAttribute('data-vbadge-done', '1');
      append(node, node.getAttribute('data-verified-type'));
    }
  }

  var observer = null;
  var queued = false;

  /** Observa el DOM para decorar contenido que se renderiza dinámicamente (feed, comentarios…) */
  function observe(root) {
    if (observer || !global.MutationObserver) return;
    observer = new MutationObserver(function () {
      if (queued) return;
      queued = true;
      global.requestAnimationFrame(function () {
        queued = false;
        decorate(document);
      });
    });
    observer.observe(root || document.body, { childList: true, subtree: true });
  }

  function start() {
    decorate(document);
    observe(document.body);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  global.VerifiedBadge = {
    TYPES: TYPES,
    html: html,
    element: element,
    append: append,
    withName: withName,
    decorate: decorate,
    observe: observe,
    escapeHtml: escapeHtml
  };
})(window);
