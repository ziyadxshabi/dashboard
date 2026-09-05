/**
 * Public patient booking portal — loads clinic theme + Cal.com embed.
 */
(function () {
  'use strict';

  const DEFAULT_SLUG = 'temara';
  const DEFAULT_CAL_LINK = 'dentaflow/temara';
  const FALLBACK_MESSAGE = 'Clinique introuvable ou service momentanément indisponible';
  const TOKEN_NAME_RE = /^--[a-zA-Z0-9-]+$/;
  const TOKEN_UNSAFE_RE = /url\s*\(|expression\s*\(|javascript:|@import/i;
  const CAL_LINK_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/;
  const CAL_HOSTS = { 'cal.com': true, 'www.cal.com': true, 'app.cal.com': true };

  function extractSlug() {
    const pathname = String(window.location.pathname || '').replace(/\/+$/, '');
    const parts = pathname.split('/').filter(Boolean);
    const bookIdx = parts.indexOf('book');
    if (bookIdx >= 0) {
      const fromPath = String(parts[bookIdx + 1] || '').trim().toLowerCase();
      if (fromPath && fromPath !== 'book.html') return fromPath;
    }
    const fromQuery = new URLSearchParams(window.location.search).get('slug');
    return String(fromQuery || DEFAULT_SLUG).trim().toLowerCase() || DEFAULT_SLUG;
  }

  function $(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value || '';
  }

  function applyThemeTokens(tokens) {
    if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return;
    const root = document.documentElement.style;
    Object.keys(tokens).forEach((key) => {
      const name = key.indexOf('--') === 0 ? key : `--${key}`;
      if (!TOKEN_NAME_RE.test(name)) return;
      const value = String(tokens[key] ?? '').trim();
      if (!value || TOKEN_UNSAFE_RE.test(value)) return;
      root.setProperty(name, value);
    });
  }

  function telHref(phone) {
    const compact = String(phone || '').replace(/[^\d+]/g, '');
    return compact ? `tel:${compact}` : '';
  }

  function sanitizeCalLink(raw) {
    const link = String(raw || '').trim().replace(/^\/+/, '');
    if (link && CAL_LINK_RE.test(link)) return link;
    return DEFAULT_CAL_LINK;
  }

  function resolveCalEmbed(clinic) {
    const embedUrl = String(clinic.calEmbedUrl || clinic.cal_embed_url || '').trim();
    const eventType = String(clinic.calEventTypeId || clinic.cal_event_type_id || '').trim();

    if (embedUrl) {
      try {
        const parsed = new URL(embedUrl);
        if (/^https?:$/i.test(parsed.protocol) && CAL_HOSTS[parsed.hostname]) {
          const calLink = sanitizeCalLink(parsed.pathname.replace(/^\/+/, ''));
          return { calLink, iframeSrc: `https://cal.com/${calLink}` };
        }
        if (parsed.protocol === 'https:') {
          return { calLink: sanitizeCalLink(eventType), iframeSrc: embedUrl };
        }
      } catch {
        const asPath = embedUrl.replace(/^https?:\/\/(?:www\.|app\.)?cal\.com\/+/i, '');
        const calLink = sanitizeCalLink(asPath);
        return { calLink, iframeSrc: `https://cal.com/${calLink}` };
      }
    }

    const calLink = sanitizeCalLink(eventType);
    return { calLink, iframeSrc: `https://cal.com/${calLink}` };
  }

  function showError(message) {
    const page = $('book-page');
    const error = $('book-error');
    const errorText = $('book-error-text');
    if (page) page.hidden = true;
    if (error) error.hidden = false;
    if (errorText) errorText.textContent = message || FALLBACK_MESSAGE;
    document.title = 'Prise de rendez-vous';
  }

  function mountIframe(container, iframeSrc) {
    if (!container) return;
    container.replaceChildren();
    const frame = document.createElement('iframe');
    frame.title = 'Calendrier de prise de rendez-vous';
    frame.src = iframeSrc;
    frame.loading = 'lazy';
    frame.referrerPolicy = 'no-referrer-when-downgrade';
    frame.setAttribute('allow', 'camera; microphone; fullscreen; payment');
    container.appendChild(frame);
  }

  function loadCalEmbed(container, calLink, iframeSrc) {
    if (!container) return;
    const fallbackSrc = iframeSrc || `https://cal.com/${calLink}`;

    function startInline() {
      if (typeof window.Cal !== 'function') {
        mountIframe(container, fallbackSrc);
        return;
      }
      try {
        window.Cal('init', { origin: 'https://cal.com' });
        window.Cal('inline', {
          elementOrSelector: container,
          calLink,
          layout: 'month_view',
        });
      } catch {
        mountIframe(container, fallbackSrc);
      }
    }

    if (typeof window.Cal === 'function') {
      startInline();
      return;
    }

    const existing = document.querySelector('script[data-cal-embed]');
    if (existing) {
      existing.addEventListener('load', startInline, { once: true });
      existing.addEventListener('error', () => mountIframe(container, fallbackSrc), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://app.cal.com/embed/embed.js';
    script.async = true;
    script.dataset.calEmbed = 'true';
    script.addEventListener('load', startInline, { once: true });
    script.addEventListener('error', () => mountIframe(container, fallbackSrc), { once: true });
    document.head.appendChild(script);
  }

  function applyClinic(clinic) {
    const name = clinic.name || 'Clinique';
    const phone = clinic.phone || '';
    const preset = clinic.themePreset || clinic.theme_preset || 'oak-lounge';

    document.documentElement.setAttribute('data-theme', preset);
    document.title = `${name} — Prise de rendez-vous en ligne`;

    setText('book-clinic-name', name);
    setText('book-clinic-name-footer', name);
    setText('book-hero-clinic', name);

    const headerPhone = $('book-header-phone');
    const footerPhone = $('book-footer-phone');
    const href = telHref(phone);

    [headerPhone, footerPhone].forEach((el) => {
      if (!el) return;
      if (href) {
        el.hidden = false;
        el.href = href;
        el.textContent = phone;
      } else {
        el.hidden = true;
        el.removeAttribute('href');
        el.textContent = '';
      }
    });

    applyThemeTokens(clinic.themeTokens || clinic.theme_tokens);

    const embed = $('cal-embed');
    const { calLink, iframeSrc } = resolveCalEmbed(clinic);
    loadCalEmbed(embed, calLink, iframeSrc);

    const page = $('book-page');
    const error = $('book-error');
    if (page) page.hidden = false;
    if (error) error.hidden = true;
  }

  async function init() {
    const slug = extractSlug();
    try {
      const response = await fetch(`/api/public/clinic/${encodeURIComponent(slug)}`, {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.ok === false || !payload.clinic) {
        showError(FALLBACK_MESSAGE);
        return;
      }
      applyClinic(payload.clinic);
    } catch {
      showError(FALLBACK_MESSAGE);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
