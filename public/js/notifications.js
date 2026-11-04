// This UI keeps no persistent browser storage. The host process owns session history.
export function createNotificationCenter(panel, { send, host, id }) {
  const doc = panel.ownerDocument, list = panel.querySelector('[data-notification-list]');
  const clear = panel.querySelector('[data-notification-clear]');
  let entries = [], session = null;
  const pending = new Map();
  const callbacks = new Map();
  clear.hidden = !host;
  clear.addEventListener('click', () => { if (host) send({ type: 'notifications-clear' }); });
  panel.addEventListener('click', event => event.stopPropagation());
  const render = () => {
    if (panel.hidden) return;
    list.replaceChildren();
    if (!entries.length) { const empty = doc.createElement('p'); empty.className = 'fine'; empty.textContent = 'No notifications this session.'; list.appendChild(empty); }
    for (const entry of [...entries].reverse()) {
      const row = doc.createElement('li'), text = doc.createElement('p'), stamp = doc.createElement('time');
      row.className = entry.kind === 'error' ? 'notification-error' : '';
      text.textContent = entry.text; const date = new Date(entry.ts); stamp.dateTime = date.toISOString();
      stamp.textContent = date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      row.append(stamp, text);
      for (const action of callbacks.get(entry.id) || []) {
        const button = doc.createElement('button'); button.type = 'button'; button.className = 'btn sm'; button.textContent = action.label;
        button.addEventListener('click', () => { callbacks.delete(entry.id); action.run(); render(); }); row.appendChild(button);
      }
      list.appendChild(row);
    }
  };
  const add = entry => {
    if (!entry || typeof entry.id !== 'string' || !Number.isFinite(entry.ts) || Math.abs(entry.ts) > 8640000000000000) return;
    pending.delete(entry.id);
    const index = entries.findIndex(item => item.id === entry.id);
    if (index >= 0) entries[index] = entry; else entries.push(entry);
    if (entries.length > 1000) for (const old of entries.splice(0, entries.length - 1000)) { callbacks.delete(old.id); pending.delete(old.id); }
    render();
  };
  return {
    render, add,
    record(text, kind, actions) {
      const entry = { id: id(), ts: Date.now(), text: String(text || '').slice(0, 500), kind };
      if (!entry.text) return null;
      if (actions.length) callbacks.set(entry.id, actions);
      add(entry); pending.set(entry.id, entry); send({ type: 'notification', id: entry.id, text: entry.text, kind }); return entry.id;
    },
    load(history, nextSession) {
      if (session && session !== nextSession) pending.clear();
      session = nextSession; entries = []; callbacks.clear();
      for (const entry of history || []) { pending.delete(entry.id); entries.push(entry); }
      for (const entry of pending.values()) { entries.push(entry); send({ type: 'notification', id: entry.id, text: entry.text, kind: entry.kind }); }
      entries = entries.slice(-1000); render();
    },
    clear() { entries = []; callbacks.clear(); pending.clear(); render(); },
  };
}