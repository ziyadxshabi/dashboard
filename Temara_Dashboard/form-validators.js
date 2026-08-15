/**
 * DentaFlow OS — shared field validators (blur + submit).
 * Error copy is French. Optional empty fields are skipped.
 */
(function (global) {
  'use strict';

  var PHONE_RE = /^(\+212\s?|0)[5-7]\d{8}$/;
  var NAME_RE = /^[a-zA-Z\s\-']+$/;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var PIN_RE = /^\d{4}$/;

  var MESSAGES = {
    username: 'Identifiant requis (min. 3 caractères)',
    password: 'Mot de passe requis (min. 6 caractères)',
    pin: 'Code PIN de 4 chiffres requis',
    phone: 'Numéro de téléphone invalide (format: 06XX XXX XXX)',
    name: 'Nom invalide',
    email: 'Adresse email invalide',
  };

  function compactPhone(value) {
    var raw = String(value || '').trim();
    if (!raw) return '';
    var compact = raw.replace(/[\s.\-]/g, '');
    if (compact.indexOf('+212') === 0) {
      return '+212' + compact.slice(4);
    }
    return compact;
  }

  function errorFor(kind, value, required) {
    var trimmed = String(value || '').trim();
    if (!trimmed) {
      return required ? MESSAGES[kind] : '';
    }

    if (kind === 'username') {
      if (trimmed.length < 3 || trimmed.length > 50) return MESSAGES.username;
      return '';
    }
    if (kind === 'password') {
      if (String(value).length < 6) return MESSAGES.password;
      return '';
    }
    if (kind === 'pin') {
      return PIN_RE.test(trimmed) ? '' : MESSAGES.pin;
    }
    if (kind === 'phone') {
      return PHONE_RE.test(compactPhone(trimmed)) ? '' : MESSAGES.phone;
    }
    if (kind === 'name') {
      if (trimmed.length < 2 || trimmed.length > 100) return MESSAGES.name;
      return NAME_RE.test(trimmed) ? '' : MESSAGES.name;
    }
    if (kind === 'email') {
      return EMAIL_RE.test(trimmed) ? '' : MESSAGES.email;
    }
    return '';
  }

  function errorElFor(input) {
    if (!input) return null;
    var described = input.getAttribute('aria-describedby');
    if (described) {
      var firstId = described.split(/\s+/)[0];
      var describedEl = document.getElementById(firstId);
      if (describedEl) return describedEl;
    }
    if (input.id) {
      return document.getElementById(input.id + '-error');
    }
    return null;
  }

  function setFieldError(input, message) {
    if (!input) return;
    var errorEl = errorElFor(input);
    if (message) {
      input.setAttribute('aria-invalid', 'true');
      if (errorEl) {
        if (!errorEl.id && input.id) errorEl.id = input.id + '-error';
        if (errorEl.id) input.setAttribute('aria-describedby', errorEl.id);
        errorEl.textContent = message;
        errorEl.hidden = false;
      }
    } else {
      input.removeAttribute('aria-invalid');
      if (errorEl) {
        errorEl.textContent = '';
        errorEl.hidden = true;
      }
    }
  }

  function validateInput(input, kind, options) {
    var required = Boolean(options && options.required);
    var raw = kind === 'password' ? (input?.value ?? '') : (input?.value ?? '');
    var message = errorFor(kind, raw, required);
    setFieldError(input, message);
    return !message;
  }

  function bindField(input, kind, options) {
    if (!input || input.dataset.dfBound === 'true') return;
    input.dataset.dfBound = 'true';
    input.addEventListener('blur', function () {
      validateInput(input, kind, options);
    });
  }

  function validatePin(value, required) {
    return errorFor('pin', value, required !== false);
  }

  global.DentaFlowValidators = {
    MESSAGES: MESSAGES,
    errorFor: errorFor,
    setFieldError: setFieldError,
    validateInput: validateInput,
    bindField: bindField,
    validatePin: validatePin,
    compactPhone: compactPhone,
  };
})(window);
