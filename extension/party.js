// Runs on the Watch Party page and passes messages between the page and the extension.
(() => {
  if (window.__wpPartyBridge) return;
  window.__wpPartyBridge = true;
  const version = chrome.runtime.getManifest().version;
  let port = null;
  let lastWatch = null;
  const toPage = m => window.postMessage({ source: 'wp-ext', ...m }, location.origin);
  // A message to the extension's background part. If the extension was reloaded since this page opened,
  // this copy of the bridge is cut off from it: tell the page, which reloads itself to get the new one.
  function ask(msg, timeout = 4000) {
    return new Promise(resolve => {
      let done = false;
      const finish = r => { if (!done) { done = true; resolve(r); } };
      setTimeout(() => finish({ ok: false, error: 'no answer' }), timeout);
      try { chrome.runtime.sendMessage(msg).then(r => finish(r || { ok: true }), e => finish({ ok: false, error: String(e && e.message || e) })); }
      catch (e) { toPage({ type: 'ext-problem', kind: 'stale' }); finish({ ok: false, error: 'stale' }); }
    });
  }

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
      if (m.type === 'theater') {
        ask({ wp: 'theater-open', url: m.url }, 6000).then(r => { if ((!r || !r.ok) && !(r && r.error === 'stale')) toPage({ type: 'ext-problem', kind: 'theater', error: r && r.error }); });
        return;
      }
      if (m.type === 'open-panel') { try { chrome.runtime.sendMessage({ wp: 'open-panel' }).catch(() => {}); } catch { /* reloaded */ } return; }
      if (m.type === 'watch') lastWatch = m;
      if (m.type === 'unwatch') lastWatch = null;
      if (port) try { port.postMessage(m); } catch { /* reconnecting */ }
    });
    toPage({ type: 'hello', version });
    // is the extension's background part running? (if not, nothing it does will work: say so)
    ask({ wp: 'ping' }).then(r => { if ((!r || !r.ok) && !(r && r.error === 'stale')) toPage({ type: 'ext-problem', kind: 'background', error: r && r.error }); });
    // links on the party page that open a new tab (sign-in pages, help): let them through
    document.addEventListener('click', e => {
      const a = e.target && e.target.closest && e.target.closest('a[target="_blank"]');
      if (a && port) try { port.postMessage({ type: 'allow-tab' }); } catch { /* reconnecting */ }
    }, true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
