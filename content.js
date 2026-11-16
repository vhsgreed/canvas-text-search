/* Canvas Text Search: UI and indexing. All search logic lives in search-core.js (pure,
   unit tested). This file only talks to the Canvas API, chrome.storage and the DOM. */
(() => {
  const API = '/api/v1';
  const TTL = 6 * 60 * 60 * 1000;
  const C = globalThis.CTS_CORE;
  const courseId = (location.pathname.match(/\/courses\/(\d+)/) || [])[1];
  if (!courseId || document.getElementById('cts-root') || !C) return;

  // Block elements become "\n" so the index keeps the page's paragraph structure. Without
  // this, "</p><p>" glues sentences together and every text-fragment anchor that spans
  // two paragraphs silently fails to match.
  const strip = h => {
    const html = String(h || '')
      .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|table|blockquote|section|article)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n');
    const txt = new DOMParser().parseFromString(html, 'text/html').body.textContent || '';
    return txt.replace(/[ \t\u00a0]+/g, ' ').replace(/\n[ ]*/g, '\n').replace(/\n{2,}/g, '\n').trim();
  };
  const esc = s => (s == null ? '' : String(s)).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function apiAll(path) {
    const out = [];
    let url = `${API}${path}${path.includes('?') ? '&' : '?'}per_page=100`;
    for (let i = 0; i < 30 && url; i++) {
      const r = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      const data = await r.json();
      if (!Array.isArray(data)) return data;
      out.push(...data);
      const m = (r.headers.get('Link') || '').match(/<([^>]+)>;\s*rel="next"/);
      url = m ? m[1] : null;
    }
    return out;
  }

  // ---------------------------------------------------------------- indexing
  async function buildIndex(cid, onProgress) {
    const docs = [];
    // key -> position. A module item creates an empty stub for its assignment/page, and the
    // full document arrives later with the same key; the richer one must win, or rubric text
    // and task descriptions are silently dropped.
    const at = new Map();
    const add = (type, title, body, href, ext, date) => {
      const key = `${type}|${title}|${href}`;
      const doc = { type, title: title || '(utan titel)', body: body || '', href: href || '#',
                    ext: ext || '', date: (date || '').slice(0, 10) };
      const pos = at.get(key);
      if (pos === undefined) { at.set(key, docs.length); docs.push(doc); return; }
      const mine = doc.body.length + doc.date.length;
      const theirs = docs[pos].body.length + docs[pos].date.length;
      if (mine > theirs) docs[pos] = doc;
    };

    onProgress('moduler');
    let modules = [];
    try { modules = await apiAll(`/courses/${cid}/modules?include[]=items`); }
    catch (e) { console.warn('[cts] modules', e); }

    const pageUrls = new Map();
    for (const m of modules) for (const it of (m.items || [])) {
      add('modul', `${m.name}: ${it.title}`, m.name, it.html_url || it.url, '', '');
      // Page items carry the slug in page_url; `url` is a full API URL
      if (it.type === 'Page' && (it.page_url || it.url)) pageUrls.set(it.page_url || it.url, it.url);
      if (it.type === 'Assignment' && it.content_id) add('uppgift', it.title, '', `/courses/${cid}/assignments/${it.content_id}`, '', '');
      if (it.type === 'Discussion' && it.content_id) add('diskussion', it.title, '', `/courses/${cid}/discussion_topics/${it.content_id}`, '', '');
    }

    let n = 0;
    const queue = [...pageUrls.keys()];
    const worker = async () => {
      while (queue.length) {
        const slug = queue.shift();
        onProgress(`sidor ${++n}/${pageUrls.size}`);
        try {
          const p = await apiAll(`/courses/${cid}/pages/${encodeURIComponent(slug)}`);
          add('sida', p.title || slug, strip(p.body), `/courses/${cid}/pages/${slug}`, '', p.updated_at || '');
        } catch (e) { console.warn('[cts] page', slug, e); }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));

    onProgress('uppgifter');
    try {
      // include[]=rubric matters: without it Canvas returns an empty rubric array, and the
      // grading criteria are exactly what students search for
      for (const a of await apiAll(`/courses/${cid}/assignments?include[]=rubric`)) {
        const rub = (a.rubric || []).map(r => `${r.description} ${r.long_description || ''}`).join(' ');
        add('uppgift', a.name, `${strip(a.description)} ${rub}`,
            `/courses/${cid}/assignments/${a.id}`, '', a.updated_at || a.created_at || '');
      }
    } catch (e) { console.warn('[cts] assignments', e); }

    onProgress('diskussioner');
    try {
      for (const d of await apiAll(`/courses/${cid}/discussion_topics`)) {
        add(d.pinned ? 'anvisning' : 'diskussion', d.title, strip(d.message),
            `/courses/${cid}/discussion_topics/${d.id}`, '', d.posted_at || '');
      }
    } catch (e) { console.warn('[cts] discussions', e); }

    onProgress('filer');
    try {
      for (const f of await apiAll(`/courses/${cid}/files`)) {
        const name = f.display_name || f.filename || '';
        add('fil', name, name, f.url, (name.split('.').pop() || '').toLowerCase(), f.updated_at || f.created_at || '');
      }
    } catch (e) { console.warn('[cts] files', e); }

    const indexed = docs.map(d => {
      const f = C.fold(d.title + ' ' + d.body);
      const w = [...new Set(f.split(/[^a-z0-9]+/).filter(x => x.length > 2))];
      return Object.assign({}, d, { f, w });
    });
    return { cid, ts: Date.now(), docs: indexed };
  }

  async function getIndex(cid, force, onProgress) {
    const key = `idx:v3:${cid}`; // v3: rubric text; older caches are ignored
    if (!force) {
      const c = (await chrome.storage.local.get(key))[key];
      if (c && Date.now() - c.ts < TTL) return c;
    }
    const fresh = await buildIndex(cid, onProgress);
    await chrome.storage.local.set({ [key]: fresh });
    return fresh;
  }

  // ---------------------------------------------------------------- UI
  const root = document.createElement('div');
  root.id = 'cts-root';
  root.innerHTML = `
    <button id="cts-btn" title="Sök i kursen (Ctrl+Shift+F)">⌕</button>
    <div id="cts-panel">
      <div id="cts-head">
        <input id="cts-q" placeholder="Sök i kursen…  &quot;fras&quot;  -uteslut  type:sida  intitle:ord  after:2026-09-01">
        <button id="cts-go">Sök</button>
        <button id="cts-re" title="Bygg om index">↻</button>
      </div>
      <div id="cts-opts">
        <label><input type="checkbox" id="cts-case"> Skiftlägeskänslig</label>
        <label><input type="checkbox" id="cts-regex"> Regex</label>
        <label><input type="checkbox" id="cts-fuzzy"> Fuzzy</label>
        <label><input type="checkbox" id="cts-word"> Hela ord</label>
      </div>
      <div id="cts-meta"></div>
      <div id="cts-suggest"></div>
      <ul id="cts-results"></ul>
    </div>`;
  document.body.appendChild(root);

  const panel = root.querySelector('#cts-panel');
  const qEl = root.querySelector('#cts-q');
  const metaEl = root.querySelector('#cts-meta');
  const suggEl = root.querySelector('#cts-suggest');
  const listEl = root.querySelector('#cts-results');
  const meta = msg => { metaEl.textContent = msg; };
  const boxes = {
    caseSensitive: root.querySelector('#cts-case'),
    regex: root.querySelector('#cts-regex'),
    fuzzy: root.querySelector('#cts-fuzzy'),
    wholeWord: root.querySelector('#cts-word'),
  };

  let index = null;
  let opts = { caseSensitive: false, regex: false, fuzzy: false, wholeWord: false };

  chrome.storage.local.get('opts').then(g => {
    if (g && g.opts) {
      opts = Object.assign(opts, g.opts);
      for (const [k, el] of Object.entries(boxes)) el.checked = !!opts[k];
    }
  }).catch(() => {});

  for (const [k, el] of Object.entries(boxes)) {
    el.onchange = () => {
      opts[k] = el.checked;
      chrome.storage.local.set({ opts }).catch(() => {});
      run();
    };
  }

  root.querySelector('#cts-btn').onclick = async () => {
    panel.classList.toggle('open');
    if (!panel.classList.contains('open')) return;
    qEl.focus();
    if (!index) {
      meta('indexerar kursen…');
      try {
        index = await getIndex(courseId, false, meta);
        meta(`${index.docs.length} poster, ${new Date(index.ts).toLocaleTimeString()}`);
      } catch (e) { meta('kunde inte indexera: ' + e.message); }
    }
  };

  root.querySelector('#cts-re').onclick = async () => {
    listEl.innerHTML = '';
    suggEl.innerHTML = '';
    meta('bygger om index…');
    try {
      index = await getIndex(courseId, true, meta);
      meta(`${index.docs.length} poster, ${new Date(index.ts).toLocaleTimeString()}`);
    } catch (e) { meta('kunde inte indexera: ' + e.message); }
  };

  function highlight(text, raw, o) {
    let out = esc(text);
    if (o.regex) {
      try { out = out.replace(new RegExp(raw, o.caseSensitive ? 'g' : 'gi'), m => `<mark>${m || ''}</mark>`); }
      catch { /* reported in the meta line */ }
      return out;
    }
    const terms = C.parseQuery(raw, o).terms
      .filter(t => t.length > 1).map(C.escRx).sort((a, b) => b.length - a.length);
    for (const w of terms) {
      out = out.replace(new RegExp(`(${w})`, o.caseSensitive ? 'g' : 'gi'), '<mark>$1</mark>');
    }
    return out;
  }

  // phrase used for the text fragment: whole words, verified to exist in the document.
  // Returns '' when nothing verifies, which yields a plain link instead of a dead fragment.
  function anchorPhrase(hit, raw, o) {
    return C.anchorTarget(hit, raw, o);
  }

  async function run() {
    if (!index) {
      try { index = await getIndex(courseId, false, meta); }
      catch (e) { return meta('kunde inte indexera: ' + e.message); }
    }
    suggEl.innerHTML = '';
    const raw = qEl.value.trim();
    if (!raw) { listEl.innerHTML = ''; meta(''); qEl.classList.remove('bad'); return; }
    const t0 = performance.now();
    const res = C.search(index, raw, opts);
    const ms = Math.round(performance.now() - t0);
    if (res.error) {
      qEl.classList.add('bad');
      meta(res.error);
      listEl.innerHTML = '';
      return;
    }
    qEl.classList.remove('bad');

    if (!res.total && !opts.fuzzy && !opts.regex) {
      const alt = C.suggest(index, raw, opts);
      if (alt) {
        meta(`0 träffar på "${raw}" i ${index.docs.length} poster`);
        suggEl.innerHTML = `Menade du <a href="#" id="cts-dym">${esc(alt)}</a>?`;
        suggEl.querySelector('#cts-dym').onclick = ev => {
          ev.preventDefault();
          qEl.value = alt;
          opts.fuzzy = true;
          boxes.fuzzy.checked = true;
          run();
        };
        listEl.innerHTML = '';
        return;
      }
    }

    if (res.empty) { meta('skriv något att söka på'); return; }
    meta(`${res.total} träffar på "${raw}" i ${index.docs.length} poster (${ms} ms)`);

    listEl.innerHTML = res.hits.map(h => {
      const href = C.deepLink(h.href, anchorPhrase(h, raw, opts));
      return `
      <li>
        <span class="b">${esc(h.type)}</span>
        <a class="t" href="${esc(href)}" target="_blank" rel="noopener">${highlight(h.title, raw, opts)}</a>
        <div class="s">${highlight(C.snippet(h, h.at), raw, opts)}</div>
      </li>`;
    }).join('');
  }

  let debounce;
  qEl.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(run, 250); });
  qEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') run();
    if (e.key === 'Escape') panel.classList.remove('open');
  });
  root.querySelector('#cts-go').onclick = run;
  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      if (!panel.classList.contains('open')) root.querySelector('#cts-btn').click();
      else { qEl.focus(); qEl.select(); }
    }
  });
})();
