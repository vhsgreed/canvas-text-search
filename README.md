# Canvas Text Search

Full-text search inside a Canvas course. Canvas's own search cannot find text inside course
pages, assignment descriptions, rubrics, discussions or announcements. This reads them
through the Canvas API with the session you already have, keeps a local index, and searches
it in a few milliseconds.

## What it indexes
| Source | Includes |
|---|---|
| Course pages | full text, via module items, works even when the page index is disabled |
| Assignments | name, description, rubric criteria and descriptions |
| Discussions and announcements | title and message |
| Modules | module name plus item titles |
| Files | file name and extension (contents are not downloaded) |

144 documents for a normal course, built in about 4 seconds, roughly 300 KB per course in
`chrome.storage.local`. Rebuilt every 6 hours or with the ↻ button.

## Search syntax
| You type | You get |
|---|---|
| `plagiatkontroll` | documents containing the word |
| `"korta citat"` | exact phrase |
| `APA -kriterier` | APA but not kriterier |
| `ourginal OR HLR` | either term |
| `type:sida` | only pages (also `uppgift`, `fil`, `modul`, `diskussion`, `anvisning`) |
| `filetype:pdf` | only files with that extension |
| `intitle:vetenskaplig` | only documents whose title contains it |
| `pla[gy]iat\w*` | regular expression (Regex checkbox) |

Terms combine with implicit AND. Checkboxes: **Skiftlägeskänslig** (case), **Regex**,
**Fuzzy** (typo tolerant, Damerau-Levenshtein: `plagiatkontorl` finds `plagiatkontroll`,
`korta sitat` finds `korta citat`), **Hela ord** (whole word only). Settings persist.

Short terms (three characters or fewer) always match whole words, so `AI` no longer hits
"Scandinavian". Diacritics fold by default: å/ä→a, ö→o. An invalid regex turns the input
red and reports the error instead of failing silently.

## Install
1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. **Load unpacked**, select this folder.
4. On any Canvas course: blue ⌕ bottom right, or **Ctrl+Shift+F**. **Esc** closes.

No token, no options file, no third-party calls. It uses the session cookie your browser
already has, so it cannot read anything you are not allowed to see.

## Verified behaviour
Tested live against SHH's PRY course (144 documents):

| Test | Result |
|---|---|
| `ourginal` | 1 hit (the page misspells Ouriginal) |
| `plagiatkontorl` plain / fuzzy | 0 / 1 |
| `korta sitat` plain / fuzzy | 0 / 1 |
| `"korta citat"` | 1 |
| `APA -kriterier` | 11 → 1 |
| `APA filetype:pdf` | 5 |
| `OURGINAL` with case on | 1, and `ourginal` with case on gives 0 |
| `pla[gy]iat\w*` regex | 1 |
| `[unclosed` regex | error shown, no crash |
| query time | 0 to 4 ms on the 144-document index |

## Notes
- `matches` and `host_permissions` are pinned to `https://shh.instructure.com/*`. Change both
  for another Canvas school.
- `--load-extension` no longer works in branded Chrome from version 137 (May 2025), so the
  extension must be loaded by hand once through `chrome://extensions`.

## Licence
MIT.
