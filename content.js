/* Canvas Text Search: local full-text index of the course you are viewing.
   Uses the browser's existing Canvas session, so no token is stored anywhere.
   Search: plain, Google-style operators, regex, fuzzy, whole word, case sensitive. */
(() => {
  const API = '/api/v1';
  const TTL = 6 * 60 * 60 * 1000; // 6 h
  const courseId = (location.pathname.match(/\/courses\/(\d+)/) || [])[1];
  if (!courseId || document.getElementById('cts-root')) return;

  // ---------------------------------------------------------------- helpers
  const fold = s => (s || '').toString().toLowerCase()
    .replace(/[åä]/g, 'a').replace(/ö/g, 'o').replace(/é/g, 'e');
  const strip = h => new DOMParser().parseFromString(h || '', 'text/html').body.textContent || '';
  const esc = s => (s || '').toString()
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const escRx = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

  // ---------------------------------------------------------------- index
  async function buildIndex(cid, onProgress) {
    const docs = [];
    const seen = new Set();
    const add = (type, title, body, href, ext) => {
      const key = `${type}|${title}|${href}`;
      if (seen.has(key)) return; // module items and list endpoints overlap
      seen.add(key);
      docs.push({ type, title: title || '(utan titel)', body: body || '', href: href || '#',
                  ext: ext || '' });
    };

    onProgress('moduler');
    let modules = [];
    try { modules = await apiAll(`/courses/${cid}/modules?include[]=items`); }
    catch (e) { console.warn('[cts] modules', e); }

    const pageUrls = new Set();
    for (const m of modules) for (const it of (m.items || [])) {
      add('modul', `${m.name}: ${it.title}`, m.name, it.html_url || it.url);
      // Page items carry the slug in page_url; `url` is a full API URL
      if (it.type === 'Page' && (it.page_url || it.url)) pageUrls.add(it.page_url || it.url);
      if (it.type === 'Assignment' && it.content_id) add('uppgift', it.title, '', `/courses/${cid}/assignments/${it.content_id}`);
      if (it.type === 'Discussion' && it.content_id) add('diskussion', it.title, '', `/courses/${cid}/discussion_topics/${it.content_id}`);
    }

    // pages, with a small concurrency pool (Canvas throttles bursty clients)
    let n = 0;
    const queue = [...pageUrls];
    const worker = async () => {
      while (queue.length) {
        const u = queue.shift();
        onProgress(`sidor ${++n}/${pageUrls.size}`);
        try {
          const p = await apiAll(`/courses/${cid}/pages/${encodeURIComponent(u)}`);
          add('sida', p.title || u, strip(p.body), `/courses/${cid}/pages/${u}`);
        } catch (e) { console.warn('[cts] page', u, e); }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));

    onProgress('uppgifter');
    try {
      for (const a of await apiAll(`/courses/${cid}/assignments`)) {
        const rub = (a.rubric || []).map(r => `${r.description} ${r.long_description || ''}`).join(' ');
        add('uppgift', a.name, `${strip(a.description)} ${rub}`, `/courses/${cid}/assignments/${a.id}`);
      }
    } catch (e) { console.warn('[cts] assignments', e); }

    onProgress('diskussioner');
    try {
      for (const d of await apiAll(`/courses/${cid}/discussion_topics`)) {
        add(d.pinned ? 'anvisning' : 'diskussion', d.title, strip(d.message),
            `/courses/${cid}/discussion_topics/${d.id}`);
      }
    } catch (e) { console.warn('[cts] discussions', e); }

    onProgress('filer');
    try {
      for (const f of await apiAll(`/courses/${cid}/files`)) {
        const name = f.display_name || f.filename || '';
        add('fil', name, name, f.url, (name.split('.').pop() || '').toLowerCase());
      }
    } catch (e) { console.warn('[cts] files', e); }

    return { cid, ts: Date.now(), docs: docs.map(d => {
      const f = fold(d.title + ' ' + d.body);
      // word list powers fuzzy matching without rescanning text on every query
      const w = [...new Set(f.split(/[^a-z0-9]+/).filter(x => x.length > 2))];
      return { ...d, f, w };
    }) };
  }

  async function getIndex(cid, force, onProgress) {
    const key = `idx:${cid}`;
    if (!force) {
      const c = (await chrome.storage.local.get(key))[key];
      if (c && Date.now() - c.ts < TTL) return c;
    }
    const fresh = await buildIndex(cid, onProgress);
    await chrome.storage.local.set({ [key]: fresh });
    return fresh;
  }

  // ---------------------------------------------------------------- query
  const TYPES = { sida: 'sida', sidor: 'sida', uppgift: 'uppgift', uppgifter: 'uppgift',
    fil: 'fil', filer: 'fil', modul: 'modul', moduler: 'modul',
    diskussion: 'diskussion', diskussioner: 'diskussion', anvisning: 'anvisning' };

  function parseQuery(raw, opts) {
    const q = { terms: [], not: [], types: [], exts: [], titleTerms: [], error: null, regex: null };
    if (opts.regex) {
      try { q.regex = new RegExp(raw, opts.caseSensitive ? 'g' : 'gi'); }
      catch (e) { q.error = 'Ogiltigt reguljärt uttryck: ' + e.message; }
      return q;
    }
    const toks = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(raw))) toks.push(m[1] !== undefined ? { phrase: m[1] } : { word: m[2] });
    for (const t of toks) {
      const isPhrase = t.phrase !== undefined;
      const s = isPhrase ? t.phrase : t.word;
      if (!isPhrase) {
        const kv = s.match(/^(type|filetype|intitle):(.+)$/i);
        if (kv) {
          const k = kv[1].toLowerCase(), v = kv[2];
          if (k === 'intitle') { q.titleTerms.push(v); continue; }
          if (k === 'filetype') { q.exts.push(v.replace(/^\./, '').toLowerCase()); continue; }
          const mapped = TYPES[v.toLowerCase()];
          if (mapped) { q.types.push(mapped); continue; }
        }
        if (s.startsWith('-') && s.length > 1) { q.not.push(s.slice(1)); continue; }
        if (/^(and|or)$/i.test(s)) continue; // AND is implicit; OR handled per term below
      }
      if (s) q.terms.push(s);
    }
    return q;
  }

  const countPlain = (hay, needle) => {
    let c = 0, i = 0;
    while ((i = hay.indexOf(needle, i)) !== -1) { c++; i += needle.length || 1; }
    return c;
  };

  const countWord = (hay, term) => {
    const rx = new RegExp(`(^|[^a-z0-9])${escRx(term)}([^a-z0-9]|$)`, 'g');
    return [...hay.matchAll(rx)].length;
  };

  // Damerau-Levenshtein with early exit: catches typos, insertions and transpositions
  function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const al = a.length, bl = b.length;
    let prev2 = null, prev = Array.from({ length: bl + 1 }, (_, j) => j);
    for (let i = 1; i <= al; i++) {
      const cur = [i];
      let rowMin = i;
      for (let j = 1; j <= bl; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          v = Math.min(v, prev2[j - 2] + 1); // transposition
        }
        cur[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      prev2 = prev; prev = cur;
    }
    return prev[bl];
  }

  function fuzzyWords(doc, term) {
    const max = term.length <= 5 ? 1 : 2;
    const hits = [];
    for (const w of doc.w || []) {
      if (w === term || w.startsWith(term)) { hits.push(w); continue; }
      if (Math.abs(w.length - term.length) > max) continue;
      if (editDistance(term, w, max) <= max) hits.push(w);
    }
    return hits;
  }

  function makeMatcher(q, opts) {
    const prep = s => (opts.caseSensitive ? (s || '') : fold(s));

    if (q.regex) {
      return doc => {
        const hay = `${doc.title}\n${doc.body}`;
        let hits;
        try { hits = [...hay.matchAll(q.regex)]; } catch { return null; }
        if (!hits.length) return null;
        return { score: hits.length + 5, at: hits[0].index };
      };
    }

    const terms = q.terms.map(t => ({ t: prep(t) }));
    const nots = q.not.map(prep);
    const titleTerms = q.titleTerms.map(prep);

    return doc => {
      if (q.types.length && !q.types.includes(doc.type)) return null;
      if (q.exts.length && !q.exts.includes(doc.ext)) return null;
      const hay = prep(`${doc.title}\n${doc.body}`);
      const title = prep(doc.title);
      if (nots.some(x => hay.includes(x))) return null;
      if (titleTerms.some(x => !title.includes(x))) return null;

      let score = 0, at = -1;
      for (const term of terms) {
        const short = term.t.length <= 3;
        let c, anchor = term.t;
        if (opts.fuzzy) {
          const fw = fuzzyWords(doc, term.t);
          c = fw.length;
          if (fw.length) anchor = fw[0];
        } else if (opts.wholeWord || short) c = countWord(hay, term.t);
        else c = countPlain(hay, term.t);
        if (!c) return null;
        if (at < 0) {
          const pos = hay.indexOf(anchor);
          at = pos < 0 ? 0 : pos;
        }
        score += (title.includes(anchor) ? 12 : 0) + Math.min(c, 6);
      }
      if (doc.type === 'anvisning' || doc.type === 'sida') score += 3;
      return { score, at };
    };
  }

  // Google-style OR between terms, quoted phrases kept intact
  function splitOr(raw) {
    const parts = raw.split(/\s+OR\s+/i);
    return parts.length > 1 ? parts : [raw];
  }

  function search(idx, raw, opts) {
    const alts = opts.regex ? [raw] : splitOr(raw);
    const found = new Map();
    let lastQ = null;
    for (const alt of alts) {
      const q = parseQuery(alt, opts);
      lastQ = q;
      if (q.error) return { error: q.error, hits: [] };
      if (!q.terms.length && !q.regex && !q.titleTerms.length && !q.types.length && !q.exts.length) continue;
      const match = makeMatcher(q, opts);
      for (const d of idx.docs) {
        const r = match(d);
        if (!r) continue;
        const prev = found.get(d.href + d.title);
        if (!prev || r.score > prev.score) {
          found.set(d.href + d.title, { ...d, score: r.score + (alts.length > 1 ? 0 : 0), at: r.at });
        }
      }
    }
    if (!found.size) {
      const q = lastQ || parseQuery(raw, opts);
      if (!q.terms.length && !q.regex && !q.titleTerms.length && !q.types.length && !q.exts.length) {
        return { hits: [], empty: true };
      }
    }
    const hits = [...found.values()].sort((a, b) => b.score - a.score);
    return { hits: hits.slice(0, 60), total: hits.length };
  }

  function snippet(d, at) {
    const body = (d.body && d.body.length > 20) ? d.body : d.title;
    const from = Math.max(0, (at || 0) - 80);
    return (from ? '…' : '') + body.slice(from, from + 230).replace(/\s+/g, ' ');
  }

  function highlight(text, raw, opts) {
    let out = esc(text);
    if (opts.regex) {
      try { out = out.replace(new RegExp(raw, opts.caseSensitive ? 'g' : 'gi'), m => `<mark>${m || ''}</mark>`); }
      catch { /* invalid regex is reported in the meta line */ }
      return out;
    }
    const q = parseQuery(raw, opts);
    const words = q.terms.filter(t => t.length > 1).map(escRx).sort((a, b) => b.length - a.length);
    for (const w of words) {
      out = out.replace(new RegExp(`(${w})`, opts.caseSensitive ? 'g' : 'gi'), '<mark>$1</mark>');
    }
    return out;
  }

  // ---------------------------------------------------------------- UI
  const root = document.createElement('div');
  root.id = 'cts-root';
  root.innerHTML = `
    <button id="cts-btn" title="Sök i kursen (Ctrl+Shift+F)">⌕</button>
    <div id="cts-panel">
      <div id="cts-head">
        <input id="cts-q" placeholder="Sök i kursen…  &quot;fras&quot;  -uteslut  type:sida  intitle:ord">
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
      <ul id="cts-results"></ul>
    </div>`;
  document.body.appendChild(root);

  const panel = root.querySelector('#cts-panel');
  const qEl = root.querySelector('#cts-q');
  const metaEl = root.querySelector('#cts-meta');
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
      opts = { ...opts, ...g.opts };
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
    meta('bygger om index…');
    try {
      index = await getIndex(courseId, true, meta);
      meta(`${index.docs.length} poster, ${new Date(index.ts).toLocaleTimeString()}`);
    } catch (e) { meta('kunde inte indexera: ' + e.message); }
  };

  async function run() {
    if (!index) {
      try { index = await getIndex(courseId, false, meta); }
      catch (e) { return meta('kunde inte indexera: ' + e.message); }
    }
    const raw = qEl.value.trim();
    if (!raw) { listEl.innerHTML = ''; meta(''); qEl.classList.remove('bad'); return; }
    const t0 = performance.now();
    const res = search(index, raw, opts);
    const ms = Math.round(performance.now() - t0);
    if (res.error) {
      qEl.classList.add('bad');
      meta(res.error);
      listEl.innerHTML = '';
      return;
    }
    qEl.classList.remove('bad');
    if (res.empty) { meta('skriv något att söka på'); return; }
    meta(`${res.total} träffar på "${raw}" i ${index.docs.length} poster (${ms} ms)`);
    listEl.innerHTML = res.hits.map(h => `
      <li>
        <span class="b">${esc(h.type)}</span>
        <a class="t" href="${esc(h.href || '#')}" target="_blank" rel="noopener">${highlight(h.title, raw, opts)}</a>
        <div class="s">${highlight(snippet(h, h.at), raw, opts)}</div>
      </li>`).join('');
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
