const RATIO = 9.5 / 16;
const overlaps = (a, b) => a.x < b.x + b.width + 4 && a.x + a.width + 4 > b.x
  && a.y < b.y + b.height + 4 && a.y + a.height + 4 > b.y;

export function cameraLayout(width, height, ids, saved = {}) {
  if (!(width > 0 && height > 0) || !ids.length) return [];
  const margin = Math.min(12, width / 12, height / 12), gap = 8;
  const top = height > 180 ? 64 : margin;
  const bottom = height > 180 ? 86 : margin;
  const availableW = width - margin * 2, availableH = height - top - bottom;
  const target = width < 700 ? 116 : 184;
  let best = { width: 0, columns: 1, rows: ids.length };
  for (let columns = 1; columns <= ids.length; columns++) {
    const rows = Math.ceil(ids.length / columns);
    const fit = Math.min(target, (availableW - gap * (columns - 1)) / columns,
      (availableH - gap * (rows - 1)) / rows / RATIO);
    if (fit > best.width) best = { width: fit, columns, rows };
  }
  // Extremely small viewports still keep a valid, non-overlapping grid.
  if (best.width <= 0) {
    return ids.map((id, index) => ({ id, x: index * width / ids.length, y: 0,
      width: width / ids.length, height: Math.min(height, width / ids.length * RATIO) }));
  }
  const grid = ids.map((id, index) => ({ id,
    width: best.width, height: best.width * RATIO,
    x: width - margin - best.width - Math.floor(index / best.rows) * (best.width + gap),
    y: top + (index % best.rows) * (best.width * RATIO + gap) }));
  const placed = grid.map(tile => {
    const value = saved[tile.id];
    // Legacy layouts can contain overlapping positions or unequal stale sizes.
    if (!value?.manual || ![value.x, value.y, value.w].every(Number.isFinite)) return tile;
    const w = Math.max(24, Math.min(width * .6, height / RATIO, value.w * width));
    return { ...tile, width: w, height: w * RATIO,
      x: Math.max(0, Math.min(width - w, value.x * width)),
      y: Math.max(0, Math.min(height - w * RATIO, value.y * height)) };
  });
  // A new participant or resize must not inherit a collision with a saved tile.
  return placed.some((tile, i) => placed.slice(i + 1).some(other => overlaps(tile, other))) ? grid : placed;
}
