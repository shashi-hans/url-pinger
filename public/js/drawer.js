// Keeps the form drawer in step with HTMX swaps on small screens.
// Separate file because the Content-Security-Policy allows same-origin scripts
// only, no inline script and no inline handlers.
//
// Edit loads the target into the form, which sits inside the drawer, so the
// drawer has to open or the change is invisible. A successful save arrives as
// an out-of-band swap of a blank form, so that closes it again.
(function () {
  'use strict';

  var DESKTOP_QUERY = '(min-width: 1024px)'; // matches Tailwind's lg breakpoint

  function toggle() {
    return document.getElementById('nav-drawer');
  }

  function isDesktop() {
    return window.matchMedia(DESKTOP_QUERY).matches;
  }

  function setOpen(open) {
    var el = toggle();
    // On desktop the drawer is always visible (lg:drawer-open), so the
    // checkbox is left alone.
    if (!el || isDesktop()) return;
    el.checked = open;
  }

  function init() {
    document.body.addEventListener('htmx:afterSwap', function (event) {
      var target = event.detail && event.detail.target;
      if (target && target.id === 'target-form') setOpen(true);
    });

    document.body.addEventListener('htmx:oobAfterSwap', function (event) {
      var target = event.detail && event.detail.target;
      if (target && target.id === 'target-form') setOpen(false);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
