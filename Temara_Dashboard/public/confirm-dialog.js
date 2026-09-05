/**
 * DentaFlow OS — confirmation dialog for destructive actions.
 * Usage: const ok = await DentaFlowConfirm.confirmAction(message);
 * Optional callback: DentaFlowConfirm.confirmAction(message, onConfirm);
 */
(function (global) {
  'use strict';

  var TITLE = 'Confirmer l\'action';
  var overlayEl = null;
  var dialogEl = null;
  var messageEl = null;
  var cancelBtn = null;
  var confirmBtn = null;
  var lastFocus = null;
  var activeResolver = null;

  function ensureDialog() {
    if (overlayEl) return;

    overlayEl = document.createElement('div');
    overlayEl.id = 'df-confirm-overlay';
    overlayEl.className = 'df-confirm-overlay';
    overlayEl.hidden = true;

    dialogEl = document.createElement('div');
    dialogEl.className = 'df-confirm-dialog';
    dialogEl.setAttribute('role', 'dialog');
    dialogEl.setAttribute('aria-modal', 'true');
    dialogEl.setAttribute('aria-labelledby', 'df-confirm-title');
    dialogEl.setAttribute('aria-describedby', 'df-confirm-message');

    var titleEl = document.createElement('h2');
    titleEl.id = 'df-confirm-title';
    titleEl.className = 'df-confirm-title';
    titleEl.textContent = TITLE;

    messageEl = document.createElement('p');
    messageEl.id = 'df-confirm-message';
    messageEl.className = 'df-confirm-message';

    var actions = document.createElement('div');
    actions.className = 'df-confirm-actions';

    cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'df-confirm-btn df-confirm-btn--cancel';
    cancelBtn.textContent = 'Annuler';

    confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'df-confirm-btn df-confirm-btn--confirm';
    confirmBtn.textContent = 'Confirmer';

    actions.append(cancelBtn, confirmBtn);
    dialogEl.append(titleEl, messageEl, actions);
    overlayEl.appendChild(dialogEl);
    document.body.appendChild(overlayEl);

    overlayEl.addEventListener('click', function (event) {
      if (event.target === overlayEl) closeDialog(false);
    });
    cancelBtn.addEventListener('click', function () { closeDialog(false); });
    confirmBtn.addEventListener('click', function () { closeDialog(true); });
    overlayEl.addEventListener('keydown', onKeyDown);
  }

  function onKeyDown(event) {
    if (overlayEl.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDialog(false);
      return;
    }
    if (event.key !== 'Tab') return;
    var focusables = [cancelBtn, confirmBtn];
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function closeDialog(confirmed) {
    if (!overlayEl || overlayEl.hidden) return;
    overlayEl.hidden = true;
    overlayEl.classList.remove('is-open');
    if (lastFocus && typeof lastFocus.focus === 'function') {
      lastFocus.focus();
    }
    lastFocus = null;
    var resolve = activeResolver;
    activeResolver = null;
    if (typeof resolve === 'function') resolve(Boolean(confirmed));
  }

  function confirmAction(message, onConfirm) {
    ensureDialog();
    if (activeResolver) closeDialog(false);

    return new Promise(function (resolve) {
      activeResolver = function (ok) {
        if (ok && typeof onConfirm === 'function') onConfirm();
        resolve(ok);
      };
      lastFocus = document.activeElement;
      messageEl.textContent = String(message || '');
      overlayEl.hidden = false;
      overlayEl.classList.add('is-open');
      confirmBtn.focus();
    });
  }

  global.DentaFlowConfirm = {
    confirmAction: confirmAction,
  };
})(window);
