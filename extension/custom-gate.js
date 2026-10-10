// Runs on every page, but does nothing unless the page sits inside the Watch Party window (the
// extension's "watch here" page). There, the host may have opened a website that isn't one of the
// known services (a "custom site"): ask the extension to add the sync script to this frame.
// On every other page, in every other tab, it stops right here.
(() => {
  if (window.__wpGate) return;
  window.__wpGate = true;
  let chain;
  try { chain = location.ancestorOrigins; } catch { return; }
  let extensionUrl, extensionOrigin;
  try { extensionUrl = chrome.runtime.getURL('/'); extensionOrigin = new URL(extensionUrl).origin; } catch { return; }
  // Safari uses top-level tabs on iPhone/iPad. Ask the background worker whether this tab is the
  // custom site opened by a party; if so it will add the sync and cleanup scripts to this frame.
  if ((!chain || !chain.length) && extensionUrl.startsWith('safari-web-extension:') && window === window.top) {
    try { chrome.runtime.sendMessage({ wp: 'custom-probe' }).then(r => { if (r && r.custom) chrome.runtime.sendMessage({ wp: 'custom-ready' }).catch(() => {}); }); } catch { /* reloaded */ }
    return;
  }
  if (!chain || !chain.length || chain[chain.length - 1] !== extensionOrigin) return;
  // the frame the Watch Party window holds this page in (the custom site, or the party page itself)
  const top = chain.length >= 2 ? chain[chain.length - 2] : location.origin;
  try { chrome.runtime.sendMessage({ wp: 'custom-frame', top }).catch(() => {}); } catch { /* extension was reloaded */ }
})();
