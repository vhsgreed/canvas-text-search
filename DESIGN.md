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

## Phase 0: what the live session exposes (measured 2026-11-16)

Before building search features, the surface has to be known. Probed course 2416 twice: once
with the API token, once with the page's own cookie session via `fetch(..., {credentials:
'same-origin'})`. **Both returned identical statuses**, which is the reason the extension needs
no token, and the reason a token is only needed for offline work.

| Endpoint | Status | Items | Usable as |
|---|---|---|---|
| `modules?include[]=items` | 200 | 7 modules, 60 items | the only route to pages |
| `pages` (index) | **404** "Sidan har avaktiverats för den här kursen" | 0 | nothing; also kills `search_term` |
| `pages/<slug>` (single) | 200 | 26 pages | yes, via module items |
| `assignments?include[]=rubric` | 200 | 15, of which **4 carry rubrics** (8–10 rows each) | task text + criteria |
| `assignments` (no include) | 200 | 15 with `rubric: []` | silently loses all criteria |
| `rubrics` | **403** | 0 | students are refused |
| `quizzes` | **404** | 0 | disabled for this course |
| `discussion_topics` | 200 | 0 threads | nothing here |
| `discussion_topics?only_announcements=true` | 200 | **12** | the "anvisningar" feed |
| `files?per_page=100` | 200 | 44 | names, sizes, download URLs |
| `folders` | 200 | 10 | file tree |
| `students/submissions?student_ids[]=self` | 200 | 15 | own grades, state, submitted bodies |
| `enrollments?user_id=self` | 200 | 1 | role and section |
| `planner/items` | 200 | **53** | one feed with assignments, files, announcements |
| `external_tools` | 200 | 3 | Akademiskt skrivande, Informationskompetens, Vårdjuridik |
| `visible_course_nav_tools` | 200 | 4 | Kaltura Mediagalleriet (`kaf-canvas-328.kaltura.nordu.net`) |
| `features` | 200 | 26 flags | `smart_search` is *allowed* yet the pages tool is off |
| `users/self/todo` | 200 | 0 | Canvas thinks nothing is pending, which is wrong |
| `users/self/upcoming_events` | 200 | 1 | thin next to `planner/items` |
| `users/self/groups` | 200 | 3 | group work |

Module items by type: 26 Page, 19 Assignment, 10 SubHeader, 2 File, 2 ExternalUrl
(Vårdhandboken redirects), 1 ExternalTool (Akademiskt skrivande).

**Per course, not per account.** A fourth course or a later term needs `surface` run again:
course 28 (Informationskompetens) answers **403 on `/files`**, so its file tree does not exist
for a student even though its pages do.

### Where the material actually lives

Counting every `href` inside the mirrored pages:

| Course | Links in pages | to Canvas files | to SharePoint/OneDrive | to video | elsewhere |
|---|---|---|---|---|---|
| 2416 PRY | 104 | 16 | 8 | 0 | 52 |
| 2415 OMV | 62 | 33 | 11 | 4 | 4 |
| 28 Informationskompetens | 106 | 0 (`/files` 403) | 0 | 16 | 78 (databases) |

File trees: 2416 = 36 pdf, 7 docx, 1 pptx. 2415 = 47 pdf, 4 docx, 5 pptx, 1 html, 1 jpg.
So 102 documents are behind file-tree links, and a further 19 SharePoint share links are not in
any tree at all and never appear in `/files`. A name-only index therefore covers roughly half a
course's reading material: **the file tree is not the corpus, it is one of three entrances**.

### What that changed in the build

Three of these findings were defects, not features:

1. **Rubrics were never indexed.** `assignments` without `include[]=rubric` returns
   `rubric: []`, so 37 grading criteria across 4 examinations were absent. Fixed in both the
   extension and `shhkit.search`; `"definition av samverkan i team"` now finds the Jämlik and
   Samverkan criteria.
2. **Rich documents were being dropped.** A module item creates an empty stub for its
   assignment, and the dedupe kept the *first* copy, so task descriptions and rubrics were
   discarded even when fetched. The index now keeps the richest version of a document.
3. **Pages are only reachable through modules.** With the page index off (404), a page that is
   not linked from a module is invisible to both the extension and the API. That is a hard
   ceiling on coverage, and the reason the tool must say how many documents it has.

`shhkit surface course=<id>` now repeats this probe on demand, so the next course can be
measured instead of assumed.

### Build order

1. **Done:** inventory (`surface`), index fields (pages, announcements, assignments + rubrics,
   files, module items), deep links, ranking, tests.
2. **Next:** read `planner/items` for deadlines instead of stitching assignments and calendar;
   add own submissions and grades to the searchable corpus.
3. **Then:** LTI and Kaltura are behind their own sessions and are out of scope until one of
   them turns out to hold lecture material worth indexing.

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
| Index from the dashboard (`/`), all courses at once | n/a | n/a | **plan** | The tool should work where the semester starts, not only inside one course |
| PDF text extraction | n/a | n/a | **plan** | 102 files; without text the index stops at file names |
| DOCX and PPTX text extraction | n/a | n/a | **plan** | 21 files, clean XML, cheap once the pipeline exists |
| Linked-document resolution (Canvas viewer, SharePoint share links, source URLs) | n/a | n/a | **plan** | 19 SharePoint links and 49 file links sit outside the tree; a share link is a document nobody has indexed |
| Embedded video transcripts | n/a | n/a | **plan** | 20 Kaltura embeds are lecture material in the only format left unread |
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

## Boundary: whose material ends up in the index

Deeper extraction means indexing documents written by teachers, publishers and classmates. The
line this project draws, written down so it does not drift:

- **Read what the student's own session is offered.** Page bodies, file trees, links inside
  pages, share links on pages the course published. That is the same set a student can open by
  hand, and indexing it locally is reading with better memory.
- **Do not guess URLs.** No enumerating ids, no walking folders that the session refuses
  (`403` on `/files` for course 28 stays a 403), no unlisted or unpublished material reached by
  constructing a URL. Width of access must not grow; only speed of recall.
- **Do not redistribute.** Extracted text stays in a local index. Nothing from the index is
  uploaded, published, committed to the repo or sent to a model provider. The repo ships code,
  never course material.
- **Keep provenance.** Every extracted passage stores file name, course, and origin URL, so a
  claim can be checked against the source the way a citation must be.
- **Third-party licences still apply to copies.** A publisher PDF that a student may read does
  not become yours to keep, quote at length, or hand on. Local search is the narrow use; an
  export button would not be.
- **Watch what a share link exposes.** A SharePoint share link can open a document uploaded by
  someone else under their name, sometimes with their comments. Index it for the course's
  content, not the author's identity, and never index other students' submissions.

## Out of scope, on purpose

- Any write operation against Canvas: no submitting, no posting, no grade access.
- Any network call except to the user's own Canvas.
- Indexing other students' submissions or discussions beyond what the course itself shows.

## Roadmap

1. Facets for type and date range (replaces most typed operators).
2. In-page highlight of all matches after arriving from a deep link (Custom Highlight API).
3. Dashboard entry point: the extension also runs on `shh.instructure.com/` and indexes every
   enrolled course, with one merged result list and per-course progress. Needs a wider
   `matches` pattern, a crawl budget (Canvas throttles), and a visibility layer so a hit in
   another course is obvious.
4. Document text: PDF, DOCX and PPTX extraction behind one switch, with a size cap and a
   per-file skip list. 102 tree files, 21 of them Office XML.
5. Linked documents: resolve links inside pages, including the Canvas document viewer, the
   `download.aspx?share=` form for SharePoint, and plain source URLs. This is where the other
   half of the reading list lives.
6. Video transcripts, if Kaltura exposes them to the student session at all.
7. Optional semantic layer, local-only, benchmarked against the lexical baseline before shipping.
