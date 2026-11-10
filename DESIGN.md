# Standing: Verdict

*The look approved on 9 Nov 2026. It replaces the earlier "Clinical" look. The reference is `design/comp-home-v2.html` (rendered: `design/comp-home-v2.png`); where this file and the comp disagree, the comp wins for the home and this file wins for every other screen. The tokens are `public/assets/tokens.css`; the shared craft rules are `design/PRINCIPLES.md`.*

## The idea in one paragraph

The answer is the product, so the answer gets the room. Every result leads with a solid slab of colour carrying one very large word: green for good standing, amber for a caution, red for a stop, slate when Standing is not sure. Around it the page is quiet: a cool mineral background with a faint grain, soft white panels without borders, a heavy grotesk for anything that speaks and a mono face only for numbers. Nothing here should look like a ledger, a stamp or a lab report.

## Colour

| Token | Value | Use |
|---|---|---|
| `--page` | `#edf0ed` | page background |
| `--page-2` | `#e2e7e3` | a full-width band, one shade down from the page |
| `--slab` | `#ffffff` | panels, the form, the nav, secondary buttons |
| `--well` | `#edf0ed` | inputs and image wells inside a slab |
| `--ink` | `#0d1512` | text, the primary button |
| `--ink-2` | `#36413c` | body text on the page |
| `--ink-3` | `#5a655f` | labels, secondary lines |
| `--ink-4` | `#98a39d` | placeholders, arrows |
| `--go` | `#0f5c43` | status: active. Also links on hover and focus rings |
| `--go-deep` | `#0a4533` | primary button hover |
| `--go-tint` | `#cfe3da` | the big step numerals, the halo of the status light, quiet text on a green slab |
| `--wait` | `#94660f` | status: conditions, expired, not licensed |
| `--stop` | `#8c2c2c` | status: suspended, removed, dissolved, insolvency |
| `--hold` | `#55615b` | unknown, ambiguous, no match, not supported, check failed, pending |
| `--rule` | `rgba(13, 21, 18, .12)` | the only line there is: between rows of a list |

One light theme. No dark mode and no dark section inside the light page. White text on all four status colours passes 4.5:1.

## Type

- **Display:** Bricolage Grotesque, weights 600 to 800, for headlines, the status word, names of records and registers, big figures. Tight tracking (about -0.03em), line-height .94 to 1.1, `text-wrap: balance`.
- **Body:** Geist 400, 500, 600.
- **Numbers:** Geist Mono 400, 500, with tabular figures, for registration numbers, dates and times in proof lines, money.
- All three are self-hosted woff2 under the SIL Open Font License.
- Labels are sentence case, 13px, weight 500, `--ink-3`. **No uppercase mono labels anywhere.** No small caps, no letter-spaced capitals.
- Sizes at 1280: h1 82px, section heading 54px, status word 132px on the home card and `clamp(72px, 13vw, 168px)` on a result, record name 26px, body 16 to 19px, never under 12.5px. On a phone: h1 44px, section heading 34px.

## Surfaces

- **No bordered cards.** A panel is a white slab with a tinted shadow: `0 1px 1px rgba(13,49,37,.05), 0 12px 32px -12px rgba(13,49,37,.22)`. A status slab's shadow carries its own colour.
- Radius varies by depth: status slab 30px, panel 26px, inner panel 14 to 18px, button 12px, chip 8px. On a phone the outer radii drop to 20px.
- Lists are rows separated by `--rule`, with generous padding, no outer box and no header band.
- A fixed grain overlay sits over the page (the SVG noise data URI in the comp, `mix-blend-mode: multiply`, pointer-events none). It is the only texture. No gradients, blur, glow or glass.
- Inputs are borderless wells (`--well`) inside a slab, 16px padding, a 2px `--go` outline on focus.

## Signature pieces

- **Wordmark.** `Standing` in the display face, 700, with a small solid green status light before it (11px dot with a `--go-tint` halo). There is no stamp.
- **Navigation.** A white pill-shaped container holding the five links; the current one is filled with `--ink`.
- **The verdict slab.** Background is the status colour, text is white. Top line: register and place on the left, read time on the right. Then the status word, very large, sentence case ("Active", "Not licensed", "No match", "Ambiguous", "Check failed", "Not supported", "Checking"). Then "The register says “…”", then the name in the display face with its number in mono. On the home it also holds a white inner panel with three facts, the screenshot and the proof line, and a foot row of links. The word is always there, so the status never depends on colour alone.
- **Flag chips.** Small solid chips (8px radius, white text on the status colour, sentence case): "Proposal to strike off" on `--wait`, "Interim order" on `--stop`, "Matched by number" as plain `--ink-3` text, not a chip.
- **Facts.** A definition list: label above value, rows separated by `--rule` on a result page; no table chrome.
- **Evidence panel.** A white slab holding the screenshot in a well, with the proof line under it in mono 12.5px: `Companies House · read 9 Nov 2026, 08:40 UTC · Fetch · live · source ↗`.
- **Steps.** Three rows with a huge numeral (128px, `--go-tint`) and the text beside it. Never three equal cards.
- **Change rows.** Time in mono, the record in the display face, two solid chips with an arrow between them, the monitor kind at the right.
- **Register index.** Names in the display face at 30px in two columns, each with a quiet "UK · doctors" at the right.
- **Figures.** Big display numbers with a small label under them (registers, countries, checks run, records watched).
- **The watchlist.** Each watched record is a verdict slab of its own, two to a row: register and watch on the top line, the status word large on its colour, the record, its flag chips, then when it was last read and what Monitor last caught. The whole slab is the link to the record. A person is shown by record type and number, never by name.
- **The status words (About).** Nine tiles, three to a row, each a status word in the display face on its own colour with one line of meaning under it. On a phone, one to a row.
- **Register panels (Coverage).** One white panel per register, two to a row: place and record type, the name at 32px, how it is looked up and watched as two facts, a plain note, the last time it answered in mono. The registers that cannot be read follow as rows, each with a slate chip and its reason.

## Screens beyond the home

- **Result, a match.** The verdict slab spans the container at the top, with its actions (Watch this record as a white button; Receipt, Fresh check with its price, JSON as links) inside the slab's foot. Under it, two columns: facts on the left, the evidence panel on the right, stacking on a phone.
- **Result, not a match.** The same slab in `--hold`. Ambiguous: the rows of candidates below it, each with a white "Verify this one" button. No match: the variants tried and the suggestions as a short list. Not supported, failed: the reason in one sentence.
- **Pending.** The `--hold` slab with the word "Checking", the honest line under it, and a small pulsing dot (CSS only, off under reduced motion). No spinner.
- **Receipt.** One white sheet, 800px at most, on the page background. A strip across its top in the status colour holds the status word at 72px and "Verification receipt" with the date at the right. Then name and number, facts, the screenshot, the proof line, the "what this receipt shows" sentence, the check id and address. Print: `print-color-adjust: exact`, navigation and buttons hidden, one A4 sheet; if a printer drops backgrounds the word is still printed as dark text.
- **Record page.** The verdict slab (stored result), the watch line as plain text under it, then the history as change rows.
- **Watchlist.** Rows, not a table: name or "Nurse · NMC 22H1252O" in the display face, a solid status chip with any flag chip, register, last read, last event, watch. The slots line as a figure.
- **Coverage.** Two lists: supported registers as the index rows with how each is looked up and watched; not supported ones in `--ink-3` with the reason.
- **API and About.** Reading pages: a 60 to 68 character measure, display headings, code in a well with a 14px radius, the TinyFish services as rows with calls and spend in mono at the right.
- **Not found.** The `--hold` slab with "Not found" and one link home.

## Motion

Hover on buttons and rows: a 1px lift or a background shift, 200ms, `cubic-bezier(.2,.7,.2,1)`. Press: `scale(.98)`. The home's opening rises in once, staggered, on load. Everything is off under `prefers-reduced-motion`. No scroll effects and no script.

## What stays from before (the honest rules)

Every record ends with its proof line. "Live" only for a result read in that request; otherwise "stored result" with its real time. Dates as `9 Nov 2026, 08:40 UTC`. The exact copy of the honest states. A person is shown by record type and number on overview pages. No request to a third-party host.

## Never

Bordered white cards. Uppercase mono labels. A stamp. Three equal feature cards. Gradients, blur, glow, glass. Emoji or exclamation marks. A second accent colour. A dark section in the light page.
