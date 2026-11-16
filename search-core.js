/* Canvas Text Search: pure search core.
   No DOM, no chrome.*, no fetch: everything here is a function from data to data, so it can
   be unit tested in Node and reused by the shhkit CLI. The UI lives in content.js. */
(function (root) {
  'use strict';

  const TYPES = {
    sida: 'sida', sidor: 'sida', page: 'sida', pages: 'sida',
    uppgift: 'uppgift', uppgifter: 'uppgift', assignment: 'uppgift', assignments: 'uppgift',
    fil: 'fil', filer: 'fil', file: 'fil', files: 'fil',
    modul: 'modul', moduler: 'modul', module: 'modul', modules: 'modul',
    diskussion: 'diskussion', diskussioner: 'diskussion', discussion: 'diskussion',
    anvisning: 'anvisning', announcement: 'anvisning',
  };

  const fold = s => (s == null ? '' : String(s)).toLowerCase()
    .replace(/[åä]/g, 'a').replace(/ö/g, 'o').replace(/[éè]/g, 'e')
    .replace(/\s+/g, ' ').trim();

  const escRx = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Damerau-Levenshtein with an early exit; catches typos, insertions and transpositions
  function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const al = a.length, bl = b.length;
    let prev2 = null;
    let prev = Array.from({ length: bl + 1 }, (_, j) => j);
    for (let i = 1; i <= al; i++) {
      const cur = [i];
      let rowMin = i;
      for (let j = 1; j <= bl; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          v = Math.min(v, prev2[j - 2] + 1);
        }
        cur[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      prev2 = prev;
      prev = cur;
    }
    return prev[bl];
  }

  // "a OR b OR c" -> ['a','b','c'], quoted phrases untouched
  function splitOr(raw) {
    const parts = String(raw).split(/\s+OR\s+/i);
    return parts.length > 1 ? parts : [raw];
  }

  function parseQuery(raw, opts) {
    const o = Object.assign({ caseSensitive: false, regex: false, fuzzy: false, wholeWord: false }, opts);
    const q = { terms: [], not: [], types: [], exts: [], titleTerms: [],
      before: null, after: null, error: null, regex: null };
    if (o.regex) {
      try { q.regex = new RegExp(raw, o.caseSensitive ? 'g' : 'gi'); }
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
        const kv = s.match(/^(type|filetype|intitle|before|after):(.+)$/i);
        if (kv) {
          const k = kv[1].toLowerCase(), v = kv[2];
          if (k === 'intitle') { if (v) q.titleTerms.push(v); continue; }
          if (k === 'filetype') { q.exts.push(v.replace(/^\./, '').toLowerCase()); continue; }
          if (k === 'before') { q.before = normaliseDate(v); continue; }
          if (k === 'after') { q.after = normaliseDate(v); continue; }
          const mapped = TYPES[v.toLowerCase()];
          if (mapped) { q.types.push(mapped); continue; }
          q.error = `Okänd typ "${v}". Använd: ${[...new Set(Object.values(TYPES))].join(', ')}`;
          continue;
        }
        if (s.startsWith('-') && s.length > 1) { q.not.push(s.slice(1)); continue; }
        if (s.startsWith('+') && s.length > 1) { q.terms.push(s.slice(1)); continue; } // Yandex: required word
        if (/^(and|or)$/i.test(s)) continue;
      }
      if (s) q.terms.push(s);
    }
    return q;
  }

  // 2026-11-16, 2026/11/16 or 2026 -> ISO date string, else null
  function normaliseDate(v) {
    const m = String(v).match(/^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?$/);
    if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3] || '1').padStart(2, '0')}`;
    const y = String(v).match(/^(\d{4})$/);
    return y ? `${y[1]}-01-01` : null;
  }

  const countPlain = (hay, needle) => {
    if (!needle) return 0;
    let c = 0, i = 0;
    while ((i = hay.indexOf(needle, i)) !== -1) { c++; i += needle.length; }
    return c;
  };

  const countWord = (hay, term) => {
    if (!term) return 0;
    const rx = new RegExp(`(^|[^a-z0-9])${escRx(term)}([^a-z0-9]|$)`, 'g');
    let c = 0;
    while (rx.exec(hay)) { c++; rx.lastIndex = Math.max(rx.lastIndex - 1, 0); }
    return c;
  };

  function fuzzyWords(doc, term) {
    const max = term.length <= 5 ? 1 : 2;
    const hits = [];
    for (const w of (doc.w || [])) {
      if (w === term || w.startsWith(term)) { hits.push(w); continue; }
      if (Math.abs(w.length - term.length) > max) continue;
      if (editDistance(term, w, max) <= max) hits.push(w);
    }
    return hits;
  }

  function makeMatcher(q, opts) {
    const o = Object.assign({ caseSensitive: false }, opts);
    const prep = s => (o.caseSensitive ? (s == null ? '' : String(s)) : fold(s));

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
      if (q.before || q.after) {
        const d = (doc.date || '').slice(0, 10);
        if (!d) return null;
        if (q.before && !(d < q.before)) return null;
        if (q.after && !(d > q.after)) return null;
      }
      const hay = prep(`${doc.title}\n${doc.body}`);
      const title = prep(doc.title);
      if (nots.some(x => hay.includes(x))) return null;
      if (titleTerms.some(x => !title.includes(x))) return null;

      let score = 0, at = -1;
      for (const term of terms) {
        const short = term.t.length <= 3;
        let c, anchor = term.t;
        if (o.fuzzy) {
          const fw = fuzzyWords(doc, term.t);
          c = fw.length;
          if (fw.length) anchor = fw[0];
        } else if (o.wholeWord || short) c = countWord(hay, term.t);
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

  function search(idx, raw, opts) {
    const o = Object.assign({}, opts);
    const alts = o.regex ? [raw] : splitOr(raw);
    const found = new Map();
    let sawConstraints = false;
    for (const alt of alts) {
      const q = parseQuery(alt, o);
      if (q.error) return { error: q.error, hits: [], total: 0 };
      const constrained = q.terms.length || q.regex || q.titleTerms.length ||
        q.types.length || q.exts.length || q.before || q.after;
      if (!constrained) continue;
      sawConstraints = true;
      const match = makeMatcher(q, o);
      for (const d of idx.docs) {
        const r = match(d);
        if (!r) continue;
        const key = d.href + '|' + d.title;
        const prev = found.get(key);
        if (!prev || r.score > prev.score) found.set(key, Object.assign({}, d, { score: r.score, at: r.at }));
      }
    }
    if (!sawConstraints) return { hits: [], total: 0, empty: true };
    const hits = [...found.values()].sort((a, b) => b.score - a.score);
    return { hits: hits.slice(0, 60), total: hits.length };
  }

  // "did you mean": best fuzzy word for the query, from the index itself
  function suggest(idx, raw, opts) {
    const o = Object.assign({ caseSensitive: false }, opts);
    const q = parseQuery(raw, o);
    if (q.error || q.regex || !q.terms.length) return null;
    const term = fold(q.terms[0]);
    if (term.length < 4) return null;
    let best = null;
    const seen = new Set();
    for (const d of idx.docs) {
      for (const w of (d.w || [])) {
        if (seen.has(w)) continue;
        seen.add(w);
        const dist = editDistance(term, w, 2);
        if (dist === 0 || dist > 2) continue;
        if (w.length < 4) continue;
        if (!best || dist < best.dist || (dist === best.dist && w.length < best.word.length)) {
          best = { word: w, dist };
        }
      }
    }
    return best && best.dist <= 2 ? best.word : null;
  }

  // Text fragment deep link: the browser scrolls to the phrase and highlights it
  function deepLink(href, phrase) {
    if (!href || !phrase) return href;
    const clean = String(phrase).replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
    if (!clean) return href;
    const encoded = encodeURIComponent(clean).replace(/-/g, '%2D').replace(/,/g, '%2C');
    return `${href}${href.includes('#') ? '&' : '#:~:'}text=${encoded}`;
  }

  function snippet(doc, at, span) {
    const body = (doc.body && doc.body.length > 20) ? doc.body : doc.title;
    const width = span || 230;
    const from = Math.max(0, (at || 0) - Math.floor(width / 3));
    return (from ? '…' : '') + body.slice(from, from + width).replace(/\s+/g, ' ');
  }

  const api = { fold, escRx, editDistance, splitOr, parseQuery, normaliseDate, countPlain,
    countWord, fuzzyWords, makeMatcher, search, suggest, deepLink, snippet, TYPES };

  if (typeof module === 'object' && module.exports) module.exports = api;
  root.CTS_CORE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
