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
  function mediaUrl(value) {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && !u.username && !u.password && !u.port && /^(?:media[0-4]?|i)\.giphy\.com$/.test(u.hostname) && /^\/media\/(?:[A-Za-z0-9._-]+\/){1,3}[A-Za-z0-9._-]+\.(?:gif|webp)$/.test(u.pathname) ? u.href : null;
    } catch { return null; }
  }
  function chatHtml(text) {
    const url = mediaUrl(String(text || '').trim());
    return url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer"><img src="${esc(url)}" alt="GIF from GIPHY" loading="lazy" decoding="async" referrerpolicy="no-referrer" style="display:block;max-width:100%;max-height:160px;width:auto;border-radius:10px;margin:6px 0"><small>GIPHY · open GIF</small></a>` : esc(text);
  }
  function create(container, { load, onPick, giphyKey = () => '', request = url => fetch(url, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: globalThis.AbortSignal?.timeout?.(10000) }).then(async response => { if (!response.ok) throw Error(response.status === 429 ? 'Free GIF search limit reached. Try again later.' : 'GIPHY is unavailable. Check the key or try again later.'); return response.json(); }) }) {
    const doc = container.ownerDocument, root = container.shadowRoot || container.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host{display:block;color:#eef0f4;font:13px/1.35 system-ui,sans-serif;text-align:left;min-width:0}
      *{box-sizing:border-box}button,input,select{font:inherit;color:inherit}button{cursor:pointer}
      .picker{width:100%;min-width:0;padding:2px} .search{display:flex;gap:6px;margin-bottom:8px}
      input{min-width:0;width:100%;background:#101217;border:1px solid #353943;border-radius:9px;padding:9px;outline:none}
      input:focus{border-color:#f5b544}select{max-width:104px;background:#101217;border:1px solid #353943;border-radius:9px;padding:4px}
      nav{display:flex;gap:2px;overflow:auto;scrollbar-width:none;margin-bottom:8px;padding-bottom:3px}
      nav button{flex:0 0 30px;height:32px;border:0;border-radius:7px;background:transparent;font-size:20px}
      nav button[aria-pressed=true]{background:#49391e;box-shadow:inset 0 -2px #f5b544}
      .heading{color:#b4b9c4;font-size:11px;margin:5px 3px 7px}.scroll{max-height:min(230px,36dvh);overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;touch-action:pan-y;scrollbar-width:thin}
      .grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:3px}.emoji{overflow:hidden;font:25px/1 'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif;height:38px;min-width:0;border:0;border-radius:8px;background:transparent;transition:background .12s,transform .12s}
      .emoji:hover,.emoji:focus-visible{background:#ffffff16;transform:scale(1.08);outline:1px solid #f5b544}
      .more{width:100%;border:1px solid #393d48;border-radius:8px;background:#ffffff08;padding:7px;margin-top:8px}.empty{color:#b4b9c4;padding:16px;text-align:center}
      @media(prefers-reduced-motion:reduce){.emoji{transition:none}.emoji:hover{transform:none}}
     .tabs{display:flex;gap:6px;margin-bottom:8px}.tabs button,.gif-search button{border:1px solid #393d48;border-radius:8px;background:#ffffff08;padding:7px 12px}.tabs button[aria-pressed=true]{background:#49391e;color:#ffc44f;border-color:#9b742a}.gif-search{display:flex;gap:6px}.gif-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:8px;max-height:min(240px,36dvh);overflow:auto}.gif-grid button{border:1px solid #393d48;background:#101217;border-radius:8px;padding:3px;min-width:0}.gif-grid img{display:block;width:100%;height:100px;object-fit:contain}.credit{font-size:11px;color:#b4b9c4;margin:8px 0 0}.credit a{color:#e8bf6a}.credit img{display:block;width:140px;height:auto;margin-bottom:5px}.status{font-size:12px;color:#b4b9c4;margin-top:8px}
    </style><div class="tabs" aria-label="Chat media"><button type="button" data-mode="emoji" aria-pressed="true">😀 Emoji</button><button type="button" data-mode="gif" aria-pressed="false">GIFs</button></div><section class="gifs" hidden><div class="gif-search"><input type="search" maxlength="50" placeholder="Search GIPHY" aria-label="Search GIPHY"><button type="button" class="find">Search</button></div><div class="status" role="status"></div><div class="gif-grid"></div><p class="credit"><a href="https://giphy.com/" target="_blank" rel="noopener noreferrer"><img src="data:image/png;base64,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" alt="Powered by GIPHY"></a> · free key: 100 calls/hour</p></section><div class="picker"><div class="search"><input type="search" placeholder="Search emoji" aria-label="Search emoji" autocomplete="off"><select aria-label="Emoji skin tone"><option value="default">Default tone</option><option value="all">All tones</option><option value="🏻">Light</option><option value="🏼">Medium-light</option><option value="🏽">Medium</option><option value="🏾">Medium-dark</option><option value="🏿">Dark</option></select></div><nav aria-label="Emoji categories"></nav><div class="heading"></div><div class="scroll"><div class="grid"></div><button class="more" type="button" hidden>Show more</button></div></div>`;
    const input = root.querySelector('.picker input'), tone = root.querySelector('select'), nav = root.querySelector('nav'), grid = root.querySelector('.grid'), heading = root.querySelector('.heading'), more = root.querySelector('.more');
    let catalog = null, group = 0, limit = 140, loading = null, gifBusy = false, gifLoaded = false, gifAttemptKey = null;
    const gifPanel = root.querySelector('.gifs'), gifInput = root.querySelector('.gifs input'), gifGrid = root.querySelector('.gif-grid'), gifStatus = root.querySelector('.status'), gifFind = root.querySelector('.find');
    async function findGifs() {
      if (gifBusy) return;
      const key = String(giphyKey() || ''); gifAttemptKey = key;
      if (!key) { gifStatus.textContent = 'The host can add a free GIPHY API key in Room settings.'; return; }
      gifBusy = true; gifLoaded = false; gifFind.disabled = true; gifStatus.textContent = gifInput.value.trim() ? 'Searching GIPHY…' : 'Loading trending GIFs…'; gifGrid.replaceChildren();
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
        gifStatus.textContent = gifGrid.children.length ? (query ? 'Choose a GIF' : 'Trending GIFs') + ' · choose one, then press Send.' : 'No GIFs found. Try another search.';
      } catch (error) { gifStatus.textContent = error.message || 'GIPHY is unavailable. Try again later.'; }
      finally { gifBusy = false; gifFind.disabled = false; }
    }
    gifFind.addEventListener('click', findGifs);
    gifInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); findGifs(); } });
    for (const button of root.querySelectorAll('[data-mode]')) button.addEventListener('click', () => {
      const gifs = button.dataset.mode === 'gif'; gifPanel.hidden = !gifs; root.querySelector('.picker').hidden = gifs;
      for (const tab of root.querySelectorAll('[data-mode]')) tab.setAttribute('aria-pressed', String(tab === button));
      if (gifs && (!gifLoaded || gifAttemptKey !== String(giphyKey() || ''))) findGifs();
    });
    const draw = () => {
      if (!catalog) return;
      const rows = search(catalog, input.value, group, tone.value);
      heading.textContent = input.value.trim() ? 'Search results' : catalog.groups[group];
      grid.replaceChildren();
      for (const [emoji, label] of rows.slice(0, limit)) {
        const button = doc.createElement('button'); button.type = 'button'; button.className = 'emoji';
        button.textContent = emoji; button.title = label; button.setAttribute('aria-label', label);
        button.addEventListener('click', () => onPick(emoji)); grid.appendChild(button);
      }
      if (!rows.length) { const empty = doc.createElement('span'); empty.className = 'empty'; empty.textContent = 'No matching emoji'; grid.appendChild(empty); }
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
        catalog = data; nav.replaceChildren();
        data.groups.forEach((label, index) => {
          if (!data.emojis.some(row => row[2] === index)) return;
          const button = doc.createElement('button'); button.type = 'button'; button.dataset.group = String(index);
          button.textContent = symbols[index] || '☺'; button.title = label; button.setAttribute('aria-label', label);
          button.addEventListener('click', () => { group = index; input.value = ''; reset(); }); nav.appendChild(button);
        }); draw();
      }).catch(() => { heading.textContent = 'Could not load emoji. Close and reopen to retry.'; }).finally(() => { loading = null; });
      return loading;
    } };
  }
  globalThis.WpEmoji = { create, search, mediaUrl, chatHtml };
})();