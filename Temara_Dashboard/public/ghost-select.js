/**
 * Shared ghost-select (custom dropdown) with keyboard navigation.
 */
(function () {
  'use strict';

  const instances = new WeakMap();

  function resolveEl(value) {
    if (!value) return null;
    if (value instanceof Element) return value;
    return document.getElementById(String(value));
  }

  function collectOptions(list) {
    return Array.from(list.querySelectorAll('.ghost-select__option'));
  }

  function initGhostSelect(config) {
    const root = resolveEl(config.root || config.rootId);
    const hidden = resolveEl(config.hidden || config.hiddenId);
    const trigger = resolveEl(config.trigger || config.triggerId);
    const list = resolveEl(config.list || config.listId);
    const label = resolveEl(config.label || config.labelId);
    if (!root || !hidden || !trigger || !list) return null;

    const existing = instances.get(root);
    if (existing) {
      existing.refresh(config);
      return existing;
    }
    if (config.once && root.dataset.ghostSelectBound === 'true') return null;
    root.dataset.ghostSelectBound = 'true';

    const state = {
      defaultValue: config.defaultValue != null ? String(config.defaultValue) : '',
      onSelect: config.onSelect,
      options: collectOptions(list),
    };

    function optionLabel(option, value) {
      if (!option) return value;
      return option.dataset.label || option.textContent.trim() || value;
    }

    function setValue(value, explicitLabel) {
      const resolved = value != null ? String(value) : state.defaultValue;
      hidden.value = resolved;
      const selected = state.options.find((option) => option.dataset.value === resolved);
      if (label) {
        label.textContent = explicitLabel || optionLabel(selected, resolved || 'Choisir');
      }
      state.options.forEach((option) => {
        const isSelected = option.dataset.value === resolved;
        option.classList.toggle('is-selected', isSelected);
        option.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      });
    }

    function closeList() {
      list.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      state.options.forEach((option) => option.classList.remove('is-focused'));
    }

    function openList() {
      list.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
    }

    function bindOption(option) {
      if (option.dataset.ghostBound === 'true') return;
      option.dataset.ghostBound = 'true';
      option.addEventListener('click', () => {
        const value = option.dataset.value != null ? option.dataset.value : state.defaultValue;
        setValue(value, optionLabel(option, value));
        closeList();
        state.onSelect?.(value, option);
        trigger.focus();
      });
    }

    function refresh(nextConfig) {
      if (nextConfig?.defaultValue != null) state.defaultValue = String(nextConfig.defaultValue);
      if (typeof nextConfig?.onSelect === 'function') state.onSelect = nextConfig.onSelect;
      state.options = collectOptions(list);
      state.options.forEach(bindOption);
      const nextValue = nextConfig?.initialValue != null
        ? nextConfig.initialValue
        : (hidden.value || state.defaultValue);
      setValue(nextValue);
    }

    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (list.hidden) openList();
      else closeList();
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
        const currentIndex = state.options.findIndex((option) => option.classList.contains('is-selected'));
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        const nextIndex = (currentIndex + delta + state.options.length) % state.options.length;
        state.options.forEach((option) => option.classList.remove('is-focused'));
        state.options[nextIndex]?.classList.add('is-focused');
      }
      if (event.key === 'Enter' || event.key === ' ') {
        const focused = state.options.find((option) => option.classList.contains('is-focused'));
        if (focused && !list.hidden) {
          event.preventDefault();
          focused.click();
        }
      }
    });

    const api = { setValue, close: closeList, refresh };
    instances.set(root, api);
    refresh(config);
    return api;
  }

  window.DentaFlowSelect = { init: initGhostSelect };
})();
