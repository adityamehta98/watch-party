// Track the browser document independently of the room's WebSocket connection.
export function trackPlayerWindow(key, { id, target = window, doc = document, request = fetch,
  every = setInterval, cancel = clearInterval, now = Date.now } = {}) {
  let sequence = 0, timer = null, lastActivity = -Infinity, departed = false;
  const send = action => request('/api/player/window', {
    method: 'POST', keepalive: true,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
    body: JSON.stringify({ id, action, sequence: ++sequence }),
  }).catch(() => {});
  const open = () => {
    departed = false;
    send('open');
    cancel(timer);
    timer = every(() => send('open'), 15000);
  };
  const activity = () => {
    if (departed || now() - lastActivity < 10000) return;
    lastActivity = now();
    send('activity');
  };
  target.addEventListener('pagehide', event => {
    // A page in the back/forward cache still owns a window and can come back.
    if (event.persisted) return;
    departed = true;
    cancel(timer);
    send('close');
  });
  target.addEventListener('pageshow', open);
  for (const name of ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel']) {
    doc.addEventListener(name, activity, { passive: true });
  }
  open();
}
