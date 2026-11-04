import { cameraLayout, cameraPage } from './camera-layout.js';

const pinIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l-1 6 4 4v2H6v-2l4-4zM12 15v6"/></svg>';
const arrow = direction => '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + (direction < 0 ? 'm14 6-6 6 6 6' : 'm10 6 6 6-6 6') + '"/></svg>';

export function createCameraGallery(box) {
  const doc = box.ownerDocument;
  let tiles = new Map(), pins = [], page = 0, view = cameraPage([]);
  let width = 0, height = 0;
  const nav = doc.createElement('div');
  nav.className = 'camera-pages';
  nav.setAttribute('role', 'group');
  nav.setAttribute('aria-label', 'Camera pages');
  const previous = doc.createElement('button'), next = doc.createElement('button');
  const status = doc.createElement('span');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  for (const [button, direction, label] of [[previous, -1, 'Previous cameras'], [next, 1, 'Next cameras']]) {
    button.type = 'button'; button.className = 'camera-page';
    button.setAttribute('aria-label', label); button.title = label;
    button.innerHTML = arrow(direction);
    button.addEventListener('click', () => { page += direction; render(); });
  }
  nav.append(previous, status, next); box.append(nav);
  box.addEventListener('click', event => event.stopPropagation());
  box.addEventListener('dblclick', event => event.stopPropagation());
  box.addEventListener('pointerdown', event => event.stopPropagation());

  function render() {
    view = cameraPage([...tiles.keys()], pins, page);
    pins = view.pins; page = view.page;
    box.classList.toggle('has-cameras', view.total > 0);
    box.style.setProperty('--camera-slots', view.slots || 1);
    const visible = new Map(view.entries.map(entry => [entry.id, entry]));
    for (const [id, tile] of tiles) {
      const entry = visible.get(id), button = tile.el.querySelector('.camera-pin');
      tile.el.hidden = !entry;
      if (!entry) continue;
      tile.el.style.order = entry.slot;
      tile.el.style.gridColumn = view.slots - entry.slot;
      tile.el.style.gridRow = 1;
      tile.el.classList.toggle('pinned', entry.pinned);
      const label = (entry.pinned ? 'Unpin ' : 'Pin ') + (tile.name || 'participant') + ' camera';
      button.setAttribute('aria-label', label); button.title = label;
      button.setAttribute('aria-pressed', String(entry.pinned));
    }
    const layout = cameraLayout(width, height, view.entries, view.slots);
    for (const tile of layout) Object.assign(tiles.get(tile.id).el.style, {
      width: tile.width + 'px', height: tile.height + 'px', left: tile.x + 'px', top: tile.y + 'px',
    });
    nav.hidden = view.total <= 4;
    previous.disabled = page === 0;
    next.disabled = page >= view.pages - 1;
    status.textContent = view.locked ? 'Unpin to browse' : (page + 1) + ' / ' + view.pages;
    if (layout.length) {
      nav.style.top = (layout[0].y + layout[0].height + 8) + 'px';
      nav.style.right = Math.min(12, width / 12) + 'px';
    }
  }

  return {
    sync(nextTiles) {
      tiles = nextTiles;
      for (const [id, tile] of tiles) {
        if (tile.el.querySelector('.camera-pin')) continue;
        const button = doc.createElement('button');
        button.type = 'button'; button.className = 'camera-pin'; button.innerHTML = pinIcon;
        button.addEventListener('click', () => {
          const entry = view.entries.find(item => item.id === id);
          if (!entry) return;
          pins[entry.slot] = entry.pinned ? null : id;
          render();
        });
        tile.el.append(button);
      }
      render();
    },
    layout(w, h) { width = w; height = h; render(); },
  };
}
