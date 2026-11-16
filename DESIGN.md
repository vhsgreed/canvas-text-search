# Design: what to borrow from web search engines

Scope: full-text search over one Canvas course. Two driver cases:

1. **Course index disabled** (SHH's Canvas answers `/pages` with "Sidan har avaktiverats för den
   här kursen"). Pages are only reachable through module items, and Canvas offers no search at
   all, so the extension has to build its own index.
2. **Course index enabled** (other schools, other terms). Canvas search then covers titles and
   some body text but still cannot filter by type, date, rubric content or file names, and
   still returns no snippets.

The question this document answers: which features of mature search engines are worth having
here, and which are noise in a single-course corpus.

## Sources surveyed

- Google's own operator page, "Refine Google searches": quotes, `site:`, leading `-`,
  `before:`, `after:`, `filetype:`. Six operators, explicitly presented as the popular ones.
  Source: https://support.google.com/websearch/answer/2466433
- Yandex, as documented publicly: quotes, `site:`, `url:`, `title:`, `mime:`, `date:`, `lang:`,
  `+`/`-`. Yandex's English-language operator documentation is thin and partly only available
  second-hand; treat this list as the reliable subset, not a complete grammar.
  Sources: https://en.wikipedia.org/wiki/Yandex_Search and secondary operator roundups.
- Text fragments for deep links: URL Fragment Text Directives, `#:~:text=`.
  Source: https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment/Text_fragments
- CSS Custom Highlight API (`::highlight()`), the DOM-safe way to paint matches.
  Source: https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API

## Feature matrix

Legend: **in** = implemented, **plan** = worth doing next, **no** = rejected with reason.

| Feature | Google | Yandex | Here | Why |
|---|---|---|---|---|
| Implicit AND between terms | yes | yes | **in** | The default expectation; costs nothing |
| `"exact phrase"` | yes | yes | **in** | Course rules hinge on exact wording ("korta citat", "lika stor omfattning") |
| `-exclude` | yes | yes | **in** | Removing noise ("APA -kriterier") is the single most used refinement |
| `+required` | yes | yes | **in** | Redundant with implicit AND, but users type it |
| `OR` | yes | yes | **in** | Two course names, two spellings, two concepts |
| `intitle:` | yes, undocumented | yes (`title:`) | **in** | Page titles in Canvas are the closest thing to headings |
| `type:` (page/assignment/file/module/discussion) | via tabs | no | **in** | Canvas mixes five content types in one list; this is the main win over Canvas search |
| `filetype:` (`mime:` in Yandex) | yes | yes | **in** | "the PDF about APA" is a real query |
| `before:` / `after:` (`date:` in Yandex) | yes | yes | **in** | Distinguishes this term's rules from last term's |
| Regex mode | no | no | **in** | Power users only, but it makes the tool honest about being a local index |
| Fuzzy (Damerau-Levenshtein) | spell correction, not matching | yes | **in** | Canvas material is full of typos; `OURIGINAL` is a real one in SHH's own text |
| Did-you-mean on zero hits | yes | yes | **in** | Cheapest possible fix for the typo problem |
| Case sensitivity toggle | yes | yes | **in** | Needed to check exact capitalisation in quoted rules |
| Whole word toggle | partial | yes | **in** | `AI` must not hit "Scandinavian" |
| Ranked results with score | yes | yes | **in** | Title hits above body hits, guidance pages above discussion threads |
| Snippets with the match in context | yes | yes | **in** | Otherwise the user opens every hit |
| Deep link to the match | no (fragments help) | no | **in** | Text fragments scroll and highlight; the single biggest time saver on long pages |
| Local index, no server | n/a | n/a | **in** | Privacy: course content never leaves the machine |
| Offline after indexing | n/a | n/a | **plan** | The index is already local; only rendering needs network |
| Facets / filter chips | yes | yes | **plan** | Clickable type and date facets beat typing `type:` for most users |
| "Only what is new" since last index | n/a | n/a | **plan** | Canvas Course Downloader does this well; same idea for changed pages |
| Saved and recent searches | no | no | **plan** | Cheap, high value during a term |
| Result grouping by module | n/a | n/a | **plan** | Matches how students think about a course |
| Cross-course search | n/a | n/a | **plan** | One index per course now; a merged view is the obvious next step |
| `site:` / `url:` / `inurl:` | yes | yes | **no** | One course is one site; the operator would have exactly one valid value |
| `lang:` | no | yes | **no** | Corpus is Swedish with English articles; no language split to filter on |
| `related:`, `link:`, `cache:` | yes | partial | **no** | Web-graph features with no meaning inside one course |
| PageRank-style link graph | yes | yes | **no** | Course content has no link structure worth ranking |
| Query autocomplete from logs | yes | yes | **no** | No telemetry, no shared corpus, by design |
| Semantic / embedding search | yes | yes | **plan** | Would help "assessment" find "examination"; needs a local model, so it is a separate decision |

## Design decisions worth recording

**Index source over index quality.** Pages are fetched through module items, never through
`/pages`, because SHH disables the page index and because unpublished or unlisted pages are
not the student's business anyway. Anything Canvas does not link from a module is out of scope.

**Files are name-only.** Indexing file contents would mean downloading every PDF, which is
both slow and a copyright question. Names plus extensions are enough to answer "where is the
APA guide". A future "search inside PDFs" would be a separate, explicit action.

**Ranking is deliberately simple.** Title match +12, each occurrence +1 capped at 6, pages and
pinned announcements +3. Anything fancier (BM25) buys little on 150 documents and makes
results harder to explain. Test `ranking puts title matches and pages first` pins the order.

**Fuzzy matching uses Damerau-Levenshtein, not subsequence.** Subsequence matching cannot
handle transpositions, which is the most common typo (`plagiatkontorl`), so it fails the case it
exists for. Distance is capped at 1 for terms up to 5 characters and 2 above, computed against
a pre-indexed word list so a query stays in single-digit milliseconds.

**Short terms are always whole-word.** Three characters or fewer produce more noise than signal
in substring mode. This is a deliberate deviation from Google, documented in the UI and pinned
by a test.

**Text fragments for deep links.** `#:~:text=` is a browser feature, needs no page cooperation,
and works on Canvas pages we do not control. Constraints that shaped the code: matches are
case-insensitive, only the first fragment scrolls, dashes and commas must be percent-encoded,
and the directive is stripped from the URL so the page cannot read it. Where the browser does
not support it, the link still lands on the right page.

### Deep links: the three ways they fail, measured

The first implementation produced fragments that looked right and did nothing. Each failure was
reproduced on a real Canvas page and is now pinned by a test.

| Cause | Symptom | Fix | Evidence |
|---|---|---|---|
| Anchor started **mid-word** (`ontrol`) because the offset counted the page title | no scroll | offsets measured in the body, then walked to a word boundary | scrollTop 0 → 2189 |
| Text extraction **glued blocks**: `</p><p>` became `(OURGINAL)Observera` | no scroll | block elements become `\n` at index time; anchors are cut at the line | scrollTop 0 → 2189 |
| Anchor positioned in the **whitespace-collapsed** string, so it drifted to unrelated text | scrolled to the wrong paragraph | offsets measured in the original body, anchor must contain the term | match off-screen → `matchTop 644 of 1289` |

Measured on `pages/anvisningar-och-formalia-…` in the agent Chrome profile: the shipped anchor
`Information om plagiatkontrol (OURGINAL` scrolls the real scroll container
(`#student-study-drawer-content`) to `scrollTop 2189` with the match visible; the original
fragment leaves `scrollTop 0` and the text at 2833 px, below the fold.

Two consequences for the code. `fragmentMatches()` verifies every anchor against the indexed
body before it is used, and an anchor that cannot be verified yields a plain link rather than a
dead fragment. Because Canvas scrolls an inner container, not the window, a deep link is the
only mechanism that works without injecting code into the page.

Note that the browser strips the `#:~:text=` part from `location.href` after applying it, which
is required by the spec (the page must not be able to read it). A missing fragment in the
address bar is therefore normal and not evidence of failure; what matters is the scroll
position.

**Why not inject highlight markup into Canvas pages.** Canvas re-renders its own DOM on
navigation; a `<mark>` injected by an extension gets wiped or fights React. The Custom Highlight
API (`CSS.highlights` + `::highlight()`) paints ranges without touching nodes, and is the plan
for in-page highlighting after a deep link.

## Out of scope, on purpose

- Any write operation against Canvas: no submitting, no posting, no grade access.
- Any network call except to the user's own Canvas.
- Indexing other students' submissions or discussions beyond what the course itself shows.

## Roadmap

1. Facets for type and date range (replaces most typed operators).
2. In-page highlight of all matches after arriving from a deep link (Custom Highlight API).
3. Cross-course index and a merged search view.
4. PDF text extraction behind an explicit "include document text" switch.
5. Optional semantic layer, local-only, benchmarked against the lexical baseline before shipping.
