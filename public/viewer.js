// Full-screen toggle + tap-to-hide-chrome for the /view/ page (a photo or a
// PDF). Progressive enhancement: the button ships `hidden` in view.njk, and
// this is the only thing that ever removes that attribute -- with JS off
// there is no dead control, just the plain (non-fullscreen) page.
//
// `is-immersive` on <body> is the one source of truth for "full screen or
// not" -- see the comment on .is-immersive in styles.css for why the
// Fullscreen API itself is only a best-effort extra on top of that class,
// never a dependency.
(function () {
  'use strict';

  if (!document.body.classList.contains('is-viewer')) return;

  var button = document.querySelector('.viewer__fs');
  var viewer = document.querySelector('.viewer');
  var status = document.querySelector('[data-viewer-status]');
  var chrome = document.querySelectorAll('.topbar, .viewer__bar');
  if (!button || !viewer) return;

  var body = document.body;
  var pdfFrame = document.querySelector('iframe.viewer__pdf');

  var AUTO_HIDE_MS = 3000;
  var TAP_MOVE_PX = 10;
  var TAP_MAX_MS = 500;

  var autoHideTimer = null;
  var pushedHistory = false;

  function announce(text) {
    if (status) status.textContent = text;
  }

  // --- entering / exiting -----------------------------------------------

  function requestNativeFullscreen() {
    var root = document.documentElement;
    var request = root.requestFullscreen || root.webkitRequestFullscreen;
    if (!request) return;
    try {
      var result = request.call(root);
      if (result && typeof result.catch === 'function') result.catch(function () {});
    } catch (err) {
      // Safari on iOS throws synchronously for a non-video element on some
      // versions rather than rejecting a promise; either way, is-immersive
      // has already done the actual work, so there is nothing more to do.
    }
  }

  function exitNativeFullscreen() {
    var exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (!exit) return;
    var el = document.fullscreenElement || document.webkitFullscreenElement;
    if (!el) return;
    try {
      var result = exit.call(document);
      if (result && typeof result.catch === 'function') result.catch(function () {});
    } catch (err) {
      // Nothing more we can do; is-immersive coming off is what matters.
    }
  }

  function enter() {
    if (body.classList.contains('is-immersive')) return;
    body.classList.add('is-immersive');
    body.classList.remove('is-chrome-hidden');
    button.setAttribute('aria-pressed', 'true');
    button.textContent = button.dataset.exit || 'Exit full screen';
    announce('Full screen. Tap the document to hide or show the controls.');

    try {
      history.pushState({ ostrichImmersive: true }, '');
      pushedHistory = true;
    } catch (err) {
      pushedHistory = false;
    }

    requestNativeFullscreen();
    scheduleAutoHide();
  }

  function exit(fromPopstate) {
    if (!body.classList.contains('is-immersive')) return;
    clearTimeout(autoHideTimer);
    body.classList.remove('is-immersive', 'is-chrome-hidden');
    button.setAttribute('aria-pressed', 'false');
    button.textContent = button.dataset.enter || 'Full screen';
    announce('');

    exitNativeFullscreen();

    if (!fromPopstate && pushedHistory) {
      pushedHistory = false;
      history.back();
    } else {
      pushedHistory = false;
    }
  }

  function toggleEnter() {
    if (body.classList.contains('is-immersive')) exit();
    else enter();
  }

  // --- auto-hide / reveal --------------------------------------------------

  function chromeFocused() {
    var active = document.activeElement;
    if (!active) return false;
    for (var i = 0; i < chrome.length; i += 1) {
      if (chrome[i].contains(active)) return true;
    }
    return false;
  }

  function hideChrome() {
    if (!body.classList.contains('is-immersive')) return;
    if (chromeFocused()) return; // never blur a focused control out from under a keyboard user
    body.classList.add('is-chrome-hidden');
  }

  function showChrome() {
    body.classList.remove('is-chrome-hidden');
  }

  function scheduleAutoHide() {
    clearTimeout(autoHideTimer);
    autoHideTimer = setTimeout(hideChrome, AUTO_HIDE_MS);
  }

  function toggleChrome() {
    if (!body.classList.contains('is-immersive')) return;
    clearTimeout(autoHideTimer); // manual reveal is not rescheduled -- predictable beats clever
    if (body.classList.contains('is-chrome-hidden')) showChrome();
    else hideChrome();
  }

  // --- tap detection (pointer events; not gated on pointerType) -----------

  var activePointers = new Set();
  var tapStart = null;

  function isInChrome(target) {
    return !!(target && target.closest && target.closest('a, button, .topbar, .viewer__bar'));
  }

  function onPointerDown(event) {
    activePointers.add(event.pointerId);
    if (activePointers.size > 1) {
      tapStart = null; // a pinch or multi-touch gesture is never a tap
      return;
    }
    if (isInChrome(event.target)) {
      tapStart = null;
      return;
    }
    tapStart = { x: event.clientX, y: event.clientY, t: Date.now(), id: event.pointerId };
  }

  function onPointerUp(event) {
    activePointers.delete(event.pointerId);
    var start = tapStart;
    tapStart = null;
    if (!start || start.id !== event.pointerId) return;
    if (activePointers.size > 0) return;

    var dx = Math.abs(event.clientX - start.x);
    var dy = Math.abs(event.clientY - start.y);
    var dt = Date.now() - start.t;
    if (dx > TAP_MOVE_PX || dy > TAP_MOVE_PX || dt > TAP_MAX_MS) return;

    var selection = window.getSelection ? window.getSelection().toString() : '';
    if (selection !== '') return;

    toggleChrome();
  }

  viewer.addEventListener('pointerdown', onPointerDown);
  viewer.addEventListener('pointerup', onPointerUp);
  viewer.addEventListener('pointercancel', function (event) {
    activePointers.delete(event.pointerId);
    tapStart = null;
  });

  // --- reveal on keyboard use, and Escape ----------------------------------

  document.addEventListener('keydown', function (event) {
    if (!body.classList.contains('is-immersive')) return;
    if (event.key === 'Escape') {
      exit();
      return;
    }
    showChrome();
    scheduleAutoHide();
  });

  document.addEventListener(
    'focusin',
    function (event) {
      if (!isInChrome(event.target)) return;
      showChrome();
      clearTimeout(autoHideTimer); // stays visible for as long as a chrome control holds focus
    },
    true
  );

  // --- the browser's own exit affordances ----------------------------------

  function onFullscreenChange() {
    var stillFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
    if (!stillFullscreen && body.classList.contains('is-immersive')) exit();
  }
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  window.addEventListener('popstate', function () {
    if (body.classList.contains('is-immersive')) exit(true);
  });

  // --- the PDF iframe, which cannot bubble a tap to us ---------------------

  if (pdfFrame) {
    window.addEventListener('message', function (event) {
      if (event.origin !== window.location.origin) return;
      if (event.source !== pdfFrame.contentWindow) return;
      var data = event.data;
      if (!data || data.v !== 1 || data.source !== 'ostrich-pdf') return;

      if (data.type === 'tap') toggleChrome();
      else if (data.type === 'key' && data.key === 'Escape') exit();
    });
  }

  // --- wire up the button ---------------------------------------------------

  button.hidden = false;
  button.addEventListener('click', toggleEnter);

  // A photo that failed to load gets no full-screen control -- there would be
  // nothing to look at.
  var image = document.querySelector('.viewer__image');
  if (image) {
    image.addEventListener('error', function () {
      button.hidden = true;
    });
  }
})();
