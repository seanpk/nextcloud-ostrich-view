// Show/hide toggle for the passphrase field. Progressive enhancement: the
// button ships `hidden` in login.njk, and this is the only thing that ever
// removes that attribute -- with JS off there is no dead control.
(function () {
  'use strict';

  var input = document.getElementById('passphrase');
  var button = document.querySelector('.login__reveal');
  if (!input || !button) return;

  button.hidden = false;

  button.addEventListener('click', function () {
    var revealed = input.type === 'text';
    input.type = revealed ? 'password' : 'text';
    button.setAttribute('aria-pressed', String(!revealed));
    button.textContent = revealed ? 'Show' : 'Hide';
    // Toggling `type` moves focus/caret to the end in some browsers; put it
    // back where she was so a mid-word toggle doesn't send her typing astray.
    var pos = input.selectionStart;
    input.focus();
    if (pos !== null && pos !== undefined) input.setSelectionRange(pos, pos);
  });
})();
