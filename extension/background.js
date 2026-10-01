// Watch Party Sync: connects a Watch Party page with a streaming tab (Netflix, Prime Video, ...),
// and shows the party (chat, cameras, people, controls) in Chrome's side panel next to the video.
// It never sees or touches the video stream itself, only play / pause / seek / volume.
importScripts('services.js');

const parties = new Set(); // one entry per open Watch Party page
const docks = new Set();   // one entry per open side panel
const theaterTabs = new Set(); // tabs showing the "watch here" window (party + streaming site side by side)

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
  if (panel !== party.panelOpen) {
    party.panelOpen = panel;
    if (party.link) chrome.tabs.sendMessage(party.link.tabId, { wp: 'dock', open: panel }, { frameId: rootFrame(party) }).catch(() => {});
  }
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
  chrome.tabs.sendMessage(tabId, { wp: 'linked', dockOpen: !!party.panelOpen, theater: !!party.inTheater }, { frameId: rootFrame(party) }).catch(() => {});
  rebindDocks();
}
function unlink(party) {
  if (!party.link) return;
  const tabId = party.link.tabId, frameId = rootFrame(party);
  party.link = null;
  post(party.port, { type: 'unlinked' });
  chrome.tabs.sendMessage(tabId, { wp: 'unlinked' }, { frameId }).catch(() => {});
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
  const party = { port, watch: null, link: null, pendingTab: null, tabId: tab && tab.id, windowId: tab && tab.windowId, ui: null, dockOpen: false, inTheater: false };
  // inside the "watch here" window, the streaming site sits in the same tab
  if (tab && theaterTabs.has(tab.id)) { party.inTheater = true; party.pendingTab = tab.id; }
  parties.add(party);
  // this tab keeps everyone connected while you watch in another tab: don't let Chrome unload it
  if (tab) chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  port.onDisconnect.addListener(() => {
    if (party.link) chrome.tabs.sendMessage(party.link.tabId, { wp: 'unlinked' }, { frameId: rootFrame(party) }).catch(() => {});
    parties.delete(party);
    rebindDocks();
  });
  port.onMessage.addListener(async m => {
    switch (m.type) {
      case 'watch':
        party.watch = { service: m.service, url: m.url };
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
  if (m.wp === 'theater-hello' && sender.tab) {
    // the "watch here" window just opened in this tab
    theaterTabs.add(sender.tab.id);
    updateFrameRules();
    reply({ ok: true });
    return;
  }
  if (m.wp === 'theater-open' && sender.tab) {
    // "Watch here": turn this Watch Party tab into the window with the party and the streaming site side by side
    const url = String(m.url || '');
    if (!/^(https:\/\/[^/]+\/join\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/host\/)/.test(url)) return;
    theaterTabs.add(sender.tab.id);
    updateFrameRules().then(() => chrome.tabs.update(sender.tab.id, { url: chrome.runtime.getURL('theater.html') + '#p=' + encodeURIComponent(url) }));
    return;
  }
  if (m.wp === 'open-panel') {
    // sent right after a click, which is when Chrome allows opening the panel
    openPanel(sender.tab ? sender.tab.windowId : null, sender.tab ? sender.tab.id : null).then(ok => reply({ ok }));
    return true;
  }
  if (!sender.tab) return;
  const tabId = sender.tab.id, frameId = sender.frameId || 0;
  for (const party of parties) {
    if (!party.watch || party.watch.service !== (m.st && m.st.service || m.service)) continue;
    if (m.wp === 'status') {
      const st = m.st;
      if (!party.link) {
        // link the tab we opened, or else the first tab of this service that is playing a video
        if (party.pendingTab == null || party.pendingTab === tabId) link(party, tabId, frameId, st, sender.tab.windowId);
        else continue;
      }
      if (party.link.tabId !== tabId) continue;
      // inside one tab, follow the frame with the biggest video (Crunchyroll plays in an inner frame)
      if (party.link.frameId !== frameId) {
        if ((st.area || 0) > party.link.area * 1.2) party.link.frameId = frameId; else continue;
      }
      party.link.area = st.area || 0;
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
  if (theaterTabs.delete(tabId)) updateFrameRules();
  for (const party of parties) {
    if (party.link && party.link.tabId === tabId) unlink(party);
    if (party.pendingTab === tabId) party.pendingTab = null;
  }
});

// Streaming sites normally refuse to be shown inside another page. Only in the "watch here" window
// (and only for the streaming sites listed in the manifest) the extension lets them load inside it.
// Every other tab and every other website are left exactly as they are.
const FRAME_RULE_ID = 1;
async function updateFrameRules() {
  const tabIds = [...theaterTabs];
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [FRAME_RULE_ID],
      addRules: tabIds.length ? [{
        id: FRAME_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'x-frame-options', operation: 'remove' },
            { header: 'content-security-policy', operation: 'remove' },
          ],
        },
        condition: { tabIds, resourceTypes: ['sub_frame'], requestDomains: WP_SERVICE_DOMAINS },
      }] : [],
    });
  } catch (e) { console.warn('frame rules', e); }
}
// the service worker can restart; rebuild the list from the tabs that are showing the window
chrome.tabs.query({ url: chrome.runtime.getURL('theater.html') + '*' }).then(tabs => { for (const t of tabs) theaterTabs.add(t.id); updateFrameRules(); }).catch(() => {});
