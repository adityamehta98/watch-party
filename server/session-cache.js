'use strict';
const fs = require('fs');
const path = require('path');

// Only Watch Party's generated session data. Never remove a configured media folder,
// downloaded tools, certificates, saved history, or unrelated files in a custom cache.
function clearSessionCache(root) {
  const base = path.resolve(root);
  const generated = /^(?:probe-cache\.json|status\.json|watchparty\.log|anime-subtitle-mappings-v3\.json|subtitles|[0-9a-f]{12}(?:\.json|\.mp4|\.part\.mp4|\.hls(?:\.part)?|\.[^.]+(?:\.part)?\.vtt))$/i;
  let names;
  try { names = fs.readdirSync(base); } catch { return; }
  for (const name of names) {
    if (!generated.test(name)) continue;
    const file = path.resolve(base, name), relative = path.relative(base, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    try { fs.rmSync(file, { recursive: true, force: true }); } catch { /* A locked file is retried on the next close. */ }
  }
}
module.exports = { clearSessionCache };
