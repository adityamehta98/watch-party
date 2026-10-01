// Shows what the extension is doing right now.
const NAMES = { youtube: 'YouTube', netflix: 'Netflix', prime: 'Prime Video', hulu: 'Hulu', peacock: 'Peacock', crunchyroll: 'Crunchyroll', paramount: 'Paramount+', max: 'Max', disney: 'Disney+', appletv: 'Apple TV+' };
const out = document.getElementById('out');
const p = (cls, text) => { const el = document.createElement('p'); if (cls) el.className = cls; el.textContent = text; return el; };
chrome.runtime.sendMessage({ wp: 'popup' }, res => {
  out.textContent = '';
  const parties = (res && res.parties) || [];
  if (!parties.length) {
    out.append(p('ok', 'Installed and ready.'), p('', 'Open your Watch Party page (or reload it if it was already open). When the host picks something from Netflix, Prime Video, Hulu or another service, press "Open" there.'));
    return;
  }
  const linked = parties.find(x => x.linked);
  const watching = parties.find(x => x.watching);
  if (linked) out.append(p('ok', `Synced with your ${NAMES[linked.watching] || 'streaming'} tab.`), p('', 'Play, pause and skips follow the room. Chat pops up on top of the video.'));
  else if (watching) out.append(p('warn', `Connected to the Watch Party. Waiting for a ${NAMES[watching.watching] || 'streaming'} tab.`), p('', 'Press "Open" on the party page, sign in with your own account if asked, and start the video.'));
  else out.append(p('ok', 'Connected to the Watch Party.'), p('', 'Nothing from a streaming service is playing right now. Your own movies and YouTube don\'t need the extension.'));
});
