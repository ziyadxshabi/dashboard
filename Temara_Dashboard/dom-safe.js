/**
 * DentaFlow OS — safe DOM builders (mitigates XSS from dynamic roster/CRM data).
 */
(function () {
  'use strict';

  function text(value) {
    return document.createTextNode(String(value ?? ''));
  }

  function clear(node) {
    if (!node) return;
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function el(tag, className, attrs) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (attrs && typeof attrs === 'object') {
      Object.entries(attrs).forEach(([key, value]) => {
        if (value == null) return;
        node.setAttribute(key, String(value));
      });
    }
    return node;
  }

  function setTextContent(node, value) {
    clear(node);
    node.appendChild(text(value));
  }

  function setStatusPill(node, label) {
    clear(node);
    node.appendChild(el('span', 'status-pill__dot', { 'aria-hidden': 'true' }));
    node.appendChild(text(label || '—'));
  }

  function appendParagraph(parent, className, message) {
    const p = el('p', className);
    p.appendChild(text(message));
    parent.appendChild(p);
    return p;
  }

  function createStatusPill(label, modifierClass = '') {
    const pill = el('span', ['status-pill', modifierClass].filter(Boolean).join(' '));
    setStatusPill(pill, label);
    return pill;
  }

  function lucideIcon(name, className = '') {
    const cls = className ? ` class="${className}"` : '';
    return `<i data-lucide="${name}"${cls} aria-hidden="true"></i>`;
  }

  function refreshLucideIcons(root) {
    if (typeof lucide === 'undefined' || typeof lucide.createIcons !== 'function') return;
    const options = { attrs: { 'stroke-width': 2 } };
    if (root && typeof root.querySelectorAll === 'function') {
      options.root = root;
    }
    lucide.createIcons(options);
  }

  window.DentaFlowDom = {
    text,
    clear,
    el,
    setTextContent,
    setStatusPill,
    appendParagraph,
    createStatusPill,
  };
  window.refreshLucideIcons = refreshLucideIcons;
  window.lucideIcon = lucideIcon;
})();
