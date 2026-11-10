# Standing Site Implementation Plan

Steps use checkbox (`- [ ]`) syntax for tracking. In the repository this file lives at `docs/plans/2026-11-09-standing-site.md` (Task 1 puts it there).

**Goal:** Give Standing its public face: a home that explains the product and shows one real record, a check flow that ends in a result page for every outcome, record and watchlist pages, coverage, API and About, in the Clinical look chosen on 9 Nov 2026, on the same Worker that runs the checks.

**Architecture:** The existing Hono Worker renders HTML with `hono/jsx`. Site routes call the same functions as the JSON API, so the site and the API cannot disagree. Styles, fonts and one small optional script are static files served by Workers Static Assets. Every screen works with JavaScript off: the check is a form post that redirects to the check's own page, and a pending check refreshes itself with a `<meta http-equiv="refresh">`. Screens that many people open (home, coverage, API, About, watchlist, watched records) are served from stored copies in R2, rebuilt out of band, because the free plan allows 10 ms of CPU per request.

**Tech Stack:** TypeScript (ESM, strict), Hono 4 with `hono/jsx`, Cloudflare Workers + D1 + R2 + Static Assets, Vitest in the existing workers pool. No client framework, no bundler, no new runtime dependency. Fonts self-hosted as woff2 (IBM Plex Sans 400/500/600, IBM Plex Mono 400/500, SIL Open Font License).

**Spec:** `docs/specs/2026-11-03-standing-design.md` section 4.8 (behaviour), 4.3 to 4.7 (data); `DESIGN.md` and `design/PRINCIPLES.md` (copied in Task 1); `design/comp-home.html` (the approved home, copied in Task 1).

## Starts when

The core plan is finished and **deployed**: D1 and R2 exist, secrets are set, the two shared Monitors and the curated watches are live, and at least one real check per registry is recorded.

## Global Constraints

- **Design authority.** `DESIGN.md` and `public/assets/tokens.css` are fixed. Never change a token value, add a second accent or add a dark mode. Components beyond the tokens go in `public/assets/site.css` and use only token variables for colour, type, radius and border.
- **The comp.** `design/comp-home.html` is the reference for the home: layout, spacing, type sizes and every component on it. Its inline CSS is the starting point for `site.css`. Its Google Fonts link and its `comp-assets/` image are for the comp only; the site self-hosts fonts and shows real evidence screenshots. The other screens extend the same treatment.
- **Show and explain.** A first-time visitor must understand what Standing is and see one real verified record without leaving the home. Every screen leads with the thing itself and explains it in one plain sentence.
- **The status word rule.** A status word in the accent, conditions or bad colour appears only on `outcome: "match"`. `AMBIGUOUS`, `NO MATCH`, `NOT SUPPORTED` and `CHECK FAILED` are set in `--neutral`. An ambiguous result never shows a status.
- **Live means live.** A result read in this request's check says `live`. Anything else says `stored result` with its real `checked_at`. The home's record card shows whichever is true for that record.
- **Prices come from the method.** The fresh-check price is the adapter's estimate (`FETCH_ESTIMATE_USD` or `AGENT_ESTIMATE_USD`), printed as `$0.00` to two places for Fetch-method registries and as the Agent estimate for Agent-method ones. No constant in a view.
- **Bans (PRINCIPLES 7 to 9):** no gradients, blur, glow, glassmorphism, illustration packs or decorative icons. Two faces. Tabular numerals on every figure. Reading measure 60 to 72 characters. No text under 11.5px. Motion 150 to 240 ms, ease-out, one property; `prefers-reduced-motion` turns it off.
- **Every record ends with an evidence line**, in this shape: `General Medical Council · read 5 Nov 2026, 09:22 UTC · Agent run · live · source ↗`. Method is `Agent run` or `Fetch`. The fourth part is `live` or `stored result`.
- **Dates in UI:** `5 Nov 2026, 09:22 UTC`, always UTC, no relative times. In data and URLs: ISO 8601.
- **Copy:** declarative and brief, no exclamation marks, no emoji. Errors name the registry. The strings in "Honest states" below are part of the contract; tests assert them.
- **No JavaScript required.** `public/assets/enhance.js` may only add comfort (a `<dialog>` lightbox over the screenshot link, a copy button on the API page). No inline `<script>`.
- **Static assets:** `wrangler.jsonc` gets exactly `"assets": { "directory": "./public" }` and `"preview_urls": true`. No `run_worker_first`, no `not_found_handling`, no `.html` file under `public/`.
- **The site is behind a switch.** `vars.SITE_ENABLED` is `"0"` in `wrangler.jsonc` until Task 7. With it off, every site route answers exactly as the Worker does today. Previews upload with `--var SITE_ENABLED:1`; the test environment sets it to `"1"`.
- **Core safety.** The Monitor webhook and the Agent callback do no more work than today. JSON responses change only by additions this plan names. Every existing test keeps passing without edits to its assertions.
- **One function per answer.** A site route and the JSON handler for the same data call the same function. Where a handler holds the logic inline, extract it first, without changing the JSON.
- **Security headers on every HTML response:** `content-security-policy: default-src 'self'; img-src 'self' data:; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, `x-content-type-options: nosniff`, `referrer-policy: strict-origin-when-cross-origin`. Register text, names and URLs are escaped by JSX; nothing read from a register is ever emitted as markup. No request to a third-party host from any screen.
- **Same-origin paths in HTML.** Evidence images are linked by path (`/evidence/<id>.jpg`), never by the absolute `PUBLIC_BASE_URL` form the JSON carries.
- **Budget.** `SPEND_PAUSE_USD` is **4** and `PUBLIC_AGENT_CHECKS_PER_DAY` is 8 (both set in the core's Task 9; the wallet is shared with five more builds and the figures may change): across all visitors, at most eight Agent-method live checks start per UTC day; stored results, Fetch-method checks and number lookups that hit the cache are not counted. The site only shows these states; it does not define them. Live calls cleared for this plan: `wrangler versions upload`, the example checks named in Task 2 (three, about $0.40 in all). Anything else that costs wallet money: ask first.
- **Deploy rule.** Previews: `wrangler versions upload --var SITE_ENABLED:1 --message "<what>"`. `wrangler deploy` only after the preview has been looked at.
- **Targeted testing (Hamdan, 9 Nov 2026).** The test lists in each task are a ceiling, not a floor. Keep the tests that guard a real failure: the exact honest-state strings, live against stored, no status on an ambiguous result, the pending refresh and where it stops, prices from the method, the site switch, the security headers, escaping. Drop assertions that only restate markup. While working, run only the test files the change touches; run the full `npm run check` once per task, right before the commit. Put the saved effort into looking at the real screens and making them work well.
- **One task at a time.** After each task: commit, look at the result, then start the next.
- **Commits:** stage files by path. `npm run check` passes once at the end of every task; read its exit line.
- **Look at it.** Before a screen is called done, look at the rendered result at 375px and 1280px.

### Honest states (exact copy)

`<Registry>` is the registry's full name, `<q>` the query as typed.

| Situation | Copy |
|---|---|
| Check waiting for the Agent slot | `Waiting for a free browser. One register search runs at a time.` |
| Check running | `Reading the register now. This page refreshes by itself.` |
| Still pending after 3 minutes | `Still waiting. The register has not answered yet.` with the link `Look again` |
| Agent run failed or timed out | status word `CHECK FAILED`, line `The <Registry> search did not finish. Nothing was guessed. Try again, or check by registration number.` |
| TinyFish rate limit, retry pending | `TinyFish is busy. The check retries in a minute.` |
| Spending paused | `Live checks are paused: Standing has reached its spending line of $4. Stored results and watched records are still shown.` |
| Daily public Agent checks used | `Today's live browser checks are used. Stored results still open, and they return at 00:00 UTC.` |
| This visitor's daily checks used | `You have used today's 5 live checks. Stored results still open.` |
| Unsupported registry | status word `NOT SUPPORTED`, line `<reason from the coverage table>` |
| Several matches | status word `AMBIGUOUS`, line `<n> records match “<q>”. Standing gives no status until one is chosen.` |
| No match | status word `NO MATCH`, line `The <Registry> search returned no result for “<q>”. Tried: <variants, comma separated>.` |
| Evidence screenshot missing | `Screenshot unavailable.` with the link `Register page` |
| Public watch slots full | `All 4 public watch slots are in use. The next one frees on <date>.` |
| No status change recorded yet | `No status change yet. <n> records are watched.` |
| Public watch | `Watched until <date>. Its history is kept after that.` |

## What to check hardest

- A cached result shown as live. Expected: `stored result` and the real read time, on the card, the evidence line and the home.
- A pending check that never finishes (Agent run lost). Expected: the page stops refreshing after 3 minutes and says so; the hourly follow-up resolves it later.
- A name with markup or odd characters (`O'Brien`, `<b>`, right-to-left text). Expected: escaped, the layout holds.
- A visitor replaying the form post. Expected: the same pending or cached check, not a second paid run.
- A fresh deploy with nothing watched and no events. Expected: the home still opens, with the form, an honest empty feed and no broken product card.

## Routes

| Route | Screen |
|---|---|
| `GET /` | Home |
| `POST /check` | starts or reuses a check (same function as `POST /api/checks`), then `303` to `/checks/<id>` |
| `GET /checks/:id` | Result, every outcome and the pending state |
| `GET /checks/:id/receipt` | The verification receipt for a match: one printable page (Hamdan, 9 Nov 2026) |
| `GET /records/:id` | A watched or curated record with its history |
| `POST /records/:id/watch` | same function as the JSON route, then `303` back to the record |
| `GET /watchlist` | Watched records |
| `GET /coverage` | Registers, supported and not |
| `GET /api` | API page: endpoints, curl examples, the record schema |
| `GET /about` | How it works, the rules, limits, how TinyFish is used |

Navigation, in this order: Check, Watchlist, Coverage, API, About.

## File Structure

- `src/site/router.tsx` (routes, the switch, headers), `layout.tsx` (shell, nav, footer), `components.tsx` (record card, status word, field sheet, evidence panel, candidates table, change row, stat line), `format.ts` (dates, money, plural, copy constants), `htmlCache.ts` and `rebuild.ts` (stored copies; copied from `../fineprint/src/site/` and adapted, as the TinyFish clients were), `views/home.tsx`, `check.tsx`, `record.tsx`, `watchlist.tsx`, `coverage.tsx`, `api.tsx`, `about.tsx`, `notFound.tsx`.
- `public/assets/tokens.css`, `site.css`, `fonts/*.woff2`, `enhance.js`; `public/favicon.svg`, `public/robots.txt`.
- `DESIGN.md`, `design/PRINCIPLES.md`, `design/comp-home.html`, `design/comp-assets/ch-greggs.png`.
- Tests: `tests/site-*.test.ts`, one file per screen plus `site-shell.test.ts` and `site-cache.test.ts`.

---

### Task 1: Shell, assets, the look files and the home opening (ends at the look gate)

**Files:** create the `src/site/` shell files, `views/home.tsx`, `views/notFound.tsx`, `public/**`, `DESIGN.md`, `design/**`; move the design document to `docs/specs` and the plans to `docs/plans` (with this plan), fixing every link; modify `wrangler.jsonc`, `src/index.ts`, `src/env.ts`, `src/core/limits.ts`, `vitest.config.ts`. Test: `tests/site-shell.test.ts`, `tests/site-home.test.ts`.

**Interfaces:**
- Produces: `siteEnabled(env)`, `Layout({ title, active, children })`, `RecordCard({ record, check, compact? })`, `StatusWord({ outcome, status })`, `EvidenceLine({ record, check })`, `formatUtc(iso)`, `money(usd)`.
- Consumes: the functions behind `GET /api/stats`, `GET /api/events`, `GET /api/registries` and the newest curated or watched record with `outcome: "match"`.

- [x] **Step 1: Tests first.** Site off: `GET /` answers as before this plan. Site on: `/` is HTML with the security headers; the H1 is `The register's own answer, read a minute ago.`; the form posts to `/check` with fields `q`, `record_type`, `place`, `number`; the record card shows the seeded record's status word, the registry's own wording, name, number and an evidence line; a seeded cached check renders `stored result`, never `live`; with no record seeded the card is absent and the page still returns 200; no `http` URL to another host appears in the HTML.
- [x] **Step 2:** Run them red.
- [x] **Step 3:** Build the shell, self-host the fonts, write `site.css` from the comp's CSS, build the home opening exactly as the comp: kicker, H1, lede, form card, three example links (each a small form that posts preset values to `/check`: a GMC number, `Greggs PLC`, a Florida company such as `Publix Asset Management Company` (California contractors were dropped on 9 Nov: their licence pages cannot be read reliably by automated tools); they open stored results while those are fresh), live line (registers and countries counted from the adapters; checks run and status changes from stats), the record card on the right. The line under the form reads `Some registers answer in seconds. Those that need a real browser can take a minute or two.`- [x] **Step 4:** Green; `npm run check`.
- [x] **Step 5:** Commit `site: shell, static assets and the home opening`. Upload a preview. **Stop: compare it with the comp at 1280 and 390 wide.**

### Task 2: The check flow and the Result screen (ends at Hamdan's gate)

**Files:** create `views/check.tsx`; modify `router.tsx`, `components.tsx`, the checks handler (extract only). Test: `tests/site-check.test.ts`.

**Interfaces:**
- `POST /check`: form fields as in Task 1 plus optional `force=1`; calls the function behind `POST /api/checks`; `303` to `/checks/<id>`; invalid input re-renders the home form with a field error and status 400.
- `GET /checks/:id?w=<n>`: while `state = 'pending'`, the page carries `<meta http-equiv="refresh" content="3; url=/checks/<id>?w=<n+1>">` until `n` reaches 60, then the "still waiting" copy with no refresh. A finished check never carries the refresh tag.

- [x] **Step 1: Tests first**, one per outcome: match (status word class by status, field sheet rows in the registry's order, evidence panel with `/evidence/<id>.jpg`, evidence line, `Watch this record`, fresh-check link with the price from the method, `JSON` link); ambiguous (neutral `AMBIGUOUS`, the candidates table with `Verify this one` forms that post the candidate's number, no status colour anywhere); no match (variants tried, suggestions); unsupported; failed; pending waiting and pending running (refresh tag and its counter); pending at `w=60` (no refresh tag); every Honest-states string that applies; replaying the same form post returns the same check id.
  Receipt (`/checks/:id/receipt`, match only; any other outcome is a 404): one A4-shaped page with the heading `Verification receipt`, the status word, the register's own wording, name and number, the field sheet, the evidence screenshot, the evidence line, the line `Read from <Registry> on <date>. This receipt shows what the register said at that moment; check again for today's status.`, the check id and the address of the live result. A stored result says `stored result` here too. The match page links to it as `Receipt (print or save as PDF)`. A print stylesheet hides the navigation and buttons and keeps the page to one sheet. No new data is kept for it: a public check's receipt expires with the check after 24 hours, and the page says until when it stays available.
- [x] **Step 2:** Run them red.
- [x] **Step 3:** Implement. The match layout follows DESIGN.md: status word and name above a two-column grid (field sheet, evidence panel 360px), stacking under 900px. The receipt is the product's signature piece: set it with the same care as the home, and look at its print preview.
- [x] **Step 4:** Green; `npm run check`.
- [x] **Step 5:** Commit `site: the check flow and the result screen`. Run three real checks on the preview data (one Companies House match, one Companies House ambiguous name, one Agent-method match), and upload a preview. **Stop: look at the Result screen before Task 3 starts.**

### Task 3: Record page, watching and the watchlist

**Files:** create `views/record.tsx`, `views/watchlist.tsx`; modify `router.tsx`. Test: `tests/site-record.test.ts`, `tests/site-watchlist.test.ts`.

- [x] **Step 1: Tests first.** Record page: the current record card, the watch line (`Watching · Page monitor · next check 21:00 UTC` or the Topic form), the history as before-to-after rows newest first, each with its two read times; a status change row shows both status words in their colours. Watch form: `303` back with the watch shown; slots full shows the exact copy; a public watch shows its expiry copy. Watchlist: one row per watched record (status, registry, last check, last event, expiry), curated first, and the slots line `<used> of 4 public watch slots are in use`.
- [x] **Steps 2 to 4:** red, implement, green, `npm run check`.
- [x] **Step 5:** Commit `site: record history, watching and the watchlist`.

### Task 4: Coverage, API and About

**Files:** create `views/coverage.tsx`, `views/api.tsx`, `views/about.tsx`. Test: `tests/site-pages.test.ts`.

- [x] **Step 1: Tests first.** Coverage: every registry from the function behind `/api/registries`, supported and unsupported together, with country, record types, how it is looked up, how it is watched, and the reason for unsupported ones. API: each public endpoint with one curl example against `PUBLIC_BASE_URL`, the record schema, the three outcomes as short JSON samples taken from stored checks. About: how a check works in steps, the exact-name match rule in plain words, the fixed status set with each word's meaning, what is watched and how (Monitor is the only trigger for a re-check), what is kept and for how long (a public lookup nobody watches is deleted after 24 hours), the limits and the spending line, a table of the five TinyFish services with what each one does here and its spend from the ledger, and a `Source code` link shown only when `REPO_URL` is set.
- [x] **Steps 2 to 4:** red, implement, green, `npm run check`.
- [x] **Step 5:** Commit `site: coverage, API and About`.

### Task 5: The home proves itself, and stored copies

**Files:** modify `views/home.tsx`, `router.tsx`, `src/cron.ts`, the watch and webhook paths (invalidation calls only); adapt `htmlCache.ts`, `rebuild.ts`. Test: `tests/site-home.test.ts` (extended), `tests/site-cache.test.ts`.

- [x] **Step 1: Tests first.** Home below the opening, in the comp's order: the ambiguity block from a stored curated example (absent when there is none), `How a check works` (three steps naming the TinyFish services), `Status changes caught` (real events; with none, the exact empty copy), the registers grid from the adapters, and a block `Built for the TinyFish TinyVerify bounty` with one row per requirement and its live proof (registers and countries, a match with source link and screenshot, an ambiguous and a no-match example, the count of Monitors and events, the JSON endpoints) and a cost line (total spend and cost per check from the ledger). Stored copies: home, coverage, API, About, watchlist and watched or curated record pages are served from R2 with the cache header; a new event, a watch change and the hourly cron rebuild them; `/checks/:id` and any URL with a query string are never stored; a deploy starts a fresh set.
- [x] **Steps 2 to 4:** red, implement, green, `npm run check`.
- [x] **Step 5:** Commit `site: the home's proof and stored copies of the screens`.

### Task 6: Harden, audit, polish

- [x] A critique pass on every screen at 375px and 1280px against DESIGN.md and the comp; fix what it finds.
- [x] Accessibility: labels on every input, visible focus, contrast as DESIGN.md states, the status never carried by colour alone (the word is always there), headings in order.
- [x] Link-preview tags on every screen (`og:title`, `og:description`, `og:image`, `twitter:card`); `public/assets/social.png` at 1200x630, built from a real record card.
- [x] Measure CPU on the preview for a stored hit and for `/checks/:id`; report the medians. (Measured on production after Task 7: a preview's requests do not reach `wrangler tail`. Stored hit 1 to 2 ms; `/checks/:id` 13 ms.)
- [x] `npm run check`; commit `site: audit and polish`. Upload the final preview. **Stop: look at the final preview.**

### Task 7: Switch the site on (on Hamdan's go-ahead only)

- [x] Set `SITE_ENABLED` to `"1"`, commit, deploy after the final look, verify each route and the JSON API, record the version id in `docs/build-log.md`.

### Task 8: The submission package

- [ ] `README.md` in the order Fineprint's uses: what it is with a hero image, the live URL, three things to click, how it works, how TinyFish is used (the table, true line by line), the requirements with where to see each, run it locally, limits. Figures dated.
- [ ] `docs/submission.md`: the real form's fields (one link, notes for reviewers within 2,000 characters, the X and LinkedIn post links, up to five media files) with paste-ready text. `docs/posts.md`: the X post within 280 characters tagging `@Tiny_Fish`, the LinkedIn post tagging the TinyFish company page. `docs/demo-script.md`: seven shots for a captioned video made from screenshots.
- [ ] **Before the repository goes public:** tidy the documents, publish as a fresh repository with the procedure used for Fineprint, set `REPO_URL` and check the About link, tag `v1.0.0`.
