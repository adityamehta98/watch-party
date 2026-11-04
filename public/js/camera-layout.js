const RATIO = 9.5 / 16;
export const CAMERA_LIMIT = 4;

// Pins own slots, rather than positions in the paged list.
export function cameraPage(ids, savedPins = [], requestedPage = 0) {
  ids = [...new Set(ids)];
  const slots = Math.min(CAMERA_LIMIT, ids.length);
  const pins = Array(CAMERA_LIMIT).fill(null), deferred = [];
  const seen = new Set();
  savedPins.slice(0, CAMERA_LIMIT).forEach((id, slot) => {
    if (!ids.includes(id) || seen.has(id)) return;
    seen.add(id);
    if (slot < slots) pins[slot] = id;
    else deferred.push(id);
  });
  for (const id of deferred) pins[pins.indexOf(null)] = id;
  const remaining = ids.filter(id => !seen.has(id));
  const open = Array.from({ length: slots }, (_, slot) => slot).filter(slot => !pins[slot]);
  const pages = open.length ? Math.max(1, Math.ceil(remaining.length / open.length)) : 1;
  const page = Math.max(0, Math.min(pages - 1, Math.floor(requestedPage) || 0));
  const entries = pins.flatMap((id, slot) => id ? [{ id, slot, pinned: true }] : []);
  remaining.slice(page * open.length, (page + 1) * open.length).forEach((id, index) => {
    entries.push({ id, slot: open[index], pinned: false });
  });
  return { entries: entries.sort((a, b) => a.slot - b.slot), pins, page, pages, slots,
    total: ids.length, locked: !open.length && remaining.length > 0 };
}

export function cameraLayout(width, height, entries, slots = entries.length) {
  if (!(width > 0 && height > 0) || !slots) return [];
  const margin = Math.min(12, width / 12, height / 12);
  const gap = Math.min(8, width / (slots * 4));
  // Keep the anime controls clear on both narrow and wide screens.
  const top = width < 700 && height > 180 ? 60 : margin;
  const availableW = width - margin * 2 - (width >= 700 ? 300 : 0);
  const tileWidth = Math.max(1, Math.min(width < 700 ? 116 : 184,
    (availableW - gap * (slots - 1)) / slots, (height - top - margin) / RATIO));
  return entries.map(entry => ({ ...entry, width: tileWidth, height: tileWidth * RATIO,
    x: width - margin - tileWidth - entry.slot * (tileWidth + gap), y: top }));
}
