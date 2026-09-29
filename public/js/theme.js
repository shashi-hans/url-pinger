// Theme toggle. Lives in its own file because the Content-Security-Policy
// allows same-origin scripts only, no inline script and no inline handlers.
(function () {
  'use strict';

  var STORAGE_KEY = 'url-pinger-theme';
  var DEFAULT_THEME = 'dark';

  function readStored() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      // Private mode or blocked storage. Fall back to the default theme.
      return null;
    }
  }

  function store(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (err) {
      /* the theme still applies for this page view */
    }
  }

  function apply(theme, toggle, label) {
    document.documentElement.setAttribute('data-theme', theme);
    if (toggle) toggle.checked = theme === 'light';
    if (label) label.textContent = theme === 'light' ? 'Light' : 'Dark';
  }

  function init() {
    var toggle = document.getElementById('theme-toggle');
    var label = document.getElementById('theme-label');
    var theme = readStored() === 'light' ? 'light' : DEFAULT_THEME;
    apply(theme, toggle, label);

    if (!toggle) return;
    toggle.addEventListener('change', function () {
      var next = toggle.checked ? 'light' : 'dark';
      apply(next, toggle, label);
      store(next);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
