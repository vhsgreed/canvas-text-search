/* Canvas Text Search: UI and indexing. Search logic lives in search-core.js (pure, tested).
   Two modes: one course (/courses/<id>) and the dashboard (/), where every enrolled course
   is indexed and searched at once. When the local unistudy endpoint answers, its document
   text is merged in, labelled, and the page still works when it does not. */
(() => {
  const API = '/api/v1';
  const TTL = 6 * 60 * 60 * 1000;
  const KEY = cid => `idx:v3:${cid}`;
  const C = globalThis.CTS_CORE;
  const courseId = (location.pathname.match(/\/courses\/(\d+)/) || [])[1];
  // '/courses' is the All Courses tree: no course id in the URL, but it is still dashboard mode.
  const dash = !courseId && (location.pathname === '/' || location.pathname === '/courses' ||
                             location.pathname === '/courses/' || location.pathname.startsWith('/dashboard'));
  if (!C || (!courseId && !dash) || document.getElementById('cts-root')) return;

  // Block elements become "\n" so the index keeps paragraph structure: a text-fragment
  // anchor can never cross a block boundary, and "</p><p>" would glue sentences together.
  const strip = h => {
    const html = String(h || '')
      .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|table|blockquote|section|article)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n').replace(/<li[^>]*>/gi, '\n');
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
      if (!Array.isArray(data)) {
        if (data && typeof data === 'object') data.etag = r.headers.get('ETag') || '';
        return data;
      }
      out.push(...data);
      const m = (r.headers.get('Link') || '').match(/<([^>]+)>;\s*rel="next"/);
      url = m ? m[1] : null;
    }
    return out;
  }

  // ---------------------------------------------------------------- indexing
  async function buildIndex(cid, onProgress, prev) {
    const docs = [];
    // Differential reindex: modules carry content_details.updated_at for pages, so an
    // unchanged page body is not fetched again. Everything else is one cheap list call.
    const prevByHref = new Map();
    if (prev) for (const d of (prev.docs || [])) prevByHref.set(d.href, d);
    let reused = 0, fetched = 0;
    // A module item creates an empty stub for its assignment or page; the full document
    // arrives later with the same key, so the richer one must win.
    const at = new Map();
    const add = (type, title, body, href, ext, date, etag) => {
      const key = `${type}|${title}|${href}`;
      const doc = { type, title: title || '(utan titel)', body: body || '', href: href || '#',
                    ext: ext || '', date: (date || '').slice(0, 10), etag: etag || '' };
      const pos = at.get(key);
      if (pos === undefined) { at.set(key, docs.length); docs.push(doc); return; }
      if (doc.body.length + doc.date.length > docs[pos].body.length + docs[pos].date.length) docs[pos] = doc;
    };

    onProgress('moduler');
    let modules = [];
    try {
      modules = await apiAll(`/courses/${cid}/modules?include[]=items&include[]=content_details`);
    } catch (e) {
      try { modules = await apiAll(`/courses/${cid}/modules?include[]=items`); }
      catch (e2) { console.warn('[cts] modules', e2); }
    }
    const pageUrls = new Map();   // slug -> { url, updated }
    for (const m of modules) for (const it of (m.items || [])) {
      add('modul', `${m.name}: ${it.title}`, m.name, it.html_url || it.url, '', '');
      if (it.type === 'Page' && (it.page_url || it.url)) {
        pageUrls.set(it.page_url || it.url, {
          url: it.url,
          updated: ((it.content_details || {}).updated_at || '').slice(0, 10),
        });
      }
      if (it.type === 'Assignment' && it.content_id) add('uppgift', it.title, '', `/courses/${cid}/assignments/${it.content_id}`, '', '');
      if (it.type === 'Discussion' && it.content_id) add('diskussion', it.title, '', `/courses/${cid}/discussion_topics/${it.content_id}`, '', '');
    }

    /* Differential reindex, as far as Canvas allows it. Measured on this account:
       - module items' content_details carry only locked_for_user, no updated_at
       - the pages index (which would list updated_at) is disabled
       - Canvas returns an ETag but ignores If-None-Match, so the body always transfers
       So an unchanged page still costs a request, and the only saving left is parsing:
       when the ETag matches the stored one, the previous text is reused instead of
       stripping 13 kB of HTML and re-tokenising it. */
    let n = 0;
    const queue = [...pageUrls.keys()];
    const total = pageUrls.size;
    const worker = async () => {
      while (queue.length) {
        const slug = queue.shift();
        onProgress(`sidor ${++n}/${total}`);
        const href = `/courses/${cid}/pages/${slug}`;
        const old = prevByHref.get(href);
        try {
          const p = await apiAll(`/courses/${cid}/pages/${encodeURIComponent(slug)}`);
          if (old && p.etag && old.etag && p.etag === old.etag && old.f && old.w) {
            add('sida', old.title, old.body, href, '', old.date, old.etag);
            const reusedDoc = docs[at.get(`sida|${old.title || '(utan titel)'}|${href}`)];
            if (reusedDoc) { reusedDoc.f = old.f; reusedDoc.w = old.w; }
            reused++;
          } else {
            add('sida', p.title || slug, strip(p.body), href, '', p.updated_at || '', p.etag);
            fetched++;
          }
        } catch (e) { console.warn('[cts] page', slug, e); }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    if (reused) onProgress(`sidor: ${reused} oförändrade, ${fetched} hämtade`);

    onProgress('uppgifter');
    try {
      // include[]=rubric matters: without it Canvas returns rubric: [] and the criteria vanish
      for (const a of await apiAll(`/courses/${cid}/assignments?include[]=rubric`)) {
        const rub = (a.rubric || []).map(r => `${r.description} ${r.long_description || ''}`).join(' ');
        add('uppgift', a.name, `${strip(a.description)} ${rub}`,
            `/courses/${cid}/assignments/${a.id}`, '', a.updated_at || a.created_at || '');
      }
    } catch (e) { console.warn('[cts] assignments', e); }

    onProgress('anvisningar');
    try {
      for (const d of await apiAll(`/courses/${cid}/discussion_topics?only_announcements=true`)) {
        add('anvisning', d.title, strip(d.message), `/courses/${cid}/discussion_topics/${d.id}`, '', d.posted_at || '');
      }
      for (const d of await apiAll(`/courses/${cid}/discussion_topics`)) {
        add('diskussion', d.title, strip(d.message), `/courses/${cid}/discussion_topics/${d.id}`, '', d.posted_at || '');
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
      if (d.f && d.w) return d;
      const f = C.fold(d.title + ' ' + d.body);
      return Object.assign({}, d, { f, w: [...new Set(f.split(/[^a-z0-9]+/).filter(x => x.length > 2))] });
    });
    return { cid, ts: Date.now(), docs: indexed, reused, fetched };
  }

  async function getIndex(cid, force, onProgress) {
    const prev = (await chrome.storage.local.get(KEY(cid)))[KEY(cid)];
    if (!force && prev && Date.now() - prev.ts < TTL) return prev;
    const fresh = await buildIndex(cid, onProgress, prev);
    await chrome.storage.local.set({ [KEY(cid)]: fresh });
    return fresh;
  }

  async function storedIndexes() {
    const all = await chrome.storage.local.get(null);
    return Object.entries(all)
      .filter(([k]) => k.startsWith('idx:v3:'))
      .map(([, v]) => v)
      .filter(v => v && Array.isArray(v.docs));
  }

  // ---------------------------------------------------------------- local deep layer
  // The service worker does the request: a page-initiated fetch to loopback or a private
  // address is blocked by Chrome's Local Network Access, even with CORS headers.
  let localWarned = false;
  function localUnavailable(reason) {
    // say so once, instead of looking like a search that silently found nothing
    if (localWarned) return;
    localWarned = true;
    boxes.local.checked = false;
    opts.local = false;
    boxes.local.parentElement.title = `Lokal dokumenttext: ej ansluten (${reason || 'okänd orsak'})`;
    if (metaEl.textContent) metaEl.textContent += ' · lokal ej ansluten';
    if (reason !== 'not connected') return;   // only offer it when the endpoint is simply not granted
    suggEl.innerHTML = '<a href="#" id="cts-connect">Anslut lokal dokumenttext</a>';
    const btn = suggEl.querySelector('#cts-connect');
    if (btn) btn.onclick = async ev => {
      ev.preventDefault();
      try {
        const res = await chrome.runtime.sendMessage({ type: 'connectLocal' });
        if (res && res.ok) { localWarned = false; opts.local = true; boxes.local.checked = true; run(); }
        else meta('anslutningen nekades');
      } catch { meta('kunde inte ansluta'); }
    };
  }

  async function localSearch(q) {
    const cid = courseId || (await coursesCache())[0]?.id;
    if (!cid) return null;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'localSearch', course: cid, q, limit: 10 });
      if (!res || !res.ok) { localUnavailable(res && res.reason); return null; }
      return res.data;
    } catch { localUnavailable('service worker saknas'); return null; }
  }

  let _courses;
  async function coursesCache() {
    if (!_courses) {
      try { _courses = (await apiAll('/courses')).filter(c => !c.access_restricted_by_date); }
      catch { _courses = []; }
    }
    return _courses;
  }

  // ---------------------------------------------------------------- UI
  const root = document.createElement('div');
  root.id = 'cts-root';
  root.innerHTML = `
    <button id="cts-btn" title="Sök i ${dash ? 'alla kurser' : 'kursen'} (Ctrl+Shift+F)">⌕</button>
    <div id="cts-panel">
      <div id="cts-head">
        <input id="cts-q" placeholder="${dash ? 'Sök i alla indexerade kurser…' : 'Sök i kursen…'}  &quot;fras&quot;  -uteslut  type:sida  intitle:ord">
        <button id="cts-go">Sök</button>
        <button id="cts-re" title="${dash ? 'Indexera om alla kurser' : 'Bygg om index'}">↻</button>
      </div>
      <div id="cts-opts">
        <label><input type="checkbox" id="cts-case"> Skiftlägeskänslig</label>
        <label><input type="checkbox" id="cts-regex"> Regex</label>
        <label><input type="checkbox" id="cts-fuzzy"> Fuzzy</label>
        <label><input type="checkbox" id="cts-word"> Hela ord</label>
        <label title="Fråga unistudy på 127.0.0.1:8791 om dokumenttext"><input type="checkbox" id="cts-local" checked> Dokument (lokal)</label>
      </div>
      <div id="cts-tabs">
        <button id="cts-tab-search" class="on">Sök</button>
        <button id="cts-tab-due">Kommande</button>
      </div>
      <div id="cts-meta"></div>
      <div id="cts-suggest"></div>
      <ul id="cts-results"></ul>
      <ul id="cts-due" hidden></ul>
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
    local: root.querySelector('#cts-local'),
  };
  let opts = { caseSensitive: false, regex: false, fuzzy: false, wholeWord: false, local: true };

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

  const idxLine = i => `${i.docs.length} poster${i.reused ? `, ${i.reused} återanvända` : ''}` +
    `${i.fetched ? `, ${i.fetched} hämtade` : ''}, ${new Date(i.ts).toLocaleTimeString()}`;

  async function ensureIndexes(force) {
    const courses = await coursesCache();
    if (!courses.length) { meta('hittar inga kurser'); return false; }
    let i = 0;
    for (const c of courses) {
      i++;
      meta(`indexerar ${c.course_code || c.name} (${i}/${courses.length})`);
      try { await getIndex(c.id, force, m => meta(`${c.course_code || c.name}: ${m}`)); }
      catch (e) { console.warn('[cts] index', c.id, e); }
    }
    const n = (await storedIndexes()).length;
    meta(`${n} kurser indexerade`);
    return true;
  }

  root.querySelector('#cts-btn').onclick = async () => {
    panel.classList.toggle('open');
    if (!panel.classList.contains('open')) return;
    qEl.focus();
    if (dash) {
      if (!(await storedIndexes()).length) await ensureIndexes(false);
      return;
    }
    if (!courseId) return;
    try {
      const idx = await getIndex(courseId, false, meta);
      meta(idxLine(idx));
    } catch (e) { meta('kunde inte indexera: ' + e.message); }
  };

  root.querySelector('#cts-re').onclick = async () => {
    listEl.innerHTML = ''; suggEl.innerHTML = '';
    if (dash) { await ensureIndexes(true); return; }
    meta('bygger om index…');
    try {
      const idx = await getIndex(courseId, true, meta);
      meta(idxLine(idx));
    } catch (e) { meta('kunde inte indexera: ' + e.message); }
  };

  function highlight(text, raw, o) {
    let out = esc(text);
    if (o.regex) {
      try { out = out.replace(new RegExp(raw, o.caseSensitive ? 'g' : 'gi'), m => `<mark>${m || ''}</mark>`); }
      catch { /* reported in the meta line */ }
      return out;
    }
    const terms = C.parseQuery(raw, o).terms.filter(t => t.length > 1)
      .map(C.escRx).sort((a, b) => b.length - a.length);
    for (const w of terms) {
      out = out.replace(new RegExp(`(${w})`, o.caseSensitive ? 'g' : 'gi'), '<mark>$1</mark>');
    }
    return out;
  }

  async function localHitRows(data, raw) {
    if (!data || !data.hits || !data.hits.length) return [];
    return data.hits.map(h => {
      const page = h.page ? `s. ${h.page}` : '';
      return `<li class="loc">
        <span class="b">lokal · ${esc(h.type)}</span> ${page ? `<span class="pg">${page}</span>` : ''}
        <a class="t" href="${esc(h.url)}" target="_blank" rel="noopener">${highlight(h.title, raw, opts)}</a>
        <div class="s">${highlight(h.snippet || '', raw, opts)}</div>
      </li>`;
    });
  }

  async function run() {
    const raw = qEl.value.trim();
    suggEl.innerHTML = '';
    if (!raw) { listEl.innerHTML = ''; meta(''); qEl.classList.remove('bad'); return; }

    let idx;
    if (dash) {
      const stored = await storedIndexes();
      if (!stored.length) { meta('indexera först: tryck ↻'); return; }
      const byCid = new Map();
      for (const s of stored) byCid.set(String(s.cid), s);
      const courses = await coursesCache();
      const label = new Map(courses.map(c => [String(c.id), c.course_code || c.name || c.id]));
      const docs = [];
      for (const s of stored) {
        const tag = label.get(String(s.cid)) || s.cid;
        for (const d of s.docs) docs.push(Object.assign({}, d, { title: `${d.title}`, course: tag }));
      }
      idx = { cid: 'all', docs };
    } else {
      try { idx = await getIndex(courseId, false, meta); }
      catch (e) { return meta('kunde inte indexera: ' + e.message); }
    }

    const t0 = performance.now();
    const res = C.search(idx, raw, opts);
    const ms = Math.round(performance.now() - t0);
    if (res.error) { qEl.classList.add('bad'); meta(res.error); listEl.innerHTML = ''; return; }
    qEl.classList.remove('bad');

    if (!res.total && !opts.fuzzy && !opts.regex) {
      const alt = C.suggest(idx, raw, opts);
      if (alt) {
        meta(`0 träffar på "${raw}" i ${idx.docs.length} poster`);
        suggEl.innerHTML = `Menade du <a href="#" id="cts-dym">${esc(alt)}</a>?`;
        suggEl.querySelector('#cts-dym').onclick = ev => {
          ev.preventDefault(); qEl.value = alt;
          opts.fuzzy = true; boxes.fuzzy.checked = true; run();
        };
        listEl.innerHTML = '';
        return;
      }
    }

    if (res.empty) { meta('skriv något att söka på'); return; }

    const rows = res.hits.map(h => {
      const anchor = C.anchorTarget(h, raw, opts);
      const href = C.deepLink(h.href, anchor);
      const tag = dash && h.course ? `<span class="c">${esc(h.course)}</span>` : '';
      return `<li>${tag}<span class="b">${esc(h.type)}</span>
        <a class="t" href="${esc(href)}" target="_blank" rel="noopener">${highlight(h.title, raw, opts)}</a>
        <div class="s">${highlight(C.snippet(h, h.at), raw, opts)}</div></li>`;
    });

    let localRows = [];
    if (opts.local && !opts.regex) {
      const data = await localSearch(raw);
      localRows = await localHitRows(data, raw);
      if (data && data.total) meta(`${res.total} träffar på "${raw}" i ${idx.docs.length} poster (${ms} ms) + ${data.total} i dokument`);
    }
    if (!localRows.length || !/dokument/.test(metaEl.textContent)) {
      meta(`${res.total} träffar på "${raw}" i ${idx.docs.length} poster (${ms} ms)`);
    }
    listEl.innerHTML = rows.join('') + localRows.join('');
  }

  // ---------------------------------------------------------------- due soon
  const dueEl = root.querySelector('#cts-due');
  const tabSearch = root.querySelector('#cts-tab-search');
  const tabDue = root.querySelector('#cts-tab-due');
  let dueCache = null;   // {ts, items}

  function countdown(iso) {
    if (!iso) return '';
    const ms = new Date(iso) - Date.now();
    const h = Math.round(ms / 36e5);
    if (ms < 0) return `försenad ${Math.max(1, Math.round(-ms / 864e5))} d`;
    if (h < 24) return `${Math.max(1, h)} h`;
    return `${Math.round(h / 24)} d`;
  }

  async function fetchDue() {
    if (dueCache && Date.now() - dueCache.ts < 10 * 60 * 1000) return dueCache.items;
    const today = new Date().toISOString().slice(0, 10);
    const items = [];
    const seen = new Set();
    const push = (title, at, url, kind, course) => {
      if (!title || !at) return;
      const key = `${title}|${at}`;
      if (seen.has(key)) return;
      seen.add(key);
      items.push({ title, at, url, kind, course });
    };
    try {
      for (const it of await apiAll(`/planner/items?start_date=${today}`)) {
        const p = it.plannable || {};
        push(p.title || it.plannable_type, p.due_at || it.plannable_date, it.html_url,
             it.plannable_type, it.context_name);
      }
    } catch (e) { console.warn('[cts] planner', e); }
    for (const c of await coursesCache()) {
      try {
        for (const ev of await apiAll(`/calendar_events?context_codes[]=course_${c.id}&type=event`)) {
          push(ev.title, ev.start_at, `/courses/${c.id}`, 'event', c.course_code || c.name);
        }
      } catch (e) { console.warn('[cts] calendar', c.id, e); }
    }
    items.sort((a, b) => new Date(a.at) - new Date(b.at));
    dueCache = { ts: Date.now(), items };
    return items;
  }

  async function renderDue() {
    dueEl.innerHTML = '<li class="s">hämtar…</li>';
    let items = [];
    try { items = await fetchDue(); }
    catch (e) { dueEl.innerHTML = ''; return meta('kunde inte hämta: ' + e.message); }
    const now = Date.now();
    const soon = items.filter(i => new Date(i.at) >= now).slice(0, 40);
    const late = items.filter(i => new Date(i.at) < now).slice(-5).reverse();
    const row = i => `<li class="${new Date(i.at) < now ? 'late' : ''}">
      <span class="pg">${esc(countdown(i.at))}</span>
      <a class="t" href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a>
      <div class="s">${esc(i.course || '')} · ${new Date(i.at).toLocaleString('sv-SE',
        { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${i.kind === 'event' ? ' · kalender' : ''}</div>
    </li>`;
    dueEl.innerHTML = late.map(row).join('') + soon.map(row).join('');
    meta(`${soon.length} kommande${late.length ? `, ${late.length} försenade` : ''}`);
  }

  function switchTab(which) {
    const isDue = which === 'due';
    tabDue.classList.toggle('on', isDue);
    tabSearch.classList.toggle('on', !isDue);
    dueEl.hidden = !isDue;
    listEl.hidden = isDue;
    qEl.parentElement.style.display = isDue ? 'none' : '';
    root.querySelector('#cts-opts').style.display = isDue ? 'none' : '';
    if (isDue) renderDue(); else meta('');
  }
  tabSearch.onclick = () => switchTab('search');
  tabDue.onclick = () => switchTab('due');

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
