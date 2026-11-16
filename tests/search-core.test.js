/* Unit tests for search-core.js. Run: node --test tests/
   The fixtures imitate a Canvas course: a page, an assignment with rubric, a file,
   a module item and a discussion, with dates. */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../search-core.js');

const mk = (type, title, body, extra = {}) => {
  const f = C.fold(title + ' ' + body);
  const w = [...new Set(f.split(/[^a-z0-9]+/).filter(x => x.length > 2))];
  return Object.assign({ type, title, body, href: `/courses/1/${type}/${title}`, ext: '', date: '', f, w }, extra);
};

const idx = {
  cid: 1, ts: Date.now(),
  docs: [
    mk('sida', 'Anvisningar och formalia', 'Det görs en plagiatkontroll av inlämningsuppgiften. OURGINAL är namnet på mjukvaran. Det är inte tillåtet att använda AI under denna uppgift.', { date: '2026-10-01' }),
    mk('sida', 'Vetenskaplig artikel', 'Korta citat skall anges med sidnummer enligt APA. Läs artikeln kritiskt.', { date: '2026-11-10' }),
    mk('uppgift', 'Examination delfråga: Evidensbaserad vård', 'Redogör för EBV och vetenskaplig metod. APA-mallen gäller.', { date: '2026-11-26' }),
    mk('fil', 'Kriterier för komplettering.pdf', 'Kriterier för komplettering APA', { ext: 'pdf', date: '2026-09-15' }),
    mk('anvisning', 'Välkomstinformation', 'Viktigt att läsa anvisningarna först.', { date: '2026-08-20' }),
    mk('diskussion', 'Gruppdiskussion metod', 'Diskutera begreppet evidens i gruppen.', { date: '2026-11-16' }),
  ],
};

const q = (raw, opts = {}) => C.search(idx, raw, opts);
const titles = r => r.hits.map(h => h.title);

test('fold normalises Swedish letters and whitespace and trims', () => {
  assert.equal(C.fold('  Omvårdnad   Åt ÅLANDSÖ '), 'omvardnad at alandso');
});

test('plain term finds text inside page bodies, not just titles', () => {
  const r = q('mjukvaran');
  assert.equal(r.total, 1);
  assert.equal(r.hits[0].title, 'Anvisningar och formalia');
});

test('implicit AND requires every term', () => {
  assert.equal(q('APA sidnummer').total, 1);
  assert.equal(q('APA zebra').total, 0);
});

test('phrase search respects word order', () => {
  assert.equal(q('"korta citat"').total, 1);
  assert.equal(q('"citat korta"').total, 0);
});

test('exclusion with minus', () => {
  const all = q('APA').total;
  const less = q('APA -kriterier').total;
  assert.ok(all > less, 'minus must reduce the result set');
  assert.equal(less, 2);
});

test('required term with plus behaves like AND', () => {
  // "artikeln" contains "artikel" in substring mode, so this matches one document
  assert.equal(q('+APA artikel').total, 1);
  assert.equal(q('+APA vetenskaplig').total, 2);
  assert.equal(q('+APA begreppet').total, 0, 'begreppet only occurs without APA');
});

test('OR splits into alternatives and dedupes', () => {
  const r = q('OURGINAL OR "korta citat"');
  assert.equal(r.total, 2);
  assert.deepEqual(titles(r).sort(), ['Anvisningar och formalia', 'Vetenskaplig artikel']);
});

test('type filter', () => {
  assert.equal(q('APA type:fil').total, 1);
  assert.equal(q('APA type:sida').total, 1);
  assert.equal(q('begreppet type:diskussion').total, 1);
});

test('filetype filter', () => {
  assert.equal(q('APA filetype:pdf').total, 1);
  assert.equal(q('APA filetype:docx').total, 0);
});

test('intitle restricts to titles', () => {
  assert.equal(q('intitle:vetenskaplig').total, 1);
  assert.equal(q('intitle:vetenskaplig APA').total, 1);
});

test('before and after filter on document date', () => {
  // dates in the fixture: sida 2026-10-01, sida 2026-11-10, uppgift 2026-11-26,
  // fil 2026-09-15; APA occurs in the two November docs and the September file
  assert.equal(q('APA after:2026-11-01').total, 2);
  assert.equal(q('APA before:2026-10-01').total, 1, 'the September file');
  assert.equal(q('APA before:2026-11-30 after:2026-10-31').total, 2);
  assert.equal(q('APA before:2025').total, 0);
  assert.equal(q('APA after:2026-11-26').total, 0, 'strictly after, so an equal date is excluded');
});

test('unknown type reports an error instead of silently returning nothing', () => {
  const r = q('APA type:kanelbulle');
  assert.ok(r.error && /Okänd typ/.test(r.error));
});

test('case sensitivity toggles matching', () => {
  assert.equal(q('ourginal').total, 1);
  assert.equal(q('ourginal', { caseSensitive: true }).total, 0);
  assert.equal(q('OURGINAL', { caseSensitive: true }).total, 1);
});

test('short terms always match whole words, longer ones match inside words', () => {
  // rule: 3 characters or fewer are word-matched even without the checkbox
  assert.equal(q('ai', { wholeWord: true }).total, 1);
  assert.equal(q('APA', { wholeWord: true }).total, 3, 'four-letter terms unaffected by the rule');
  const tiny = { cid: 1, ts: 0, docs: [mk('sida', 'X', 'sidnumrering AIX')] };
  assert.equal(C.search(tiny, 'ai').total, 0, 'short term does not match inside AIX');
  assert.equal(C.search(tiny, 'ai', { wholeWord: true }).total, 0);
  const longInside = { cid: 1, ts: 0, docs: [mk('sida', 'X', 'las artikeln kritiskt')] };
  assert.equal(C.search(longInside, 'artikel').total, 1, 'long term matches inside artikeln');
  assert.equal(C.search(longInside, 'artikel', { wholeWord: true }).total, 0);
});

test('fuzzy catches transposition and substitution that plain search misses', () => {
  assert.equal(q('plagiatkontorl').total, 0);
  assert.equal(q('plagiatkontorl', { fuzzy: true }).total, 1);
  assert.equal(q('korta sitat', { fuzzy: true }).total, 1);
});

test('fuzzy does not degrade precision on an exact term', () => {
  assert.equal(q('plagiatkontroll', { fuzzy: true }).total, 1);
});

test('regex mode matches patterns and honours groups', () => {
  assert.equal(q('pla[gy]iat\\w*', { regex: true }).total, 1);
  assert.equal(q('(our|ur)ginal', { regex: true }).total, 1);
});

test('invalid regex returns an error, not an exception', () => {
  const r = q('[unclosed', { regex: true });
  assert.ok(r.error);
  assert.equal(r.total, 0);
});

test('ranking puts title matches and pages first', () => {
  const r = q('APA');
  const first = r.hits[0];
  assert.ok(first.type === 'sida' || first.type === 'uppgift');
  for (let i = 1; i < r.hits.length; i++) assert.ok(r.hits[i - 1].score >= r.hits[i].score);
});

test('did-you-mean proposes the indexed spelling', () => {
  assert.equal(C.suggest(idx, 'OURIGINAL'), 'ourginal');
  assert.equal(C.suggest(idx, 'plagiatkontorl'), 'plagiatkontroll');
  assert.equal(C.suggest(idx, 'OURGINAL'), null, 'no suggestion when the term is correct');
});

test('deep link appends a text fragment and encodes reserved characters', () => {
  const href = C.deepLink('/courses/1/pages/x', 'korta citat');
  assert.equal(href, '/courses/1/pages/x#:~:text=korta%20citat');
  const dashed = C.deepLink('/courses/1/pages/x', 'plagiat-kontroll, a');
  assert.ok(dashed.includes('%2D'), 'dash must be percent-encoded per spec');
  assert.ok(dashed.includes('%2C'), 'comma must be percent-encoded per spec');
  assert.equal(C.deepLink('/a', ''), '/a');
});

// Regression: a real Canvas page produced "#:~:text=ontrol (OURGINAL)Observera att ..."
// The offset started mid-word and crossed a block boundary, so Chrome ignored the fragment.
const pageDoc = mk('sida',
  'Anvisningar och formalia - Examination inlämningsuppgift',
  'Information om plagiatkontrol (OURGINAL) Observera att OURGINAL, en automatisk mjukvara för textmatchning, används vid bedömning av svar.',
  { date: '2026-10-01' });

test('anchor never starts mid-word', () => {
  const r = C.search({ cid: 1, ts: 0, docs: [pageDoc] }, 'OURGINAL');
  const anchor = C.anchorTarget(r.hits[0], 'OURGINAL', {});
  assert.ok(anchor && anchor.length > 0, 'an anchor is produced');
  assert.ok(!/^ontrol/i.test(anchor), 'must not begin inside "plagiatkontrol"');
  assert.ok(/^(Information|plagiatkontrol|OURGINAL)/i.test(anchor), `unexpected anchor: ${anchor}`);
  assert.ok(pageDoc.body.includes(anchor), 'the phrase exists verbatim in the document');
});

test('anchor never spans two blocks', () => {
  // the second real failure: "</p><p>" was glued into "(OURGINAL)Observera", so the
  // phrase crossed a block boundary and Chrome ignored the fragment
  const body = 'Information om plagiatkontrol (OURGINAL)\nObservera att OURGINAL, en automatisk mjukvara för textmatchning, används.';
  const d = mk('sida', 'T', body, {});
  const r = C.search({ cid: 1, ts: 0, docs: [d] }, 'OURGINAL');
  const a = C.anchorTarget(r.hits[0], 'OURGINAL', {});
  assert.ok(a, 'an anchor is produced');
  assert.ok(!a.includes('\n'), `anchor contains a newline: ${JSON.stringify(a)}`);
  assert.ok(body.split('\n').some(l => l.includes(a)), `anchor spans blocks: ${a}`);
});

test('anchor contains the search term', () => {
  // regression: the anchor scrolled near the match but contained none of the query,
  // because offsets were measured in the whitespace-collapsed string
  for (const [opts, raw] of [[{}, 'OURGINAL'], [{ fuzzy: true }, 'OURIGINAL']]) {
    const r = C.search({ cid: 1, ts: 0, docs: [pageDoc] }, raw, opts);
    const anchor = C.anchorTarget(r.hits[0], raw, opts);
    assert.ok(C.fold(anchor).includes('ourginal'), `${raw} -> ${anchor}`);
  }
});

test('anchor is whole words and at least three of them', () => {
  const r = C.search({ cid: 1, ts: 0, docs: [pageDoc] }, 'OURGINAL');
  const anchor = C.anchorTarget(r.hits[0], 'OURGINAL', {});
  assert.ok(anchor.split(/\s+/).length >= 3, `too short: ${anchor}`);
  assert.ok(!/\s$/.test(anchor) && !/^\s/.test(anchor), 'no dangling whitespace');
  assert.ok(anchor.length <= 120, 'stays inside the fragment budget');
});

test('unverifiable anchor degrades to a plain link', () => {
  assert.equal(C.deepLink('/p/x', ''), '/p/x');
  assert.equal(C.fragmentMatches('', 't', 'b'), false);
  assert.equal(C.fragmentMatches('zzz not here at all', 't', 'b'), false);
  assert.equal(C.anchorFor('t', 999, 'short'), '');
});

test('an offset inside a word is walked back to the word start', () => {
  // this is the exact failure: "plagiatkontrol" sliced at "ontrol"
  const at = pageDoc.body.indexOf('ontrol');
  const anchor = C.anchorFor(pageDoc.title, at, pageDoc.body);
  assert.ok(anchor && !/^ontrol/.test(anchor), `starts mid-word: ${anchor}`);
  assert.ok(anchor.includes('plagiatkontrol'), `expected the whole word present: ${anchor}`);
  assert.ok(!anchor.includes('nformation om plagiatkontrol (OURGINAL)Observera'),
    'must not glue two blocks together');
});

test('fuzzy and regex hits still get a verified anchor', () => {
  const fz = C.search({ cid: 1, ts: 0, docs: [pageDoc] }, 'OURIGINAL', { fuzzy: true });
  const a1 = C.anchorTarget(fz.hits[0], 'OURIGINAL', { fuzzy: true });
  assert.ok(a1 && pageDoc.body.includes(a1), `fuzzy anchor not in body: ${a1}`);
  const rx = C.search({ cid: 1, ts: 0, docs: [pageDoc] }, 'ourg\\w*', { regex: true });
  assert.equal(rx.total, 1, 'regex fixture must match');
  const a2 = C.anchorTarget(rx.hits[0], 'ourg\\w*', { regex: true });
  assert.ok(a2 && pageDoc.body.includes(a2), `regex anchor not in body: ${a2}`);
});

test('snippet centres on the match and never exceeds its window', () => {
  const doc = mk('sida', 'T', 'x'.repeat(500) + ' needle ' + 'y'.repeat(500));
  const s = C.snippet(doc, 507);
  assert.ok(s.includes('needle'));
  assert.ok(s.length <= 240);
});

test('empty query is not an error', () => {
  const r = q('   ');
  assert.equal(r.empty, true);
  assert.equal(r.total, 0);
});

test('only filters, no terms, still works', () => {
  assert.equal(q('type:fil').total, 1);
  assert.equal(q('filetype:pdf').total, 1);
});
