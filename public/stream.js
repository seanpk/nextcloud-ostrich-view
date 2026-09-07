// Land on Today, however the page was opened.
//
// The stream is one time axis with what is coming ABOVE the Today line and the
// history below it, so arriving anywhere else means arriving on next month's
// chores. Every link into it carries `/#today`, and the anchor does the whole
// job -- but only when the fragment is actually there. A bookmark, a
// home-screen icon or a typed address opens plain `/`, and a server redirect
// cannot put the fragment back: browsers never send it, so `Location: /#today`
// against `/` is a loop.
//
// So: progressive enhancement, the same shape as public/viewer.js and
// public/login.js. With JavaScript off, the `/#today` links still work and
// this file simply does not run -- which is what test/e2e/stream.spec.js
// asserts with scripting disabled.
(function () {
  'use strict';

  var today = document.getElementById('today');
  if (!today) return;

  // A reload -- which on a phone means pull-to-refresh, the most natural way
  // there is to ask "anything new?" -- must land on Today as well. Without
  // this the browser helpfully restores the offset she was at, which after a
  // page whose rows have changed is neither where she was nor where she wants
  // to be.
  try {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  } catch (err) {
    // Some privacy modes make this throw. Nothing here depends on it.
  }

  // Any other fragment is a deliberate request for somewhere else; leave it
  // alone. `#today` itself is included because the browser has already put us
  // there -- doing it again is free, and covers the case where the anchor was
  // laid out after the fragment was resolved.
  var hash = window.location.hash;
  if (hash !== '' && hash !== '#today') return;

  // Instant, not smooth: this is where the page begins, not somewhere it
  // travels to, and a scroll animation on load reads as the page running away
  // from her. `scroll-margin-top` on #today (see styles.css) is what keeps the
  // line clear of the fixed top bar.
  today.scrollIntoView({ block: 'start' });
})();
