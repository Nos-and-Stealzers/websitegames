/* Wires a "show/hide password" eye button next to a password input.
   Shared by the login and signup pages, and anywhere else a password
   field with a peek toggle is wanted. */
(function () {
  "use strict";

  function wirePasswordToggle(inputId, toggleId) {
    var input = document.getElementById(inputId);
    var toggle = document.getElementById(toggleId);
    if (!input || !toggle) return;

    toggle.addEventListener("click", function () {
      var showing = input.type === "text";
      input.type = showing ? "password" : "text";
      toggle.setAttribute("aria-pressed", String(!showing));
      toggle.setAttribute("aria-label", showing ? "Show password" : "Hide password");
      toggle.textContent = showing ? "👁" : "🙈";
      /* Keep the caret where it was rather than jumping to the end. */
      var pos = input.selectionStart;
      input.focus();
      if (pos != null) { try { input.setSelectionRange(pos, pos); } catch (e) {} }
    });
  }

  window.wirePasswordToggle = wirePasswordToggle;
})();
