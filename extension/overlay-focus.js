// An open chat owns keyboard focus until the viewer explicitly leaves the overlay.
var WpOverlayFocus = {
  create({ host, root, doc = document, target = window, active, close, defer = requestAnimationFrame }) {
    let owned = false, last = null;
    const inside = event => event.composedPath().includes(host);
    const restore = () => {
      if (!owned || !active() || !host.isConnected || !doc.hasFocus()) return;
      if (!root.activeElement) (last?.isConnected && !last.disabled ? last : root.getElementById('input'))?.focus({ preventScroll: true });
    };
    target.addEventListener('pointerdown', event => {
      owned = active() && inside(event);
      if (!owned) last = null;
    }, true);
    target.addEventListener('focusin', event => {
      if (inside(event)) { last = root.activeElement || last; return; }
      // Netflix moves focus to a named player control as it fades; relatedTarget is not
      // evidence of user intent. Only an outside pointer action releases ownership.
      if (owned && active()) { restore(); defer(restore); }
    }, true);
    root.addEventListener('focusout', () => defer(restore));
    target.addEventListener('keydown', event => {
      if (!owned || !active() || !inside(event)) return;
      event.stopImmediatePropagation();
      if (event.key === 'Escape') { owned = false; close(); event.preventDefault(); }
    }, true);
    for (const name of ['keyup', 'keypress']) target.addEventListener(name, event => {
      if (owned && active() && inside(event)) event.stopImmediatePropagation();
    }, true);
    return {
      claim() { owned = true; last = root.getElementById('input'); last?.focus({ preventScroll: true }); },
      release() { owned = false; last = null; },
      restore,
      get owned() { return owned && active(); },
    };
  },
};
