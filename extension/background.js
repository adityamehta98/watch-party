// Watch Party Sync: connects a Watch Party page with a streaming tab (Netflix, Prime Video, ...),
// and shows the party (chat, cameras, people, controls) in Chrome's side panel next to the video.
// It never sees or touches the video stream itself, only play / pause / seek / volume.
importScripts('services.js', 'ad-domains.js');

const IS_SAFARI = !!self.WP_SAFARI;
const parties = new Set(); // one entry per open Watch Party page
const docks = new Set();   // one entry per open side panel
const theaterTabs = new Set(); // tabs showing the "watch here" window (party + streaming site side by side)
const theaterParty = new Map(); // theater tab -> origin of the Watch Party page inside it
const customHosts = new Map();  // theater tab -> { host, blockPopups } for the custom site it shows
function originOf(url) { try { return new URL(url).origin; } catch { return ''; } }
function customSite(url, partyOrigin, blockPopups) {
  try {
    const u = new URL(String(url || ''));
    if (!/^https?:$/.test(u.protocol) || u.origin === partyOrigin) return null;
    return { host: u.hostname.toLowerCase(), blockPopups: blockPopups !== false };
  } catch { return null; }
}

// clicking the toolbar icon opens the party panel
try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}); } catch { /* older Chrome */ }

function post(port, msg) { try { port.postMessage(msg); } catch { /* closed */ } }

function allowedUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !!wpServiceOf(u.hostname);
  } catch { return false; }
}

// ------------------------------------------------ which party a side panel shows
function partyForDock(dock) {
  const list = [...parties];
  // the bar on top of a player belongs to the party that watches in that very tab
  if (dock.kind === 'player') return list.find(p => (p.link && p.link.tabId === dock.tabId) || p.pendingTab === dock.tabId || p.tabId === dock.tabId) || null;
  return list.find(p => p.link && p.linkWindow === dock.windowId)
    || list.find(p => p.windowId === dock.windowId && p.watch)
    || list.find(p => p.windowId === dock.windowId)
    || list.find(p => p.watch)
    || list[0] || null;
}
function rebindDocks() {
  for (const d of docks) {
    const p = partyForDock(d);
    if (p === d.party) continue;
    if (d.party) setDockOpen(d.party);
    d.party = p;
    if (p) { post(d.port, { type: 'bound', theater: !!p.inTheater }); setDockOpen(p); if (p.ui) post(d.port, { type: 'ui', ui: p.ui }); }
    else post(d.port, { type: 'none' });
  }
}
function docksOf(party) { return [...docks].filter(d => d.party === party); }
function setDockOpen(party) {
  const list = docksOf(party);
  const open = list.length > 0;
  // cameras go to one panel at a time (the newest one)
  const primary = list.includes(party.primary) ? party.primary : (list[list.length - 1] || null);
  if (primary !== party.primary) {
    party.primary = primary;
    if (primary && party.dockOpen) post(party.port, { type: 'dock-rtc', data: { restart: true } });
  }
  const panel = list.some(d => d.kind !== 'player');
  party.panelOpen = panel; // (chat then shows in the panel, not on top of the video)
  if (open === party.dockOpen) return;
  party.dockOpen = open;
  post(party.port, { type: 'dock-state', open });
}
const rootFrame = party => (party.link && party.link.rootFrame != null ? party.link.rootFrame : 0);

// ------------------------------------------------ linking a party page with a streaming tab
function link(party, tabId, frameId, st, windowId) {
  party.link = { tabId, frameId, area: st.area || 0, rootFrame: st.root ? frameId : null };
  party.linkWindow = windowId;
  post(party.port, { type: 'linked', tabId, service: st.service, title: st.title || '', theater: !!party.inTheater });
  rebindDocks();
}
function unlink(party) {
  if (!party.link) return;
  party.link = null;
  post(party.port, { type: 'unlinked' });
  rebindDocks();
}

async function openPanel(windowId, tabId) {
  try {
    if (windowId != null) await chrome.sidePanel.open({ windowId });
    else if (tabId != null) await chrome.sidePanel.open({ tabId });
    return true;
  } catch { return false; } // Chrome only allows this right after a click
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'party') onPartyPort(port);
  else if (port.name === 'dock') onDockPort(port);
});

function onPartyPort(port) {
  const tab = port.sender && port.sender.tab;
  const party = { port, watch: null, link: null, pendingTab: null, tabId: tab && tab.id, frameId: port.sender ? port.sender.frameId : 0, windowId: tab && tab.windowId, ui: null, dockOpen: false, inTheater: false };
  // inside the "watch here" window, the streaming site sits in the same tab
  if (tab && theaterTabs.has(tab.id)) { party.inTheater = true; party.pendingTab = tab.id; }
  parties.add(party);
  // this tab keeps everyone connected while you watch in another tab: don't let Chrome unload it
  if (tab) chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  port.onDisconnect.addListener(() => {
    parties.delete(party);
    rebindDocks();
  });
  port.onMessage.addListener(async m => {
    switch (m.type) {
      case 'watch':
        party.watch = { service: m.service, url: m.url, blockPopups: m.blockPopups !== false };
        if (party.link) post(port, { type: 'linked', tabId: party.link.tabId, service: m.service });
        rebindDocks();
        break;
      case 'unwatch':
        party.watch = null;
        unlink(party);
        break;
      case 'open': {
        if (!allowedUrl(m.url)) return;
        const t = await chrome.tabs.create({ url: m.url, active: true, windowId: party.windowId });
        party.pendingTab = t.id;
        if (party.link && party.link.tabId !== t.id) unlink(party);
        break;
      }
      case 'show': {
        const tabId = party.link ? party.link.tabId : party.pendingTab;
        if (tabId != null) chrome.tabs.update(tabId, { active: true }).catch(() => {});
        break;
      }
      case 'navigate':
        // the host moved on to another title: take this person's streaming tab there too
        if (!allowedUrl(m.url)) return;
        if (party.link) chrome.tabs.update(party.link.tabId, { url: m.url }).catch(() => {});
        else {
          // the tab we opened for them earlier (still on the service's front page, say), or a new one
          let done = false;
          if (party.pendingTab != null) done = await chrome.tabs.update(party.pendingTab, { url: m.url, active: true }).then(() => true).catch(() => false);
          if (!done) { const t = await chrome.tabs.create({ url: m.url, active: true, windowId: party.windowId }); party.pendingTab = t.id; }
        }
        break;
      case 'cmd':
        if (party.link) chrome.tabs.sendMessage(party.link.tabId, { wp: 'cmd', cmd: m.cmd }, { frameId: party.link.frameId }).catch(() => unlink(party));
        break;
      case 'overlay':
        // chat is already on screen in the side panel or the "watch here" window; the video only shows it in fullscreen
        if (party.link) chrome.tabs.sendMessage(party.link.tabId, { wp: 'overlay', item: m.item, dockOpen: !!(party.panelOpen || party.inTheater) }, { frameId: rootFrame(party) }).catch(() => {});
        break;
      case 'allow-tab':
        // the party page itself is opening a tab (a sign-in page, say): not an ad
        party.allowTabUntil = Date.now() + 4000;
        break;
      case 'ui':
        party.ui = m.ui;
        for (const d of docksOf(party)) post(d.port, { type: 'ui', ui: m.ui });
        break;
      case 'ui-time':
        for (const d of docksOf(party)) post(d.port, m);
        break;
      case 'dock-rtc':
        if (party.primary) post(party.primary.port, m);
        break;
      default:
    }
  });
}

function onDockPort(port) {
  const dock = { port, windowId: null, party: null, kind: 'panel', tabId: port.sender && port.sender.tab ? port.sender.tab.id : null };
  docks.add(dock);
  port.onDisconnect.addListener(() => {
    docks.delete(dock);
    if (dock.party) setDockOpen(dock.party);
  });
  port.onMessage.addListener(async m => {
    if (m.type === 'hello') {
      dock.windowId = m.windowId != null ? m.windowId : (port.sender && port.sender.tab ? port.sender.tab.windowId : null);
      if (m.player) dock.kind = 'player';
      dock.party = null;
      rebindDocks();
      if (!dock.party) post(port, { type: 'none' });
      return;
    }
    const party = dock.party;
    if (!party) return;
    if (m.type === 'ui-action') post(party.port, m);
    else if (m.type === 'want-cams') {
      // this dock wants the cameras now (only one gets them at a time)
      if (party.primary !== dock) { party.primary = dock; post(party.port, { type: 'dock-rtc', data: { restart: true } }); }
    }
    else if (m.type === 'dock-rtc') { if (party.primary === dock) post(party.port, m); }
    else if (m.type === 'party-tab' && party.tabId != null) {
      chrome.tabs.update(party.tabId, { active: true }).catch(() => {});
    } else if (m.type === 'show-video' && party.link) {
      chrome.tabs.update(party.link.tabId, { active: true }).catch(() => {});
    } else if (m.type === 'big-screen') {
      try {
        const w = await chrome.windows.get(dock.windowId);
        await chrome.windows.update(dock.windowId, { state: w.state === 'fullscreen' ? 'maximized' : 'fullscreen' });
      } catch { /* ignore */ }
    }
  });
}

// Messages from the streaming tabs and the party pages.
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!m || !m.wp) return;
  if (m.wp === 'ping') { reply({ ok: true }); return; } // the party page checking that this part is running
  if (m.wp === 'theater-hello' && sender.tab) {
    // the "watch here" window opened in this tab, or reminds us it's there (it does every few seconds,
    // since this background part is put to sleep by the browser now and then and forgets)
    const tab = sender.tab.id;
    theaterTabs.add(tab);
    if (m.party) theaterParty.set(tab, originOf(m.party));
    if ('custom' in m) {
      const site = customSite(m.custom, theaterParty.get(tab), m.blockPopups);
      if (site) customHosts.set(tab, site); else customHosts.delete(tab);
    }
    updateFrameRules().then(() => { injectTabFrames(tab); reply({ ok: true }); });
    return true;
  }
  if (m.wp === 'theater-open' && sender.tab) {
    // Safari on iPhone/iPad cannot use Chrome's side panel or a dependable two-frame theater.
    // Keep the party in its own tab and open the player as a normal top-level Safari tab instead.
    const url = String(m.url || '');
    if (!/^(https:\/\/[^/]+\/join\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/host\/)/.test(url)) { reply({ ok: false, error: 'not a Watch Party page' }); return; }
    if (IS_SAFARI) {
      const party = [...parties].find(p => p.tabId === sender.tab.id);
      const custom = party && party.watch && party.watch.service === 'custom';
      const site = custom && customSite(party.watch.url, originOf(url), party.watch.blockPopups);
      if (!party || !party.watch || (!custom && !allowedUrl(party.watch.url)) || (custom && !site)) { reply({ ok: false, error: 'nothing to open' }); return; }
      chrome.tabs.create({ url: site ? 'about:blank' : party.watch.url, active: true, windowId: party.windowId }).then(async t => {
        party.pendingTab = t.id;
        if (party.link && party.link.tabId !== t.id) unlink(party);
        if (site) {
          theaterTabs.add(t.id);
          theaterParty.set(t.id, originOf(url));
          customHosts.set(t.id, site);
          await updateFrameRules();
          await chrome.tabs.update(t.id, { url: party.watch.url });
        }
        reply({ ok: true, safari: true });
      }, e => reply({ ok: false, error: String(e && e.message || e) }));
      return true;
    }
    // Chromium "Watch here": turn this Watch Party tab into the window with the party and service side by side.
    theaterTabs.add(sender.tab.id);
    theaterParty.set(sender.tab.id, originOf(url));
    updateFrameRules()
      .then(() => chrome.tabs.update(sender.tab.id, { url: chrome.runtime.getURL('theater.html') + '#p=' + encodeURIComponent(url) }))
      .then(() => reply({ ok: true }), e => reply({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  if (m.wp === 'frame-allow' && sender.tab && theaterTabs.has(sender.tab.id)) {
    // the Watch Party window is about to show a custom site: let that site load inside it
    if (m.party) theaterParty.set(sender.tab.id, originOf(m.party));
    const party = theaterParty.get(sender.tab.id);
    const site = customSite(m.url, party, m.blockPopups);
    if (site && party) customHosts.set(sender.tab.id, site); else customHosts.delete(sender.tab.id);
    updateFrameRules().then(() => reply({ ok: !!site }));
    return true;
  }
  if (m.wp === 'open-panel') {
    // sent right after a click, which is when Chrome allows opening the panel
    openPanel(sender.tab ? sender.tab.windowId : null, sender.tab ? sender.tab.id : null).then(ok => reply({ ok }));
    return true;
  }
  if (!sender.tab) return;
  const tabId = sender.tab.id, frameId = sender.frameId || 0;
  for (const party of parties) {
    if (!party.watch) continue;
    // a custom site may hold a known player inside it (a YouTube embed, say): in the Watch Party
    // window showing that site, any video counts
    const svc = m.st && m.st.service || m.service;
    const customTab = party.watch.service === 'custom' && ((party.inTheater && party.tabId === tabId) || party.pendingTab === tabId);
    if (party.watch.service !== svc && !customTab) continue;
    if (m.wp === 'status') {
      const st = m.st;
      if (!party.link) {
        // link the tab we opened, or else the first tab of this service that is playing a video
        if (party.pendingTab == null || party.pendingTab === tabId) link(party, tabId, frameId, st, sender.tab.windowId);
        else continue;
      }
      if (party.link.tabId !== tabId) continue;
      // inside one tab, follow the frame with the biggest video (Crunchyroll plays in an inner frame),
      // or a new one once the old one has gone quiet (the page moved on to the next episode, say)
      if (party.link.frameId !== frameId) {
        const quiet = Date.now() - (party.link.at || 0) > 1500;
        if ((st.area || 0) > party.link.area * 1.2 || quiet) party.link.frameId = frameId; else continue;
      }
      party.link.area = st.area || 0;
      party.link.at = Date.now();
      if (st.root) party.link.rootFrame = frameId;
      post(party.port, { type: 'status', st });
    } else if (m.wp === 'page') {
      // the tab this party watches in (linked, or the one we opened / the window it lives in)
      const mine = party.link ? party.link.tabId === tabId : (party.pendingTab == null || party.pendingTab === tabId);
      if (mine) post(party.port, { type: 'page', url: m.url, signin: !!m.signin });
    } else if (m.wp === 'user' && party.link && party.link.tabId === tabId) {
      post(party.port, { type: 'user', action: m.action, t: m.t, land: !!m.land, url: m.url || '', vol: m.vol, muted: m.muted });
    }
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  theaterParty.delete(tabId);
  customHosts.delete(tabId);
  if (theaterTabs.delete(tabId)) updateFrameRules();
  for (const party of parties) {
    if (party.link && party.link.tabId === tabId) unlink(party);
    if (party.pendingTab === tabId) party.pendingTab = null;
  }
});

// ---- content-script injection ------------------------------------------------------------------
// The sync scripts run ONLY in tabs and frames a party is actively using: the "watch here" window,
// a service tab the party opened, or the host's custom site. Pages you browse on your own are never
// touched, so the extension has no effect anywhere outside a live Watch Party.
function partyControlsTab(tabId) {
  if (theaterTabs.has(tabId)) return true;
  for (const party of parties) if (party.watch && ((party.link && party.link.tabId === tabId) || party.pendingTab === tabId)) return true;
  return false;
}
function injectFrame(tabId, frameId, url) {
  let u; try { u = new URL(url); } catch { return; }              // about:blank, data:, extension pages
  if (!/^https?:$/.test(u.protocol)) return;
  if (/^\/(join|host)\/[A-Za-z0-9]+\/?$/.test(u.pathname)) return; // never the Watch Party page itself
  const partyOrigin = theaterParty.get(tabId);
  if (partyOrigin && u.origin === partyOrigin) return;
  const target = { tabId, frameIds: [frameId] };
  if (wpServiceOf(u.hostname)) {
    chrome.scripting.executeScript({ target, files: ['services.js', 'service.js'] })
      .then(() => wpServiceOf(u.hostname) === 'netflix' ? chrome.scripting.executeScript({ target, world: 'MAIN', files: ['netflix-main.js'] }) : null)
      .catch(() => {});
    return;
  }
  if (!customHosts.has(tabId)) return;                            // a custom site, only where the host opened one
  chrome.scripting.executeScript({ target, func: () => { window.__wpCustom = true; } })
    .then(() => chrome.scripting.executeScript({ target, files: ['services.js', 'service.js', 'ad-domains.js', 'custom-clean.js'] }))
    .catch(() => {});
}
// every frame already loaded in a tab (a tab claimed after it loaded, or a woken-up background part);
// the content scripts guard against running twice, so re-injecting is safe
function injectTabFrames(tabId) {
  if (!chrome.webNavigation || !chrome.webNavigation.getAllFrames) return;
  chrome.webNavigation.getAllFrames({ tabId }).then(frames => { for (const f of frames || []) injectFrame(tabId, f.frameId, f.url); }).catch(() => {});
}
// fresh navigations inside a party-controlled tab
if (chrome.webNavigation && chrome.webNavigation.onDOMContentLoaded) {
  chrome.webNavigation.onDOMContentLoaded.addListener(d => { if (partyControlsTab(d.tabId)) injectFrame(d.tabId, d.frameId, d.url); });
}

// Streaming sites normally refuse to be shown inside another page. Only in the "watch here" window
// (and only for the streaming sites listed in the manifest, plus the custom site the host opened
// there) the extension lets them load inside it. Every other tab and website is left exactly as it is.
const FRAME_RULE_ID = 1, CUSTOM_RULE_ID = 2, ADS_RULE_ID = 3;
async function updateFrameRules() {
  const tabIds = [...theaterTabs];
  const strip = { type: 'modifyHeaders', responseHeaders: [{ header: 'x-frame-options', operation: 'remove' }, { header: 'content-security-policy', operation: 'remove' }] };
  const addRules = [];
  if (tabIds.length) addRules.push({ id: FRAME_RULE_ID, priority: 1, action: strip, condition: { tabIds, resourceTypes: ['sub_frame'], requestDomains: WP_SERVICE_DOMAINS } });
  // A window showing a custom site: that site and the pages inside it (players are often on other
  // sites, and sites move between addresses), but never the Watch Party page itself.
  const customTabs = [...customHosts.keys()].filter(t => theaterTabs.has(t));
  if (customTabs.length) {
    const partyHosts = new Set(['localhost', '127.0.0.1']);
    for (const t of customTabs) { try { partyHosts.add(new URL(theaterParty.get(t)).hostname); } catch { /* unknown */ } }
    addRules.push({ id: CUSTOM_RULE_ID, priority: 1, action: strip, condition: { tabIds: customTabs, resourceTypes: ['sub_frame'], excludedRequestDomains: [...partyHosts] } });
    // ad blocker: ad and pop-up networks don't load at all (custom sites only)
    addRules.push({ id: ADS_RULE_ID, priority: 2, action: { type: 'block' }, condition: { tabIds: customTabs, requestDomains: WP_AD_DOMAINS,
      resourceTypes: ['sub_frame', 'script', 'image', 'xmlhttprequest', 'media', 'ping', 'stylesheet', 'font', 'websocket', 'object', 'other'] } });
  }
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [FRAME_RULE_ID, CUSTOM_RULE_ID, ADS_RULE_ID], addRules });
  } catch (e) { console.warn('frame rules', e); }
}
// This background part is put to sleep by the browser after a little while and starts fresh when it's
// needed again. The rules that let the services load in the window outlive it, so pick up from them
// (wiping them here made Netflix & co "refuse to connect" on their next page change).
(async () => {
  try {
    for (const r of await chrome.declarativeNetRequest.getSessionRules()) {
      const tabs = (r.condition && r.condition.tabIds) || [];
      if (r.id === FRAME_RULE_ID) for (const t of tabs) theaterTabs.add(t);
      if (r.id === CUSTOM_RULE_ID) for (const t of tabs) if (!customHosts.has(t)) customHosts.set(t, { host: '', blockPopups: true });
    }
  } catch { /* none yet */ }
  try {
    for (const t of await chrome.tabs.query({ url: chrome.runtime.getURL('theater.html') + '*' })) {
      theaterTabs.add(t.id);
      try { const p = new URLSearchParams(new URL(t.url).hash.slice(1)).get('p'); if (p) theaterParty.set(t.id, originOf(p)); } catch { /* no address */ }
    }
  } catch { /* can't list them: the windows remind us themselves */ }
  for (const t of [...theaterTabs]) {
    try { await chrome.tabs.get(t); } catch { theaterTabs.delete(t); customHosts.delete(t); theaterParty.delete(t); }
  }
  updateFrameRules();
})();

// Pop-ups and pop-unders from a custom site in the Watch Party window: closed the moment they open.
// (Tabs the party itself opens, like a sign-in page, are left alone.)
function closeAdTab(tabId, fromTab, fromFrame, targetUrl) {
  const custom = customHosts.get(fromTab);
  if (!custom || !custom.blockPopups) return;
  const party = [...parties].find(p => p.tabId === fromTab && p.inTheater);
  if (party && (fromFrame === party.frameId || (party.allowTabUntil || 0) > Date.now())) return;
  // Keep a site's own legitimate buttons working. Ordinary same-site links are rewritten into the
  // embedded page by custom-clean.js; if a script still opens one, do not mistake it for an ad.
  let targetHost = '';
  try { targetHost = new URL(String(targetUrl || '')).hostname.toLowerCase(); } catch { /* close unknown targets */ }
  const sameSite = targetHost && custom.host && (targetHost === custom.host || targetHost.endsWith('.' + custom.host) || custom.host.endsWith('.' + targetHost));
  if (sameSite) return;
  // Close it a moment later, not at once: closing a tab while the page's own window.open() call is
  // still waiting for it leaves that page (often the video player) stuck and unresponsive.
  setTimeout(() => {
    chrome.tabs.remove(tabId).catch(() => {});
    chrome.tabs.update(fromTab, { active: true }).catch(() => {}); // straight back to the Watch Party
  }, 400);
}
if (chrome.webNavigation && chrome.webNavigation.onCreatedNavigationTarget) chrome.webNavigation.onCreatedNavigationTarget.addListener(d => closeAdTab(d.tabId, d.sourceTabId, d.sourceFrameId, d.url));
// (and tabs opened any other way: whatever the Watch Party window showing a custom site opens)
// (a new tab you open yourself, Ctrl+T, is the browser's own page and is left alone)
chrome.tabs.onCreated.addListener(t => {
  if (t.openerTabId == null || /^(chrome|brave|edge|chrome-extension):/.test(t.pendingUrl || t.url || '')) return;
  closeAdTab(t.id, t.openerTabId, -1, t.pendingUrl || t.url || '');
});
