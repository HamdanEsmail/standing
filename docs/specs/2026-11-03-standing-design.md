# Standing: design

*Working name ("in good standing"). Submission for the TinyFish Student Bounty Drop 002 "TinyVerify" bounty. Written 2026-11-03. Deadline 2026-11-17. First user: a hiring manager checking a person's professional licence; second: a compliance or procurement team checking a business or contractor.*

## 1. Intent

Is this doctor licensed? Is this nurse still on the register? Is this solicitor allowed to practise? Is this company still registered, is this contractor's licence active? Answering means digging through licensing boards and business registries that have no APIs. Standing takes a person or business name, a record type and a place, finds the record on the official register with TinyFish, and returns one structured, verified record: status, registration number, dates, disciplinary history, a link to the source, a screenshot of the register page as it was read, and the exact time it was read. When the register is deep-linkable, Standing watches the record with TinyFish Monitor and flags status changes. When there are several matches or none, it says so and never guesses.

Judges weigh: accuracy against the official registry; coverage (registries, record types, places); ambiguity handling (no match, several matches, name variants); reliable Monitor flags on status change; trust (every result shows source and checked time in a reusable format). "A check a hiring manager or compliance team would rely on without redoing it by hand."

Approval criteria, verbatim: results come live from the official source with a link to prove it; status and numbers match the registry; no match or several matches are handled clearly instead of guessing; works for different people, businesses and places, not a hardcoded few; output is structured and reusable by other tools.

## 2. Goals, non-goals, anti-goals

**Goals**
- Six registries across two countries at launch, three of them the hiring-manager set (UK doctors, nurses and midwives, solicitors), three for businesses and contractors (UK companies, California contractors, California licensed professionals). Any name, any record in those registries, not a fixed list.
- One record schema for every registry, with `status` normalized to a fixed set and every raw field kept.
- Evidence on every result: source URL, screenshot of the register page from the Agent run, `checked_at` as the moment the register was actually read.
- An ambiguity contract (section 4.5) that a hiring manager can act on: candidates with distinguishing fields, or the exact variants tried.
- Monitor watches: record pages where they exist; regulator decision pages and per-person topic monitors where they do not. A status change becomes an event with before and after, visible in the UI, the API and a webhook of the caller's choosing.
- Caching so a repeated demo costs nothing, with a visible "force fresh check" that shows its cost.
- Budget about $5 of TinyFish wallet for build, demo and the live run.

**Non-goals**
- Bulk checks, CSV upload, or "verify my whole team". One lookup per request.
- Identity verification of the person asking, or matching a CV to a record.
- Registries behind a login or a CAPTCHA that TinyFish cannot pass. They go in the coverage table as "not supported" with the reason.
- Storing anything beyond what a result needs. No document uploads, no personal data of the requester.

**Anti-goals**
- Returning a `status` when more than one record could be the person. Ambiguous means no top-level status.
- Guessing a record from a partial match or a sound-alike name.
- Our own polling loop presented as "monitoring". Monitor (Page or Topic) is the trigger for every re-check of a watched record.
- Serving a cached result as "live" without the real `checked_at`.
- A hardcoded demo set that fails on a new name.

## 3. Constraints and verified facts

Verified on 2026-11-03 with real calls; scripts and responses in `../spikes/` (`spike-registries.mjs`, `spike-registry-urls.mjs`, `spike-gmc-agent.mjs`, `out/registries.json`, `out/registry-urls.json`, `out/gmc-agent-run.json`, `out/gmc-record-fetch.json`).

**Registries (free TinyFetch reachability, then one paid Agent run)**
- UK General Medical Council (doctors): the search is an in-page app at `https://www.gmc-uk.org/registration-and-licensing/the-medical-register`. A TinyAgent run with `browser_profile: "stealth"`, an explicit goal and an `output_schema` searched for a name, opened the entry and returned `{full_name, gmc_number: "9360749", status: "Registered with a licence to practise", entry_url: "https://www.gmc-uk.org/registrants/9360749", fitness_to_practise_history: false, results_found: 1}` in 8 steps, 78 s, about $0.13. The record URL pattern is `https://www.gmc-uk.org/registrants/<gmc number>`; a made-up number returns 404; the `/doctors/` path is bot-blocked. **TinyFetch reads a real record page** (2,680 chars of markdown with name, number, status, registers, specialties), so GMC records are both lookup-able and Monitor-able. A second Agent run (`out/gmc-conditions-run.json`, 11 steps, $0.18) for a doctor with conditions returned `sanctions_text: "This registrant has conditions (details available in history tab)"` and the entry URL; TinyFetch of that page (`out/gmc-conditions-fetch.json`, 9,743 chars) renders the **full conditions text** ("Conditions on the registrant's registration From 16 Oct 2026, 1. She must personally ensure the GMC is notified ..."), so a Page monitor on a GMC record sees sanctions appear, change and lapse. A third run for a surname with two registrants returned `results_found: 2` with both names and opened neither, exactly as the goal instructed: the ambiguity contract is enforceable at the Agent level.
- UK Nursing and Midwifery Council (nurses, midwives, nursing associates): `https://www.nmc.org.uk/registration/search-the-register/` is readable but the search is an in-page app with no per-record URL found by Fetch links or TinySearch. Lookup via Agent; watch via Topic monitors and the NMC hearings page (section 4.6).
- UK Solicitors Regulation Authority (solicitors): `https://www.sra.org.uk/consumers/register/` readable; guessed person and organisation URL patterns return 404; no per-record URL found. Lookup via Agent; watch via Topic monitors and the SRA decisions page.
- UK Companies House: company pages (`.../company/<number>`) and officer pages (`.../company/<number>/officers`) are readable by Fetch with no bot wall (10,156 chars for officers). Fully deep-linkable and Monitor-able. Search results page is GET-shaped (`/search/companies?q=`), also readable.
- California Contractors State License Board (CSLB): landing readable; the `LicenseDetail.aspx?LicNum=` pattern needs a real licence number (a made-up one returns the search page). Agent for name search; Fetch for a known number; Monitor-able once a real detail URL is confirmed in the build.
- California Department of Consumer Affairs (DCA) licence search: `https://search.dca.ca.gov/` readable (11,667 chars); detail URLs need real IDs. Same treatment as CSLB.
- Also readable, available as stretch registries: UK Care Quality Commission search, UK Gas Safe, UK Charity Commission, Florida DBPR, Texas TDLR, Florida Sunbiz, California Secretary of State business search.
- Not supported, with reason: UK FCA register (`target_unreachable`), New York Office of Professions (`target_http_error`), New York DOS corporations (`empty_content`), Dubai DHA Sheryan (JavaScript app, reads as "Home"). The coverage page lists these honestly.

**TinyAgent**
- Explicit goals with field lists work; vague goals return empty objects (seen in the Fineprint spike). `output_schema` is accepted on this account. Cost $0.016 per step; the GMC lookup took 8 steps. Cap lookups at `max_steps: 12` ($0.19 max). Account allows 2 concurrent runs **shared with the Fineprint build**, so 429 `RATE_LIMIT_EXCEEDED` is expected under load and is retried with backoff, never shown as a failure.
- Step screenshots exist on `GET /v1/runs/{id}?screenshots=url` and the API-key binary endpoint `GET /v1/runs/{id}/steps/{stepId}/screenshot` serves JPEG. The last step that shows the record page is the evidence screenshot.
- `webhook_url` on a run calls back on completion, so lookups are asynchronous: the API returns a check id immediately and the result arrives by callback or polling.

**TinyFetch**: free within 1,000 URLs per day; reads record pages (GMC, Companies House) and search-results pages that are GET-shaped. Used to read a record once its URL is known, which makes repeat reads free and deterministic.

**TinySearch**: `GET https://api.search.tinyfish.ai?query=&include_domains=`, free. Used for name-variant discovery (public references that give a middle name or a registration number) and to find a registry's decision pages.

**TinyFish Monitor** (facts verified in the Fineprint spike, `../spikes/spike-monitor.mjs`): Page monitors fetch a fixed URL on a cron and webhook every scheduled run with `outcome`, a unified `diff` and a `judgment` against a `purpose`; Topic monitors re-run a search query and report `new_result_positions`, at least 30 minutes apart. No run-history endpoint; `PATCH` edits must include `schedule_cron`; run-now does not fire webhooks; $0.005 per check; **Standing may hold at most 10 monitors** (account allocation: Fineprint 24, Standing 10, Property Dossier 10, Site to MCP 2, spare 4).
- **Topic monitors verified on this account** (`../spikes/spike-topic-monitor.mjs`, `out/monitor-topic-create.json`): `POST /v1/monitors` with `type: "search"`, `config: {query, recency_minutes: 1440, result_limit: 5}` returned 201 with `monitor.config` echoed and `run: {id, request_id, query, status_code, result_count, results[], new_result_positions[], created_at}`. One paused spike Topic monitor (`7bd84544-721f-4f3f-acb9-ae84f4ffb4c7`) and one paused Page monitor from the Fineprint spike (`e92c04d7-...`) exist on the account; neither counts against Standing's 10 and neither may be deleted by this build.
- The doctors' tribunal site (mpts-uk.org) is **bot-blocked for Fetch**, so GMC has no shared decision-page monitor; GMC watching relies on the record page, which renders conditions (above). NMC and SRA decision pages must be verified with one free Fetch each in the first task; if either is blocked, that registry's watch is Topic-monitor only and the coverage table says so.

**TinyBrowser**: `POST https://api.browser.tinyfish.ai` plus raw CDP from the Worker, verified in `../spikes/worker-shot/src/index.js`, $0.002 per screenshot. Used so Fetch-method results (Companies House, number lookups) also carry a screenshot of the page as read.

**Cloudflare**: same stack and limits as Fineprint (Workers free plan, 10 ms CPU per request, D1, R2, Cron Triggers). Account is ready: R2 enabled, token with D1 and R2 permission in the parent folder's `.cloudflare.env`.

**Registry terms of use**: these registers are public, and their terms typically forbid bulk or automated extraction. Standing's posture, stated on the About page: one lookup per request, no bulk, results cached 24 hours so repeated questions don't repeat reads, modest rate limits, and only the fields a verification needs are stored.

## 4. Architecture

One Cloudflare Worker (Hono) with D1 and R2, serving the API, the Monitor and Agent webhook receivers, and the React viewer as static assets. Same conventions as Fineprint; same family design system (`DESIGN.md` at the repo root, accent `#1b7a4e`, stamp VERIFIED LIVE).

```
POST /api/checks {name|number, record_type, jurisdiction}
   |  normalize name, pick registry adapter, cache lookup (24 h)
   v
 cache hit? ----yes----> result (with the original checked_at, "cached" flag, force-fresh link)
   | no
   v
 number given and registry has a record URL pattern?
   | yes: TinyFetch record page (free) -> parse -> record          | no:
   v                                                                v
 TinyAgent search run (stealth where needed, output_schema, webhook_url = /hooks/agent/<secret>)
   v
 callback -> classify: one match | several | none
   one: record (fields from schema; if a record URL exists, TinyFetch it and prefer those fields),
        evidence screenshot from the run's last record-page step -> R2 evidence/<check>.jpg
   several: candidates[] with distinguishing fields, no top-level status
   none: variants_tried[], suggestions
   v
 POST /api/records/:id/watch -> Monitor: Page monitor on the record URL (GMC, Companies House, CSLB, DCA)
                                 or Topic monitor on the person (NMC, SRA) + shared regulator decision-page monitors
   v
 POST /hooks/monitor/<secret> -> changed? -> re-read record (TinyFetch if URL, else one Agent run) -> event {before, after}
```

### 4.1 Registry adapters

Each registry is one TypeScript module implementing the same interface: `id`, `country`, `recordTypes`, `searchUrl`, `recordUrlPattern` (or null), `browserProfile` (`lite` | `stealth`), `goal(query)` (the exact Agent goal text with the field list), `outputSchema`, `parseRecordPage(markdown)` (for registries with a record URL), `normalizeStatus(raw)` to the fixed status set, `decisionPages[]` (regulator pages worth a shared Page monitor), `topicQuery(record)` (for Topic monitors). Adding a registry is adding one module and one row in the coverage table. The six launch adapters: `gmc`, `nmc`, `sra`, `companies-house`, `cslb`, `ca-dca`.

### 4.2 Name normalization

Before any lookup: trim; strip titles and honorifics (Dr, Mr, Mrs, Ms, Prof, Sir, Dame, Esq, MD, MBBS, PhD); reorder "SURNAME, Given" to "Given SURNAME"; collapse whitespace; keep hyphens and apostrophes; record `given`, `middle` (optional), `surname`. For businesses: case-fold, strip punctuation, normalize suffixes (LTD = LIMITED, PLC, LLP, INC, LLC, CO = COMPANY).

**One Agent run per check.** The run's goal lists the variants to try in order inside that one run (full name; given + surname; surname + initial; surname only where the registry supports it, which GMC does), tells the agent to stop at the first variant that returns results, and the `output_schema` carries `variants_tried[]`, `results_found`, and `rows[]` (up to 10 rows with name, number, status text and the registry's distinguishing field such as location, specialty or register part). The agent opens an entry **only when the match rule in 4.5 holds**, never "the first result". So a check costs one run, capped at 12 steps ($0.19), and `estimated_cost_usd` is honest. A registration number in the input skips the name search: Fetch of the record URL where a pattern exists, otherwise an Agent run that searches by number. Resolving an ambiguous result by number is a second check, free when the registry has a record URL.

### 4.3 The record schema (every registry, every result)

The name and number below are invented for the example.

```json
{
  "check_id": "…", "registry": "gmc", "registry_name": "General Medical Council", "country": "GB",
  "record_type": "doctor", "outcome": "match" | "ambiguous" | "no_match" | "unsupported" | "error",
  "status": "active" | "conditions" | "suspended" | "removed" | "not_licensed" | "expired" | "dissolved" | "insolvency" | "unknown",
  "flags": ["proposal_to_strike_off"],
  "status_raw": "Registered with a licence to practise",
  "full_name": "Ada Example FICTITIOUS", "licence_number": "9999999",
  "registered_since": "2001-08-01" | null, "expiry_date": null, "disciplinary_actions": [], "restrictions": [],
  "specialties": ["General surgery"], "raw_fields": {…},
  "source_url": "https://www.gmc-uk.org/registrants/9999999",
  "evidence_screenshot_url": "https://…/evidence/<check>.jpg",
  "checked_at": "2026-11-05T09:22:55Z", "cached": false, "method": "agent" | "fetch",
  "candidates": [], "variants_tried": ["Ada Fictitious"], "watch": null | {"watch_id": "…", "kind": "page" | "topic"},
  "spend_usd": 0.128
}
```

`status` is one fixed set for people and businesses: `active` (registered and allowed to practise or trade), `conditions` (active with conditions, undertakings or restrictions), `suspended`, `removed` (struck off, erased, revoked, cancelled), `not_licensed` (registered without a licence, not practising, retired, lapsed registration), `expired`, `dissolved`, `insolvency` (liquidation, administration, receivership), `unknown`. `flags[]` carries secondary facts that are not a status: `proposal_to_strike_off`, `interim_order`, `under_review`, `name_changed`. Mapping is per adapter, tested against every raw status seen in fixtures, and shown on the coverage page; anything unmapped is `unknown` with `status_raw` kept. Examples: GMC "Registered with a licence to practise" → `active`; GMC "Registered with a licence to practise" plus a conditions block → `conditions`; GMC "Registered without a licence to practise" → `not_licensed`; Companies House "Active" → `active`; "Active — Proposal to strike off" → `active` + flag; "Dissolved" → `dissolved`; "Liquidation" → `insolvency`. `disciplinary_actions[]` entries are `{date, summary, source_url}`; for GMC the Fetch-read conditions text becomes one entry per conditions block with its "From" date. For businesses, `full_name` is the registered name and `record_type` is `company` or `contractor`. The enum is part of the public contract and does not change after launch; new cases map to the nearest value with `status_raw` kept.

### 4.4 Checks API

- `POST /api/checks` body `{query: string, record_type: "doctor" | "nurse" | "solicitor" | "company" | "contractor" | "professional", jurisdiction: "GB" | "US-CA", number?: string, profession?: string, fresh?: boolean, callback_url?: string}` → 202 `{check_id, status: "pending" | "done", cached: bool, estimated_cost_usd}`. `nurse` covers nurses, midwives and nursing associates; the register part comes back in `raw_fields.register_part`. `profession` is the board or licence type for `professional` lookups (California DCA licenses are keyed by board and type, so a DCA number lookup requires it; a DCA name search without it spans all boards and reports the board as the distinguishing field in `candidates[]`). Unsupported `record_type` for that `jurisdiction` → 400 `{error: "unsupported", supported: [...]}`. `fresh: true` bypasses the 24-hour cache and the response says what it will cost.
- `GET /api/checks/:id` → the record schema above, or `{status: "pending", started_at, run_id}`.
- `GET /api/records/:id` and `GET /api/records/:id/history` → the current record and its events (`{at, kind: "status_change" | "notice" | "recheck", before, after, source_url, monitor_run_id}`).
- `POST /api/records/:id/watch` → creates the Monitor(s) in 4.6 → 201 `{watch_id, kind, next_check}`. `DELETE` removes them.
- `GET /api/registries` → the coverage table exactly as the About page shows it: registry, country, record types, lookup method, watch method, supported or not with reason, last successful check time.
- `GET /api/events?since=` → status changes across all watched records.
- `GET /api/export.json` → every record and event with absolute evidence URLs.
- Public rate limit: 25 checks per IP per day (5 at first; raised on 9 Nov, see the build log), 2 watches per IP; admin token lifts both. Every TinyFish call appends to the spend ledger; `/api/stats` and the footer show total and cost per check.

### 4.5 Ambiguity contract

- **Several matches**: `outcome: "ambiguous"`, no `status`, `candidates[]` each with `{licence_number, full_name, status_raw, location | specialty | registered_since, source_url}` as the registry shows them, plus `how_to_resolve: "Repeat the check with number=<…>"`. A second call with `number` resolves to one record. Candidates are capped at 10 with `candidates_total`.
- **No match**: `outcome: "no_match"`, `variants_tried[]` in the order searched, `suggestions[]` (for example "try the registration number", "the NMC search needs the exact surname"). Never a `status`.
- **One match, the rule**: `outcome: "match"` when the input number resolved directly, or the registry returned one or more rows and **exactly one** row's normalized registered name equals the normalized query (case-folded, punctuation stripped, business suffixes normalized; a query without a middle name matches a row with one, a query with a middle name must match it). A single returned row whose name fails that rule, whichever search variant produced it (so "fictitious a" returning "Alice FICTITIOUS" for "Ada Fictitious"), is `ambiguous` with that one candidate (`candidates_total: 1`, `how_to_resolve` pointing at the number), never a `match` (decided 3 Nov). Companies House search is fuzzy and returns many rows for most names, so the exact-name case is how a company becomes a `match`. Two rows with the same normalized name are `ambiguous`, even if one looks more likely.
- **Unsupported**: `outcome: "unsupported"` with the coverage-table reason.
- The UI mirrors this: ambiguous results are a candidate list with "verify this one" buttons; no-match results show the variants tried.

### 4.6 Watching with Monitor

- **Record page watch** (GMC, Companies House, CSLB, DCA): one Page monitor on the record URL, every 12 hours, `purpose`: "The registration or licence status, restrictions, conditions, or disciplinary history of this registrant changed. Ignore timestamps and layout." On a `changed` webhook, re-read the page with TinyFetch, re-parse, compare the record's normalized fields, and if anything in `status`, `restrictions` or `disciplinary_actions` differs, write a `status_change` event with before and after and call the caller's `callback_url` if one was given.
- **Person topic watch** (NMC, SRA): one Topic monitor with the adapter's `topicQuery` (for example `"<full name>" nurse NMC hearing OR sanction OR struck off`), `recency_minutes: 1440`, `result_limit: 5`, every 12 hours. New URLs become a `notice` event with the URL, and trigger one Agent re-check of the record (Monitor-triggered, never scheduled by us).
- **Shared regulator decision pages**: one Page monitor each on the NMC recent hearing outcomes page and the SRA recent decisions page, every 12 hours, created once at deploy. On `changed`, the diff is scanned for every watched person's surname; a hit creates a `notice` event and triggers the same single Agent re-check. These two monitors are the watch mechanism for registries without record URLs, and the coverage table says exactly that.
- Allocation of the 10 monitors: 2 shared decision pages; 8 watch slots (4 curated demo records that stay for the live run, 4 public slots that expire after 7 days, Monitor deleted and history kept).
- Judges' approval item 4 and rubric item 4 are satisfied only by Monitor-triggered re-checks. No timer of the Worker reads again a record someone looked up or watches. *(Changed 14 Nov 2026: this said "The Worker has no cron that reads registries". The hourly run now also makes a daily reader check, which reads one fixed business record on each register Standing reads with Fetch, once a UTC day, to test Standing's own readers. It writes nothing to checks, records, events or watches, and keeps no evidence. See `src/readerCheck.ts` and the build log.)*
- **Making a real status change likely before 2026-11-17.** Genuine changes on professional registers are rare, so the four curated watches are chosen on deploy day for likely movement inside the window, all from public notices: (1) a GMC doctor whose tribunal hearing is scheduled within the window (hearing dates are public; find them with TinySearch since the tribunal site blocks Fetch), so the record page gains or changes a conditions or suspension block when the outcome is recorded; (2) a Companies House company showing "Active — Proposal to strike off" with a Gazette notice older than two months, which dissolves on a predictable schedule; (3) an NMC registrant with a scheduled hearing (Topic monitor plus the hearings page); (4) an SRA solicitor with a listed Solicitors Disciplinary Tribunal date. Independently of those, the two shared decision pages change every week and produce real `notice` events. The README's monitor log reports whatever Monitor caught, including "no change" runs; nothing is simulated. Watches start on deploy day and run until submission.

### 4.7 Evidence

Every `match` stores a screenshot of the record page as `evidence/<check id>.jpg` in R2 and serves it at `/evidence/<id>.jpg`: for Agent-method checks, the last step screenshot that shows the record page (downloaded with the API-key binary endpoint); for Fetch-method checks, a TinyBrowser full-page screenshot of the record URL ($0.002, the Fineprint CDP routine). Fetch-method checks also keep the markdown read as `evidence/<check id>.md`. `checked_at` is the Agent run's `finished_at` or the Fetch call time. The UI shows the screenshot in the result card with "as read by TinyFish at …". Every result therefore has an image, a link and a time.

**Retention.** A record created by a public check that nobody watches expires with its 24-hour cache: an hourly job deletes the check, its candidates and its evidence objects. The home feed, `/api/events` and `/api/export.json` include only watched records and the curated examples, never one-off public lookups. The About page says this in one sentence. Watched records keep their history until the watch is removed.

### 4.8 Viewer (behavior; visual world is the family DESIGN.md)

- **Home**: the check form (name or number, record type, place), three example chips that run real checks, and the recent events feed. Stat blocks: checks run, records watched, status changes caught, spend.
- **Result**: a stamped record card (status chip, name, number, dates, specialties, disciplinary list), the evidence screenshot, the evidence line (source link, checked time, method, cached or live), a "watch this record" button, and a "force fresh check ($0.19)" link. Ambiguous and no-match states as in 4.5.
- **Watchlist**: watched records with status, last check, last event; expiry shown for public watches.
- **Coverage**: the registries table from `/api/registries`, including unsupported ones with reasons.
- **API**: endpoint list with curl examples and the record schema.

## 5. Data model (D1)

```
checks     id, registry, record_type, jurisdiction, query_raw, query_normalized, number, variants_tried (json), outcome,
           status, record_id, run_id, method, cached_from_check_id, evidence_key, spend_usd, started_at, checked_at, error
records    id, registry, licence_number, full_name, status, status_raw, fields (json), source_url, evidence_key,
           first_seen_at, last_checked_at, normalized_hash
candidates check_id, position, licence_number, full_name, status_raw, detail, source_url
watches    id, record_id, kind (page|topic), monitor_id, added_by (curated|public|admin), expires_at, created_at, status
events     id, record_id, kind (status_change|notice|recheck), before (json), after (json), source_url, monitor_run_id, at
monitors_shared  registry, monitor_id, url, created_at
spend      id, kind, amount_usd, ref, at
public_use ip_hash, day, checks, watches
```

Cache key: `(registry, record_type, query_normalized or number)` with `checked_at` within 24 hours.

## 6. Coverage at launch

| Registry | Country | Record types | Lookup | Watch | Notes |
|---|---|---|---|---|---|
| General Medical Council | GB | doctor | Agent (stealth) search, Fetch record page | Page monitor on record URL | verified 2026-11-03 |
| Nursing and Midwifery Council | GB | nurse, midwife, nursing associate | Agent search | Topic monitor + shared hearings page | no per-record URL |
| Solicitors Regulation Authority | GB | solicitor | Agent search | Topic monitor + shared decisions page | no per-record URL |
| Companies House | GB | company | Fetch (GET search + record pages) | Page monitor on company page | no Agent needed; officers are not a launch record type |
| CA Department of Consumer Affairs | US-CA | professional (many boards) | Agent search, Fetch detail page | Page monitor on detail URL | detail URL `/profile/<board>/<type>/<number>/` confirmed in build; a number lookup needs a profession with a confirmed licence code |
| Florida Division of Corporations (Sunbiz) | US-FL | company | Fetch (GET name search with links, record page from the matched row) | Page monitor on the record page | added 9 Nov 2026; lookups by name (a record address cannot be built from the document number) |
| Not supported: FCA register (unreachable), NY Office of Professions (HTTP error), NY DOS (empty), Dubai DHA (JavaScript app), CA Contractors State License Board (licence page cannot be read reliably by automated tools; dropped 9 Nov 2026), Medical Council of New Zealand (a doctor's own page shows no status to automated reads) | | | | | shown with reasons |

Stretch, in order, if time allows: Care Quality Commission (GB, care providers), Florida DBPR (US-FL), Texas TDLR (US-TX), Gas Safe (GB).

## 7. Security and safety

- Secrets as Worker secrets: `TINYFISH_API_KEY`, `ADMIN_TOKEN`, `WEBHOOK_SECRET`. Webhook paths carry the secret; Agent callbacks are matched to a known `run_id`; Monitor payloads to a known `monitor_id`.
- Caps in one constants file: `AGENT_MAX_STEPS = 12`, `MAX_MONITORS = 10`, `PUBLIC_CHECKS_PER_IP_PER_DAY = 5`, `PUBLIC_WATCH_SLOTS = 4`, `PUBLIC_WATCH_TTL_DAYS = 7`, `CACHE_HOURS = 24`, `SPEND_PAUSE_USD = 4` (lowered from 8 on 9 Nov), `PUBLIC_AGENT_CHECKS_PER_DAY = 8` (public checks a UTC day that start an Agent run, across every caller).
- No bulk endpoint. No storage of requester data beyond a hashed IP for rate limits.
- Public watches expire; curated watches are the four records in 4.6, chosen on deploy day.
- **Who may be named**: no real person is named in any committed file. Test data is recorded from the public registers and then edited: every person's surname and personal number is replaced with an invented one (`tests/fixtures/registries/README.md`). Registered businesses keep their names. On the live site the watched people I chose appear by registration number only (`docs/curated-watches.md`); a visitor's own check shows what the register shows them.

## 8. Testing

- Unit tests: name normalization and variant order; status mapping per adapter (every raw status seen in fixtures maps to the fixed set); record-page parsers (GMC and Companies House markdown fixtures from the spikes); the ambiguity classifier; cache key and 24-hour window; monitor webhook handling (changed vs unchanged, decision-page surname scan).
- Fixtures are real: `../spikes/out/gmc-agent-run.json`, `gmc-record-fetch.json`, `registries.json`, and the first real Agent and Monitor payloads recorded during the build.
- Tests never call TinyFish. One opt-in integration test per adapter runs a real lookup and asserts the schema, not the values; who it looks up is given in the shell, never written in the test.
- `npm run check` = typecheck, tests, `wrangler deploy --dry-run`; GitHub Actions on push.

## 9. Delivery order

1. Scaffold, schema, adapters interface, GMC and Companies House adapters (one Agent-based, one Fetch-based), checks API with cache and evidence, callback handling. Deploy. Verify two real lookups end to end.
2. NMC, SRA, CSLB, DCA adapters; ambiguity contract tested against real ambiguous names (common surnames); coverage endpoint; watches with Page and Topic monitors; shared decision-page monitors; Monitor webhook and events.
3. Viewer on the family design system; README with the coverage table, "how TinyFish Agent, Fetch, Search and Monitor are used", three recorded demo checks (match, ambiguous, no match) with evidence screenshots; demo GIF; post drafts.

Live Agent calls during the build wait until Fineprint's 20-page registration has finished (shared 2-run limit).

## 10. Left open for the build

- Exact Agent goal wording per adapter, as long as each names its fields and the variant searched.
- Which step is "the record page" for the evidence screenshot (the last step whose action mentions the entry, or the final step).
- The two regulator decision-page URLs (verify with Fetch; TinySearch can find them).
- Parser details for Companies House and GMC markdown.
- Project layout, router (Hono suggested), diff of record fields for events.

## 11. Repository conventions

Same as Fineprint: TypeScript, ESM, exact pins, `npm run check`, `.dev.vars.example`, MIT, `docs/` with this design and the plan, `artifacts/` for screenshots and the demo GIF, README opening with what it does, the live URL and the "How TinyFish is used" table. `DESIGN.md` and `design/tokens.css` come from `../family/` with the TinyVerify accent. Private on GitHub until submission day.
