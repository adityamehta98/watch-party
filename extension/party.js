// Runs on the Watch Party page and passes messages between the page and the extension.
(() => {
  if (window.__wpPartyBridge) return;
  window.__wpPartyBridge = true;
  const version = chrome.runtime.getManifest().version;
  let port = null;
  let lastWatch = null;
  const toPage = m => window.postMessage({ source: 'wp-ext', ...m }, location.origin);

  function connect() {
    try { port = chrome.runtime.connect({ name: 'party' }); } catch { port = null; return; }
    port.onMessage.addListener(toPage);
    port.onDisconnect.addListener(() => { port = null; setTimeout(connect, 1000); });
    if (lastWatch) port.postMessage(lastWatch); // the extension restarted: tell it again what we watch
  }

  function start() {
    // only on real Watch Party pages
    if (!document.querySelector('meta[name="watch-party-app"]')) return;
    connect();
    window.addEventListener('message', e => {
      if (e.source !== window || !e.data || e.data.source !== 'wp-page') return;
      const { source, ...m } = e.data;
      if (m.type === 'ping') { toPage({ type: 'hello', version }); return; }
      // straight to the extension while the click still counts (Chrome only opens the panel after a click)
      if (m.type === 'theater') { try { chrome.runtime.sendMessage({ wp: 'theater-open', url: m.url }).catch(() => {}); } catch { /* reloaded */ } return; }
      if (m.type === 'open-panel') { try { chrome.runtime.sendMessage({ wp: 'open-panel' }).catch(() => {}); } catch { /* reloaded */ } return; }
      if (m.type === 'watch') lastWatch = m;
      if (m.type === 'unwatch') lastWatch = null;
      if (port) try { port.postMessage(m); } catch { /* reconnecting */ }
    });
    toPage({ type: 'hello', version });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
