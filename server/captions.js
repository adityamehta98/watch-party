'use strict';

const fs = require('fs');
const path = require('path');
const { serveFile } = require('./media');

// Saved episode captions stay on the host and survive provider outages and restarts.
class CaptionLibrary {
  constructor(root) { this.root = path.resolve(root); }

  tracks(movie) {
    if (movie?.kind !== 'anime' || !Number.isSafeInteger(movie.anilistId) || movie.anilistId < 1 ||
        !Number.isSafeInteger(movie.episode) || movie.episode < 1) return [];
    const audio = movie.language === 'dub' ? 'dub' : 'sub';
    const dir = path.join(this.root, `anime-${movie.anilistId}`, audio);
    let names;
    try { names = fs.readdirSync(dir); } catch { return []; }
    return names.sort().flatMap(name => {
      const match = /^(\d+)\.([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)(\.auto)?\.vtt$/.exec(name);
      if (!match || Number(match[1]) !== movie.episode) return [];
      const lang = match[2];
      let label = lang;
      try { label = new Intl.DisplayNames(['en'], { type: 'language' }).of(lang); } catch {}
      return [{ key: `${match[3] ? 'auto' : 'saved'}-${lang}`, label, lang, local: true, automatic: !!match[3],
        url: `/captions/anime/${movie.anilistId}/${audio}/${name}` }];
    });
  }

  // Only evict files created by automatic lookup; manually saved captions are user data.
  async pruneAutomatic(limit = 20 * 1024 * 1024, reserve = 0) {
    const files = [];
    for (const anime of await fs.promises.readdir(this.root).catch(() => [])) {
      if (!/^anime-\d+$/.test(anime)) continue;
      for (const audio of ['sub', 'dub']) {
        const dir = path.join(this.root, anime, audio);
        for (const name of await fs.promises.readdir(dir).catch(() => [])) {
          if (!/^\d+\.[a-z]{2}\.auto\.vtt$/.test(name)) continue;
          const file = path.join(dir, name);
          const stat = await fs.promises.lstat(file).catch(() => null);
          if (stat?.isFile()) files.push({ file, size: stat.size, at: stat.mtimeMs });
        }
      }
    }
    let size = files.reduce((sum, f) => sum + f.size, 0);
    for (const file of files.sort((a, b) => a.at - b.at)) {
      if (size + reserve <= limit) break;
      await fs.promises.unlink(file.file).catch(() => {});
      size -= file.size;
    }
  }

  fileFor(movie, url) {
    const track = this.tracks(movie).find(track => track.url === url);
    if (!track) return null;
    const audio = movie.language === 'dub' ? 'dub' : 'sub';
    const file = path.join(this.root, `anime-${movie.anilistId}`, audio, path.basename(url));
    try {
      const resolved = fs.realpathSync(file), root = fs.realpathSync(this.root);
      return resolved.startsWith(root + path.sep) && fs.statSync(resolved).isFile() ? resolved : null;
    } catch { return null; }
  }

  serve(req, res, pathname, key, { room, local = false, missing } = {}) {
    const deny = missing || (() => { res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('Not found'); });
    if (!['GET', 'HEAD'].includes(req.method) || !room.roleForKey(key, local)) return deny();
    const file = this.fileFor(room.movie, pathname);
    if (file && /\.auto\.vtt$/.test(file)) fs.promises.utimes(file, new Date(), new Date()).catch(() => {});
    return file ? serveFile(req, res, file) : deny();
  }
}

module.exports = { CaptionLibrary };
