/**
 * Shared ghost-select (custom dropdown) with keyboard navigation.
 */
(function () {
  'use strict';

  function resolveEl(value) {
    if (!value) return null;
    if (value instanceof Element) return value;
    return document.getElementById(String(value));
  }

  function initGhostSelect(config) {
    const root = resolveEl(config.root || config.rootId);
    const hidden = resolveEl(config.hidden || config.hiddenId);
    const trigger = resolveEl(config.trigger || config.triggerId);
    const list = resolveEl(config.list || config.listId);
    const label = resolveEl(config.label || config.labelId);
    if (!root || !hidden || !trigger || !list) return null;
    if (config.once && root.dataset.ghostSelectBound === 'true') return null;
    root.dataset.ghostSelectBound = 'true';

    const defaultValue = config.defaultValue != null ? String(config.defaultValue) : '';
    const options = Array.from(list.querySelectorAll('.ghost-select__option'));

    function optionLabel(option, value) {
      if (!option) return value;
      return option.dataset.label || option.textContent.trim() || value;
    }

    function setValue(value, explicitLabel) {
      const resolved = value || defaultValue;
      hidden.value = resolved;
      const selected = options.find((option) => option.dataset.value === resolved);
      if (label) {
        label.textContent = explicitLabel || optionLabel(selected, resolved);
      }
      options.forEach((option) => {
        const isSelected = option.dataset.value === resolved;
        option.classList.toggle('is-selected', isSelected);
        option.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      });
    }

    function closeList() {
      list.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      options.forEach((option) => option.classList.remove('is-focused'));
    }

    function openList() {
      list.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
    }

    setValue(config.initialValue != null ? config.initialValue : hidden.value || defaultValue);

    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (list.hidden) openList();
      else closeList();
    });

    options.forEach((option) => {
      option.addEventListener('click', () => {
        const value = option.dataset.value || defaultValue;
        setValue(value, optionLabel(option, value));
        closeList();
        config.onSelect?.(value, option);
        trigger.focus();
      });
    });

    document.addEventListener('click', (event) => {
      if (!root.contains(event.target)) closeList();
    });

    trigger.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeList();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (list.hidden) openList();
        const currentIndex = options.findIndex((option) => option.classList.contains('is-selected'));
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        const nextIndex = (currentIndex + delta + options.length) % options.length;
        options.forEach((option) => option.classList.remove('is-focused'));
        options[nextIndex]?.classList.add('is-focused');
      }
      if (event.key === 'Enter' || event.key === ' ') {
        const focused = options.find((option) => option.classList.contains('is-focused'));
        if (focused && !list.hidden) {
          event.preventDefault();
          focused.click();
        }
      }
    });

    return { setValue, close: closeList };
  }

  window.DentaFlowSelect = { init: initGhostSelect };
})();
