// Shared local Unicode picker for the web room and isolated extension overlays.
(() => {
  if (globalThis.WpEmoji) return;
  const symbols = ['😀', '👋', '◌', '🦊', '🍕', '🚗', '⚽', '💡', '❤️', '🏁'];
  function search(catalog, query = '', group = 0, tone = 'default') {
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const modifiers = /[\u{1f3fb}-\u{1f3ff}]/gu;
    const base = emoji => emoji.replace(modifiers, '').replace(/\ufe0f/g, '');
    const tonedBases = tone === 'default' || tone === 'all' ? null : new Set(catalog.emojis.filter(([emoji]) => (emoji.match(modifiers) || []).every(value => value === tone) && emoji.includes(tone)).map(([emoji]) => base(emoji)));
    return catalog.emojis.filter(([emoji, name, category]) => (!words.length ? group < 0 || category === group : words.every(word => name.toLowerCase().includes(word) || emoji.includes(word)))
      && (tone === 'all' || (tone === 'default' ? !/[\u{1f3fb}-\u{1f3ff}]/u.test(emoji) : emoji.includes(tone) ? (emoji.match(modifiers) || []).every(value => value === tone) : !/[\u{1f3fb}-\u{1f3ff}]/u.test(emoji) && !tonedBases.has(base(emoji)))));
  }
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const glyphCache = new Map(), emojiLabels = new Map();
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  let glyphContext;
  const emojiLike = text => /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u.test(text);
  function nativeEmoji(emoji) {
    if (glyphCache.has(emoji)) return glyphCache.get(emoji);
    // An unsupported hand plus a colored skin-tone swatch is still a missing glyph.
    const base = emoji.replace(/[\u{1f3fb}-\u{1f3ff}]/gu, '');
    if (base !== emoji && !nativeEmoji(base)) return false;
    let supported = false;
    try {
      if (glyphContext === undefined) glyphContext = globalThis.document?.createElement('canvas').getContext?.('2d', { willReadFrequently: true }) || null;
      if (glyphContext) {
        const ctx = glyphContext; ctx.canvas.width = 96; ctx.canvas.height = 64;
        ctx.font = '32px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif'; ctx.fillStyle = '#000';
        if (ctx.measureText(emoji).width <= ctx.measureText('😀').width * 1.6) {
          ctx.fillText(emoji, 0, 40); const pixels = ctx.getImageData(0, 0, 96, 64).data;
          // Missing boxes and unjoined flag letters have no usable color emoji glyph.
          for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] && Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) - Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) > 30) { supported = true; break; }
        }
      }
    } catch { /* A disabled canvas uses the same image fallback. */ }
    if (glyphCache.size >= 4096) glyphCache.clear(); glyphCache.set(emoji, supported); return supported;
  }
  function emojiImage(emoji) {
    const id = Array.from(emoji).map(char => char.codePointAt(0).toString(16).padStart(4, '0')).join('_');
    return 'https://fonts.gstatic.com/s/e/notoemoji/latest/' + id + '/128.png';
  }
  function emojiHtml(emoji, label = emojiLabels.get(emoji) || 'Emoji', size = 24) {
    if (nativeEmoji(emoji)) return esc(emoji);
    return `<img src="${emojiImage(emoji)}" alt="${esc(emoji)}" title="${esc(label)} · Google Noto (CC BY 4.0)" loading="lazy" decoding="async" referrerpolicy="no-referrer" style="display:inline-block;width:${size}px;height:${size}px;vertical-align:-.15em;object-fit:contain">`;
  }
  function mediaUrl(value) {
    try {
      const u = new URL(value);
      const giphy = /^(?:media[0-4]?|i)\.giphy\.com$/.test(u.hostname) && /^\/media\/(?:[A-Za-z0-9._-]+\/){1,3}[A-Za-z0-9._-]+\.(?:gif|webp)$/.test(u.pathname);
      const noto = u.hostname === 'fonts.gstatic.com' && /^\/s\/e\/notoemoji\/latest\/[a-f0-9]{4,6}(?:_[a-f0-9]{4,6})*\/512\.(?:webp|gif)$/.test(u.pathname);
      return u.protocol === 'https:' && !u.username && !u.password && !u.port && (giphy || noto) ? u.href : null;
    } catch { return null; }
  }
  function chatHtml(text) {
    const url = mediaUrl(String(text || '').trim());
    if (url) {
      const google = url.startsWith('https://fonts.gstatic.com/');
      return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${google ? 'Google Noto · CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)' : 'GIF from GIPHY'}"><img src="${esc(url)}" alt="${google ? 'Animated sticker by Google Noto' : 'GIF from GIPHY'}" loading="lazy" decoding="async" referrerpolicy="no-referrer" style="display:block;max-width:100%;max-height:160px;width:auto;border-radius:10px;margin:6px 0"></a>`;
    }
    const value = String(text || '').trim();
    const onlyEmoji = value && Array.from(value).length <= 40 && !value.replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0F\u200D\u20E3\u{e0020}-\u{e007f}\s]/gu, '');
    const size = onlyEmoji ? 32 : 20;
    const parts = segmenter ? Array.from(segmenter.segment(String(text || '')), part => part.segment) : Array.from(String(text || ''));
    const html = parts.map(part => emojiLike(part) ? emojiHtml(part, undefined, size) : esc(part)).join('');
    return onlyEmoji ? `<span style="font-size:32px;line-height:1.3">${html}</span>` : html;
  }
  function createDraft(input) {
    const doc = input.ownerDocument, card = doc.createElement('div'), image = doc.createElement('img'), label = doc.createElement('span'), remove = doc.createElement('button');
    card.setAttribute('aria-label', 'Attachment preview'); card.style.cssText = 'flex:1;min-width:0;align-items:center;gap:10px;padding:6px 8px;border:1px solid #9b742a;border-radius:10px;background:#1c1b17;color:#eef0f4;';
    image.style.cssText = 'width:54px;height:54px;object-fit:contain;border-radius:6px;'; image.referrerPolicy = 'no-referrer';
    label.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;';
    remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Remove attachment'); remove.style.cssText = 'margin-left:auto;flex:none;width:28px;height:28px;border:0;border-radius:50%;background:#ffffff15;color:#fff;cursor:pointer;font-size:20px;';
    card.append(image, label, remove); input.parentNode.insertBefore(card, input);
    let active = null, previousText = '';
    const sync = () => {
      const url = mediaUrl(input.value.trim()); input.hidden = !!url; card.style.display = url ? 'flex' : 'none';
      if (url) { if (active !== url) image.src = url; active = url; const sticker = url.startsWith('https://fonts.gstatic.com/'); image.alt = sticker ? 'Sticker draft' : 'GIF draft'; label.textContent = (sticker ? 'Sticker' : 'GIF') + ' ready to send'; }
      else { active = null; previousText = ''; image.removeAttribute('src'); }
    };
    remove.addEventListener('click', () => { input.value = previousText; sync(); input.focus(); });
    input.addEventListener('input', sync); sync();
    return { sync, pick(value) {
      if (mediaUrl(value)) { if (!active) previousText = input.value; input.value = value; sync(); input.form?.querySelector?.('[type=submit]')?.focus(); }
      else { if (active) input.value = previousText; const start = input.selectionStart ?? input.value.length; input.setRangeText(value, start, input.selectionEnd ?? start, 'end'); sync(); input.focus(); }
    } };
  }
  function create(container, { load, onPick, giphyKey = () => '', request = url => fetch(url, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: globalThis.AbortSignal?.timeout?.(10000) }).then(async response => { if (!response.ok) throw Object.assign(Error(response.status === 429 ? 'Free GIF search limit reached. Try again later.' : 'GIPHY is unavailable. Check the key or try again later.'), { status: response.status }); return response.json(); }) }) {
    const doc = container.ownerDocument, root = container.shadowRoot || container.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host{position:relative;display:block;color:#eef0f4;font:13px/1.35 system-ui,sans-serif;text-align:left;min-width:0}
      *{box-sizing:border-box}button,input,select{font:inherit;color:inherit}button{cursor:pointer}
      .picker{width:100%;min-width:0;padding:2px} .search{display:flex;gap:6px;margin-bottom:8px}
      input{min-width:0;width:100%;background:#101217 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238b929e' stroke-width='1.8'%3E%3Ccircle cx='10.5' cy='10.5' r='6.5'/%3E%3Cpath d='m16 16 4.5 4.5'/%3E%3C/svg%3E") no-repeat 10px center/16px;border:1px solid #353943;border-radius:9px;padding:9px 9px 9px 32px;outline:none}
      input:focus{border-color:#f5b544}select{width:58px;flex:none;background:#101217;border:1px solid #353943;border-radius:9px;padding:4px}
      nav{display:flex;gap:2px;overflow:auto;scrollbar-width:none;margin-bottom:8px;padding-bottom:3px}
      nav button{flex:0 0 30px;height:32px;border:0;border-radius:7px;background:transparent;font-size:20px}
      nav button[aria-pressed=true]{background:#49391e;box-shadow:inset 0 -2px #f5b544}
      .heading{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.scroll{max-height:min(230px,36dvh);overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;touch-action:pan-y;scrollbar-width:thin}
      .grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:3px}.emoji{overflow:hidden;font:25px/1 'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif;height:38px;min-width:0;border:0;border-radius:8px;background:transparent;transition:background .12s,transform .12s}
      .emoji:hover,.emoji:focus-visible{background:#ffffff16;transform:scale(1.08);outline:1px solid #f5b544}
      .more{width:100%;border:1px solid #393d48;border-radius:8px;background:#ffffff08;padding:7px;margin-top:8px}.empty{color:#b4b9c4;padding:16px;grid-column:1/-1;text-align:center}
      @media(prefers-reduced-motion:reduce){.emoji{transition:none}.emoji:hover{transform:none}}
     .tabs{display:flex;gap:6px;margin-bottom:8px}.tabs button,.gif-search button{display:grid;place-items:center;flex:none;width:38px;height:34px;border:1px solid #393d48;border-radius:8px;background:#ffffff08;padding:4px;font-size:21px}.tabs button[aria-pressed=true]{background:#49391e;color:#ffc44f;border-color:#9b742a}.gif-search{display:flex;gap:6px}.gif-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:8px;max-height:min(240px,36dvh);overflow:auto}.gif-grid button{border:1px solid #393d48;background:#101217;border-radius:8px;padding:3px;min-width:0}.gif-grid img{display:block;width:100%;height:100px;object-fit:contain}.gif-heading{position:absolute;right:38px;top:10px;line-height:0}.gif-heading img{display:block;width:96px;height:auto}.status,.sticker-status{font-size:0;line-height:0;margin:0}.status::after,.sticker-status::after{content:attr(data-icon);display:block;text-align:center;font-size:18px;line-height:1.5}
    .artwork-info{position:relative;margin-left:auto;flex:none}.artwork-info summary{list-style:none;display:grid;place-items:center;width:28px;height:32px;cursor:pointer;color:#aeb4bf;border-radius:7px}.artwork-info summary::-webkit-details-marker{display:none}.artwork-info summary:hover,.artwork-info[open] summary{color:#ffc44f;background:#ffffff08}.artwork-info>div{position:absolute;right:0;top:36px;z-index:4;width:220px;padding:10px;background:#171b23;border:1px solid #393d48;border-radius:9px;box-shadow:0 8px 24px #0008;font-size:11px;line-height:1.5}.artwork-info a{color:#e8bf6a}
    .sticker-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;max-height:min(230px,36dvh);overflow:auto;margin-top:8px}.sticker-grid button{min-width:0;border:0;background:#ffffff08;border-radius:8px;padding:5px}.sticker-grid img{display:block;width:100%;height:72px;object-fit:contain}
    </style><div class="tabs" aria-label="Chat media"><button type="button" data-mode="emoji" aria-label="Emoji" title="Emoji" aria-pressed="true">😀</button><button type="button" data-mode="gif" aria-label="GIFs" title="GIFs" aria-pressed="false"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4M10 9l4 3-4 3z"/></svg></button><button type="button" data-mode="sticker" aria-label="Stickers" title="Stickers" aria-pressed="false"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 21H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v8zM14 21v-4a3 3 0 0 1 3-3h4M8 8h.01M14 8h.01M8 12a4 4 0 0 0 6 0"/></svg></button><details class="artwork-info"><summary aria-label="Emoji artwork credits" title="Emoji artwork credits"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 10v7M12 7h.01"/></svg></summary><div>Unmodified emoji artwork by <a href="https://googlefonts.github.io/noto-emoji-files/" target="_blank" rel="noopener noreferrer">Google Noto</a>, licensed under <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>.</div></details></div><section class="gifs" hidden><div class="gif-heading"><a href="https://giphy.com/" target="_blank" rel="noopener noreferrer"><img src="data:image/png;base64,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" alt="Powered by GIPHY"></a></div><div class="gif-search"><input type="search" maxlength="50" aria-label="Search GIPHY"><button type="button" class="find" aria-label="Search GIFs" title="Search GIFs"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg></button></div><div class="status" role="status"></div><div class="gif-grid"></div></section><section class="stickers" hidden><input type="search" aria-label="Search free stickers"><div class="sticker-status" role="status"></div><div class="sticker-grid"></div><button type="button" class="sticker-more more" aria-label="Show more stickers" title="Show more stickers" hidden><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button></section><div class="picker"><div class="search"><input type="search" aria-label="Search emoji" autocomplete="off"><select aria-label="Emoji skin tone" title="Skin tone applies to hands and people; smileys stay yellow"><option value="default" aria-label="Default tone">👋</option><option value="all" aria-label="All tones">🌈</option><option value="🏻" aria-label="Light">👋🏻</option><option value="🏼" aria-label="Medium-light">👋🏼</option><option value="🏽" aria-label="Medium">👋🏽</option><option value="🏾" aria-label="Medium-dark">👋🏾</option><option value="🏿" aria-label="Dark">👋🏿</option></select></div><nav aria-label="Emoji categories"></nav><div class="heading"></div><div class="scroll"><div class="grid"></div><button class="more" type="button" aria-label="Show more emoji" title="Show more emoji" hidden><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button></div></div>`;
    const input = root.querySelector('.picker input'), tone = root.querySelector('select'), nav = root.querySelector('nav'), grid = root.querySelector('.grid'), heading = root.querySelector('.heading'), more = root.querySelector('.more');
    let catalog = null, group = 0, limit = 140, loading = null, gifBusy = false, gifLoaded = false, gifAttemptKey = null, gifBlockedUntil = 0, stickerLimit = 12;
    const gifPanel = root.querySelector('.gifs'), gifInput = root.querySelector('.gifs input'), gifGrid = root.querySelector('.gif-grid'), gifStatus = root.querySelector('.status'), gifFind = root.querySelector('.find');
    const stickerPanel = root.querySelector('.stickers'), stickerInput = root.querySelector('.stickers input'), stickerGrid = root.querySelector('.sticker-grid'), stickerStatus = root.querySelector('.sticker-status'), stickerMore = root.querySelector('.sticker-more');
    const notice = (node, text, icon = '') => { node.textContent = text; node.title = text; node.setAttribute('aria-label', text); node.dataset.icon = icon; };
    function drawStickers() {
      if (!catalog || stickerPanel.hidden) return;
      const rows = search({ emojis: catalog.stickers || [] }, stickerInput.value, -1, 'all'); stickerGrid.replaceChildren();
      for (const [emoji, name, , id] of rows.slice(0, stickerLimit)) {
        const button = doc.createElement('button'), image = doc.createElement('img'), url = 'https://fonts.gstatic.com/s/e/notoemoji/latest/' + id + '/512.webp';
        button.type = 'button'; button.title = name; button.setAttribute('aria-label', name); image.src = url; image.alt = emoji; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer'; button.appendChild(image); button.addEventListener('click', () => onPick(url)); stickerGrid.appendChild(button);
      }
      stickerMore.hidden = rows.length <= stickerLimit;
      if (!rows.length) notice(stickerStatus, 'No matching stickers.', '🔎');
    }
    function activate(mode, message = '') {
      gifPanel.hidden = mode !== 'gif'; root.querySelector('.picker').hidden = mode !== 'emoji'; stickerPanel.hidden = mode !== 'sticker';
      for (const tab of root.querySelectorAll('[data-mode]')) tab.setAttribute('aria-pressed', String(tab.dataset.mode === mode));
      if (mode === 'sticker') { notice(stickerStatus, message, message ? '⚠️' : ''); drawStickers(); }
    }
    stickerInput.addEventListener('input', () => { stickerLimit = 12; notice(stickerStatus, ''); drawStickers(); });
    stickerMore.addEventListener('click', () => { stickerLimit += 12; drawStickers(); });
    async function findGifs() {
      if (gifBusy) return;
      const key = String(giphyKey() || '');
      if (gifAttemptKey !== key) gifBlockedUntil = 0;
      if (gifAttemptKey === key && Date.now() < gifBlockedUntil) { activate('sticker', 'GIPHY search is at its limit. Free stickers are available below.'); return; }
      gifAttemptKey = key;
      if (!key) { notice(gifStatus, 'The host can add a free GIPHY API key in Room settings.', '🔑'); return; }
      gifBusy = true; gifLoaded = false; gifFind.disabled = true; notice(gifStatus, gifInput.value.trim() ? 'Searching GIPHY…' : 'Loading trending GIFs…', '⏳'); gifGrid.replaceChildren();
      const query = gifInput.value.trim(), url = new URL('https://api.giphy.com/v1/gifs/' + (query ? 'search' : 'trending'));
      url.search = new URLSearchParams({ api_key: key, limit: '20', rating: 'pg', ...(query ? { q: query } : {}) });
      try {
        const data = await request(url.href); if (!Array.isArray(data?.data)) throw Error('GIPHY could not return GIFs. Try again later.');
        gifLoaded = true;
        for (const gif of data.data) {
          const preview = mediaUrl(gif.images?.fixed_width_small?.webp || gif.images?.fixed_width_small?.url), full = mediaUrl(gif.images?.fixed_height?.webp || gif.images?.fixed_height?.url);
          if (!preview || !full) continue;
          const button = doc.createElement('button'), image = doc.createElement('img'); button.type = 'button'; button.title = gif.title || 'Add GIF to message'; button.setAttribute('aria-label', button.title);
          image.src = preview; image.alt = gif.title || 'GIF'; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer'; button.appendChild(image);
          button.addEventListener('click', () => onPick(full)); gifGrid.appendChild(button);
        }
        notice(gifStatus, gifGrid.children.length ? (query ? 'Choose a GIF' : 'Trending GIFs') + ' · choose one, then press Send.' : 'No GIFs found. Try another search.', gifGrid.children.length ? '' : '🔎');
      } catch (error) { notice(gifStatus, error.message || 'GIPHY is unavailable. Try again later.', '⚠️'); if (error.status === 429) { gifBlockedUntil = Date.now() + 3600000; activate('sticker', 'GIPHY search is at its limit. Free stickers are available below.'); } }
      finally { gifBusy = false; gifFind.disabled = false; }
    }
    gifFind.addEventListener('click', findGifs);
    gifInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); findGifs(); } });
    for (const button of root.querySelectorAll('[data-mode]')) button.addEventListener('click', () => {
      const mode = button.dataset.mode; activate(mode);
      if (mode === 'gif' && (!gifLoaded || gifAttemptKey !== String(giphyKey() || ''))) findGifs();
    });
    const draw = () => {
      if (!catalog) return;
      const rows = search(catalog, input.value, group, tone.value);
      heading.textContent = input.value.trim() ? 'Search results' : catalog.groups[group];
      grid.replaceChildren();
      for (const [emoji, label] of rows.slice(0, limit)) {
        const button = doc.createElement('button'); button.type = 'button'; button.className = 'emoji';
        button.innerHTML = emojiHtml(emoji, label, 28); button.title = label; button.setAttribute('aria-label', label);
        button.addEventListener('click', () => onPick(emoji)); grid.appendChild(button);
      }
      if (!rows.length) { const empty = doc.createElement('span'); empty.className = 'empty'; empty.textContent = '🔎'; empty.title = 'No matching emoji'; empty.setAttribute('aria-label', empty.title); grid.appendChild(empty); }
      more.hidden = rows.length <= limit;
      for (const button of nav.children) button.setAttribute('aria-pressed', String(Number(button.dataset.group) === group && !input.value.trim()));
    };
    const reset = () => { limit = 140; root.querySelector('.scroll').scrollTop = 0; draw(); };
    input.addEventListener('input', reset); tone.addEventListener('change', reset);
    more.addEventListener('click', () => { limit += 140; draw(); });
    container.addEventListener('click', event => event.stopPropagation());
    return { async open() {
      // A picker can stay on GIFs while settings arrive or the host saves a key.
      // Retry once for a new key, without polling on extension UI refreshes.
      if (!gifPanel.hidden && gifAttemptKey !== String(giphyKey() || '')) { gifInput.value = ''; findGifs(); }
      if (catalog) return;
      if (loading) return loading;
      heading.textContent = 'Loading emoji…';
      loading = Promise.resolve().then(load).then(data => {
        if (!data?.emojis?.length || !Array.isArray(data.groups)) throw Error('Emoji catalog unavailable');
        catalog = data; for (const [emoji, label] of data.emojis) emojiLabels.set(emoji, label); nav.replaceChildren();
        data.groups.forEach((label, index) => {
          if (!data.emojis.some(row => row[2] === index)) return;
          const button = doc.createElement('button'); button.type = 'button'; button.dataset.group = String(index);
          button.textContent = symbols[index] || '☺'; button.title = label; button.setAttribute('aria-label', label);
          button.addEventListener('click', () => { group = index; input.value = ''; reset(); }); nav.appendChild(button);
        }); draw(); drawStickers();
      }).catch(() => { heading.textContent = 'Could not load emoji. Close and reopen to retry.'; }).finally(() => { loading = null; });
      return loading;
    } };
  }
  globalThis.WpEmoji = { create, search, mediaUrl, chatHtml, createDraft, emojiHtml };
})();