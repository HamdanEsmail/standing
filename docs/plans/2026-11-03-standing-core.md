# Standing Core (checks, adapters, watches, API) Implementation Plan

> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Standing's verification core on one Cloudflare Worker: six registry adapters, the checks API with the ambiguity contract and evidence, Monitor-based watches with status-change events, and the public read API, ready for a live run and a viewer.

**Architecture:** A Hono app on Cloudflare Workers with D1 and R2. `POST /api/checks` normalizes the query, consults a 24-hour cache, then either reads a record page with TinyFetch (number known, registry has a URL pattern) or starts one TinyAgent run whose callback classifies the result as match, ambiguous or no_match. Matches get an evidence screenshot (Agent step or TinyBrowser) in R2. Watches create TinyFish Monitors (Page on record URLs, Topic on names) plus two shared regulator decision-page monitors; Monitor webhooks trigger re-reads that become events. No cron ever reads a registry.

**Tech Stack:** TypeScript (ESM, strict), Hono, Cloudflare Workers + D1 + R2 + Cron Triggers, Vitest with `@cloudflare/vitest-pool-workers`, Wrangler 4. Same conventions as the sibling repo `../fineprint`; where Fineprint already has a tested module with the same job (TinyFish HTTP client, Monitor client, TinyBrowser screenshot, spend ledger, admin auth), copy it in and adapt rather than rewrite.

**Spec:** `docs/specs/2026-11-03-standing-design.md`. Read it first; this plan argues from it. Spike scripts and real responses are in `../spikes/` (`out/gmc-agent-run.json`, `out/gmc-conditions-run.json`, `out/gmc-conditions-fetch.json`, `out/gmc-record-fetch.json`, `out/monitor-topic-create.json`, `out/registries.json`, `out/registry-urls.json`).

## Global Constraints

- Node `>=24`, `"type": "module"`, `"private": true`, exact version pins (`npm view <pkg> version`). `npm run check` = `tsc --noEmit && vitest run && wrangler deploy --dry-run`, green at the end of every task.
- Secrets only via Worker secrets / `.dev.vars`: `TINYFISH_API_KEY`, `ADMIN_TOKEN`, `WEBHOOK_SECRET`. `.dev.vars.example` lists all three.
- Constants in `src/core/limits.ts`: `AGENT_MAX_STEPS = 12`, `AGENT_MAX_DURATION_SECONDS = 160`, `MAX_MONITORS = 10`, `SHARED_MONITORS = 2`, `CURATED_WATCH_SLOTS = 4`, `PUBLIC_WATCH_SLOTS = 4`, `PUBLIC_WATCH_TTL_DAYS = 7`, `PUBLIC_CHECKS_PER_IP_PER_DAY = 5`, `PUBLIC_WATCHES_PER_IP = 2`, `CACHE_HOURS = 24`, `PUBLIC_RECORD_TTL_HOURS = 24`, `CANDIDATES_MAX = 10`, `SPEND_PAUSE_USD = 8`.
- Prices in `src/core/spend.ts`: `agent_step 0.016`, `monitor_check 0.005`, `screenshot 0.002`, `fetch 0`, `search 0`.
- Status enum, exactly: `active | conditions | suspended | removed | not_licensed | expired | dissolved | insolvency | unknown`. Flags: `proposal_to_strike_off | interim_order | under_review | name_changed`. Outcomes: `match | ambiguous | no_match | unsupported | error`.
- Every TinyFish call goes through `src/tinyfish/client.ts`. A 429 `RATE_LIMIT_EXCEEDED` from the Agent API waits 60 s and retries up to 3 times before failing the check with `error: "busy"`.
- No bulk endpoint. No cron that reads a registry. Only Monitor webhooks trigger re-checks.
- Live TinyFish calls during the build: the opt-in integration tests only, each under $0.20, total under $1.50, every call logged in `docs/build-log.md`. They wait until the Fineprint registration is finished, because both builds share the account's limit of two Agent runs at once.
- Deploy and remote D1/R2 creation come last, after the core passes its checks. The repository and `origin` exist before Task 1.

## What to check hardest

1. Two registrants with the same normalized name must yield `ambiguous` with both candidates and no top-level `status`, even when one has a licence and the other does not. Test in Task 2 and Task 7.
2. A cached result must carry the original `checked_at` and `cached: true`; `fresh: true` must bypass it and record new spend. Test in Task 7.
3. A Monitor `changed` webhook whose re-read shows the same normalized status and conditions must produce a `recheck` event, not a `status_change`. Test in Task 9.
4. A public check that is never watched must be gone (rows and R2 evidence) after 24 hours, and must never appear in `/api/events` or `/api/export.json`. Test in Task 10.
5. Agent callback for an unknown `run_id`, or a duplicate callback for a completed check, must be a 200 no-op that changes nothing. Test in Task 7.

---

## File Structure

```
standing/
  package.json  tsconfig.json  wrangler.jsonc  vitest.config.ts  .dev.vars.example  LICENSE  README.md
  DESIGN.md  design/tokens.css           (already present, from ../family)
  migrations/0001_init.sql
  src/index.ts                            Hono wiring + scheduled export
  src/env.ts                              Env bindings
  src/core/limits.ts  src/core/spend.ts
  src/core/names.ts                       normalizePerson, normalizeBusiness, variantsFor, namesEqual
  src/core/status.ts                      Status, Flag, Outcome types; applyStatusMap
  src/core/classify.ts                    classifyRows -> match | ambiguous | no_match
  src/core/schema.ts                      RecordResult type + toPublicRecord()
  src/registries/types.ts                 RegistryAdapter interface, RegistryRow
  src/registries/index.ts                 registry lookup by (jurisdiction, record_type)
  src/registries/gmc.ts  nmc.ts  sra.ts  companies-house.ts  cslb.ts  ca-dca.ts
  src/tinyfish/client.ts fetch.ts agent.ts search.ts monitor.ts browser.ts
  src/db/types.ts checks.ts records.ts watches.ts events.ts spend.ts publicUse.ts
  src/auth.ts
  src/checks/run.ts                       startCheck(), resolveFromRows(), finishCheck()
  src/checks/evidence.ts                  storeAgentEvidence(), storeFetchEvidence()
  src/handlers/checks.ts  records.ts  watches.ts  webhooks.ts  registries.ts  admin.ts  objects.ts  stats.ts
  src/cron.ts
  scripts/init-shared-monitors.mjs  scripts/curate-watches.mjs
  tests/fixtures/{tinyfish,registries,webhooks}/  tests/*.test.ts  tests/integration/*.live.test.ts
  docs/runbook.md  docs/build-log.md
  .github/workflows/check.yml
```

---

### Task 1: Scaffold, schema, limits, spend, smoke test

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts`, `tests/setup.ts`, `.dev.vars.example`, `LICENSE`, `migrations/0001_init.sql`, `src/env.ts`, `src/index.ts`, `src/core/limits.ts`, `src/core/spend.ts`, `src/auth.ts`, `.github/workflows/check.yml`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Produces `Env = { DB: D1Database; STORE: R2Bucket; TINYFISH_API_KEY: string; ADMIN_TOKEN: string; WEBHOOK_SECRET: string; PUBLIC_BASE_URL: string }`.
- Produces `recordSpend(db, kind: SpendKind, amountUsd: number, ref: string)`, `PRICES`, `totalSpend(db)`, `spendByKind(db)`.
- Produces `isAdmin(c)`, `adminOnly` middleware (copy from `../fineprint/src/auth.ts`).
- Schema (`migrations/0001_init.sql`), tables exactly as spec section 5 plus: `checks.ip_hash`, `checks.added_by ('public'|'admin'|'curated')`, `checks.expires_at`; `records.flags (json)`, `records.disciplinary (json)`, `records.watched (int default 0)`; `watches.callback_url`; `events.notified_at`; `monitors_shared (registry PK, monitor_id, url, created_at)`; `public_use (ip_hash, day, checks, watches, discovers, PK(ip_hash, day))`; indexes on `checks(cache_key, checked_at)`, `records(registry, licence_number)`, `events(record_id, at)`, `watches(monitor_id)`.
- `wrangler.jsonc`: `name: "standing"`, `main: "src/index.ts"`, `compatibility_date: "2026-09-01"`, D1 binding `DB` (`database_name: "standing"`), R2 binding `STORE` (`bucket_name: "standing"`), `triggers.crons: ["15 * * * *"]`, `vars.PUBLIC_BASE_URL`, `observability.enabled: true`.

- [ ] **Step 1: Write the failing smoke test**

```ts
// tests/smoke.test.ts
it("GET /api/stats returns zero counts and spend", async () => {
  const res = await SELF.fetch("http://x/api/stats");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ checks: 0, records: 0, watches: 0, events: 0, spend_usd: 0 });
});
it("admin route rejects a missing token", async () => {
  const res = await SELF.fetch("http://x/api/admin/ping", { method: "POST" });
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/smoke.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Create the scaffold; mount `/api/stats` and an admin-only `POST /api/admin/ping` that returns `{ok: true}`**

Copy `vitest.config.ts`, `tests/setup.ts`, `tsconfig.json` and `.github/workflows/check.yml` from `../fineprint` and change names.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/smoke.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: `npm run check`, commit**

```bash
git add -A && git commit -m "feat: scaffold Worker, D1 schema, spend ledger, admin auth, smoke test"
```

---

### Task 2: Names, match rule, classifier

**Files:**
- Create: `src/core/names.ts`, `src/core/classify.ts`, `src/registries/types.ts`
- Test: `tests/names.test.ts`, `tests/classify.test.ts`

**Interfaces:**
- `names.ts`: `normalizePerson(input: string): { given: string; middle: string[]; surname: string; display: string }` (titles stripped: Dr, Mr, Mrs, Ms, Miss, Mx, Prof, Sir, Dame, Esq, MD, MBBS, PhD, QC, KC; "SURNAME, Given" reordered; case-folded; whitespace collapsed; hyphens and apostrophes kept); `normalizeBusiness(input: string): string` (case-fold, punctuation stripped, suffix map `limited→ltd, public limited company→plc, incorporated→inc, company→co`, trailing suffix kept); `variantsFor(p: ReturnType<typeof normalizePerson>, allowSurnameOnly: boolean): string[]` in spec 4.2 order, deduped; `personNamesEqual(query, candidate): boolean` (query without middle names matches a candidate with middle names; a query with middle names must match them in order; surname and given exact); `businessNamesEqual(a, b): boolean`.
- `registries/types.ts`: `RegistryRow = { name: string; number: string | null; status_raw: string | null; detail: string | null; url: string | null }`, `RegistryAdapter` as in spec 4.1 with method signatures: `goal(q: { variants: string[]; number?: string; profession?: string }): string`, `outputSchema: object`, `parseRecordPage?(markdown: string): ParsedRecord | null`, `normalizeStatus(raw: string | null, hints: { hasConditions?: boolean; hasInterimOrder?: boolean }): { status: Status; flags: Flag[] }`, `recordUrl?(number: string, profession?: string): string | null`, `topicQuery?(fullName: string): string`, `decisionPages: { label: string; url: string }[]`, `browserProfile: "lite" | "stealth"`, `searchUrl: string`.
- `classify.ts`: `classifyRows(rows: RegistryRow[], query: { kind: "person" | "business"; normalized: string | ReturnType<typeof normalizePerson> }): { outcome: "match"; row: RegistryRow } | { outcome: "ambiguous"; candidates: RegistryRow[]; total: number } | { outcome: "no_match" }` implementing spec 4.5's rule: zero rows → no_match; one row → match; several rows → match only if exactly one row's name equals the query by `personNamesEqual` / `businessNamesEqual`, else ambiguous with candidates capped at `CANDIDATES_MAX`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/names.test.ts
it("strips titles, reorders SURNAME, Given, keeps hyphens", () => { expect(normalizePerson("Dr. WICKFOLD, Christopher J.").display).toBe("christopher j wickfold"); expect(normalizePerson("Prof Anne-Marie O'Neill").surname).toBe("o'neill"); });
it("variants are ordered and deduped; surname-only only when allowed", () => { expect(variantsFor(normalizePerson("Christopher John Wickfold"), true)).toEqual(["christopher john wickfold", "christopher wickfold", "wickfold c", "wickfold"]); expect(variantsFor(normalizePerson("Christopher Wickfold"), false)).toEqual(["christopher wickfold", "wickfold c"]); });
it("a query without middle names matches a candidate with them, not the reverse", () => { expect(personNamesEqual("Christopher Wickfold", "Christopher John Marlow Wickfold")).toBe(true); expect(personNamesEqual("Christopher John Wickfold", "Christopher Wickfold")).toBe(false); });
it("business names normalize suffixes and punctuation", () => { expect(businessNamesEqual("Greggs PLC", "GREGGS P.L.C.")).toBe(true); expect(businessNamesEqual("Acme Ltd", "Acme Limited")).toBe(true); expect(businessNamesEqual("Acme Ltd", "Acme Holdings Ltd")).toBe(false); });
// tests/classify.test.ts
it("one row whose name passes the match rule is a match; zero is no_match", () => {});
it("one row whose name fails the match rule is ambiguous with that one candidate ('Christopher Wickfold' vs 'Christine WICKFOLD')", () => {});
it("several rows with exactly one exact-name row is a match on that row", () => {});
it("two rows with the same normalized name are ambiguous with both as candidates and no status", () => { /* Syeda Varisha Amira Sickfold vs Syeda Humaira Sickfold for query 'Syeda Sickfold' -> ambiguous, 2 candidates */ });
it("candidates are capped at 10 with total preserved", () => {});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/names.test.ts tests/classify.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `names.ts`, `classify.ts`, `registries/types.ts`**

- [ ] **Step 4: Run to verify they pass**

Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/names.ts src/core/classify.ts src/registries/types.ts tests/names.test.ts tests/classify.test.ts
git commit -m "feat: name normalization, variants, match rule and classifier"
```

---

### Task 3: Status normalization and the public record schema

**Files:**
- Create: `src/core/status.ts`, `src/core/schema.ts`
- Test: `tests/status.test.ts`

**Interfaces:**
- `status.ts`: `type Status`, `type Flag`, `type Outcome` (exact enums above); `applyStatusMap(map: { pattern: RegExp; status: Status; flags?: Flag[] }[], raw: string | null, hints): { status: Status; flags: Flag[] }` (first matching pattern wins; `hasConditions` upgrades `active` to `conditions`; `hasInterimOrder` adds the flag; no match → `unknown`).
- `schema.ts`: `RecordResult` type exactly as spec 4.3 (with `flags`, `profession`), `toPublicRecord(check: CheckRow, record: RecordRow | null, candidates: CandidateRow[], baseUrl: string): RecordResult` filling `evidence_screenshot_url`, `source_url`, `cached`, `method`, `how_to_resolve` for ambiguous, `variants_tried`, `suggestions` for no_match.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/status.test.ts
it("maps GMC raw statuses, upgrading to conditions when a conditions block exists", () => { expect(applyStatusMap(GMC_MAP, "Registered with a licence to practise", {})).toEqual({ status: "active", flags: [] }); expect(applyStatusMap(GMC_MAP, "Registered with a licence to practise", { hasConditions: true }).status).toBe("conditions"); expect(applyStatusMap(GMC_MAP, "Registered without a licence to practise", {}).status).toBe("not_licensed"); expect(applyStatusMap(GMC_MAP, "Suspended", {}).status).toBe("suspended"); expect(applyStatusMap(GMC_MAP, "Erased", {}).status).toBe("removed"); });
it("maps Companies House statuses with the strike-off flag", () => { expect(applyStatusMap(CH_MAP, "Active — Proposal to strike off", {})).toEqual({ status: "active", flags: ["proposal_to_strike_off"] }); expect(applyStatusMap(CH_MAP, "Dissolved", {}).status).toBe("dissolved"); expect(applyStatusMap(CH_MAP, "Liquidation", {}).status).toBe("insolvency"); expect(applyStatusMap(CH_MAP, "Something new", {}).status).toBe("unknown"); });
it("toPublicRecord omits status for ambiguous and includes how_to_resolve", () => {});
it("toPublicRecord builds absolute evidence and source urls", () => {});
```

(`GMC_MAP` and `CH_MAP` live in their adapters in Task 4; this test imports them, so Task 3 and Task 4 are committed together if preferred, or Task 3 defines the maps and Task 4 moves them.)

- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement `status.ts` and `schema.ts`**
- [ ] **Step 4: Run to verify they pass** (4 tests)
- [ ] **Step 5: Commit** `git commit -m "feat: status normalization and public record schema"`

---

### Task 4: GMC and Companies House adapters

**Files:**
- Create: `src/registries/gmc.ts`, `src/registries/companies-house.ts`, `src/registries/index.ts`
- Test: `tests/adapters-gb.test.ts`, fixtures `tests/fixtures/registries/gmc-record-clean.md` (text from `../spikes/out/gmc-record-fetch.json`), `gmc-record-conditions.md` (from `out/gmc-conditions-fetch.json`), `gmc-agent-result-match.json` and `gmc-agent-result-ambiguous.json` (the `result` objects from `out/gmc-agent-run.json` and `out/gmc-conditions-run.json`), `ch-search.md` and `ch-company.md` (record them with one free Fetch each of `https://find-and-update.company-information.service.gov.uk/search/companies?q=greggs` and `.../company/00502851`, logged in the build log)

**Interfaces:**
- `gmc.ts`: `id "gmc"`, `country "GB"`, `recordTypes ["doctor"]`, `browserProfile "stealth"`, `searchUrl "https://www.gmc-uk.org/registration-and-licensing/the-medical-register"`, `recordUrl(n) => https://www.gmc-uk.org/registrants/${n}`, `goal()` producing the spec's one-run goal (variants in order, stop at first with results, open only if exactly one row or one exact-name row, report `rows[]` up to 10 with name/number/status/specialty, `variants_tried`, `sanctions_text`, `entry_url`), `outputSchema` with `rows[]`, `variants_tried[]`, `results_found`, `full_name`, `gmc_number`, `status`, `entry_url`, `sanctions_text`, `blocked`; `parseRecordPage(md)` returning `{ full_name, licence_number, status_raw, registered_since?, specialties[], conditions: { from: string; text: string }[], history: string[] }` from the markdown shape in the fixtures ("GMC reference number: 9360749", "Registered with a licence to practise", "Conditions on the registrant's registration From 16 Oct 2026 ..."); `GMC_MAP`; `topicQuery(name) => "\"${name}\" GMC tribunal OR MPTS OR suspended OR conditions"`; `decisionPages: []`.
- `companies-house.ts`: `id "companies-house"`, `recordTypes ["company"]`, `browserProfile "lite"`, `searchUrl(q) => https://find-and-update.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(q)}` (Fetch-only adapter: `fetchSearch(env, q): Promise<RegistryRow[]>` parses the results markdown into rows with name, number and status line), `recordUrl(n) => .../company/${n}`, `parseRecordPage(md)` → `{ full_name, licence_number, status_raw, registered_since (incorporated on), company_type, address, sic_codes[], flags }`, `CH_MAP`, `decisionPages: []`, `topicQuery: undefined`.
- `index.ts`: `getAdapter(jurisdiction, recordType): RegistryAdapter | null`, `listAdapters()`, `SUPPORTED: { jurisdiction, record_type, registry }[]`, `UNSUPPORTED: { registry, country, reason }[]` (the four from spec section 3).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/adapters-gb.test.ts
it("gmc.parseRecordPage reads name, number, status and specialties from a clean record", () => { const r = gmc.parseRecordPage(fx("gmc-record-clean.md")); expect(r.licence_number).toBe("9360749"); expect(r.status_raw).toBe("Registered with a licence to practise"); expect(r.specialties).toContain("Infectious diseases"); expect(r.conditions).toEqual([]); });
it("gmc.parseRecordPage extracts the conditions block with its From date", () => { const r = gmc.parseRecordPage(fx("gmc-record-conditions.md")); expect(r.licence_number).toBe("9662428"); expect(r.conditions[0].from).toBe("2026-10-16"); expect(r.conditions[0].text).toMatch(/notified/); });
it("gmc goal names every variant and forbids opening the first result", () => { const g = gmc.goal({ variants: ["christopher wickfold", "wickfold c"] }); expect(g).toContain("christopher wickfold"); expect(g).toMatch(/exactly one/i); expect(g).not.toMatch(/first result/i); });
it("companies-house parses search rows with number and status, and a company page", () => { const rows = companiesHouse.parseSearch(fx("ch-search.md")); expect(rows[0]).toMatchObject({ number: expect.stringMatching(/^\d{8}$/) }); const r = companiesHouse.parseRecordPage(fx("ch-company.md")); expect(r.licence_number).toBe("00502851"); expect(["Active", "Dissolved"]).toContain(r.status_raw.split(" ")[0]); });
it("getAdapter resolves (GB, doctor) and (GB, company) and returns null for (US-CA, nurse)", () => {});
```

- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement the two adapters and the index; record the two Companies House fixtures with free Fetch calls (log them)**
- [ ] **Step 4: Run to verify they pass** (5 tests)
- [ ] **Step 5: Commit** `git commit -m "feat: GMC and Companies House adapters with record-page parsers"`

---

### Task 5: TinyFish clients

**Files:**
- Create: `src/tinyfish/client.ts`, `fetch.ts`, `agent.ts`, `search.ts`, `monitor.ts`, `browser.ts`
- Test: `tests/tinyfish.test.ts`, `tests/integration/gmc.live.test.ts` (opt-in), fixtures copied from `../spikes/out/` into `tests/fixtures/tinyfish/`

**Interfaces:**
- `client.ts`, `fetch.ts`, `monitor.ts`, `browser.ts`: copy from `../fineprint/src/tinyfish/` (same signatures: `tinyfishFetch`, `fetchPage(env, url, format)`, `createMonitor` / `updateMonitor` / `setMonitorStatus` / `deleteMonitor` / `listMonitors`, `screenshotFullPage(env, url)`), then extend: `client.ts` retries Agent 429 per Global Constraints; `monitor.ts` adds `createTopicMonitor(env, p: { query: string; name: string; scheduleCron: string; purpose: string; webhookUrl: string; recencyMinutes?: number; resultLimit?: number }): Promise<{ monitorId: string }>` (`type: "search"`), verified shape in `out/monitor-topic-create.json`.
- `agent.ts`: `startRun(env, p: { url: string; goal: string; outputSchema: object; browserProfile: "lite" | "stealth"; callbackUrl: string }): Promise<{ runId: string }>` (`max_steps: AGENT_MAX_STEPS`, `max_duration_seconds`), `getRun(env, runId, screenshots: "url" | "none")`, `downloadStepScreenshot(env, runId, stepId): Promise<ArrayBuffer>` (API-key binary endpoint), `pickEvidenceStep(run): string | null` (the last step whose `action` mentions the entry, record, or details page; else the last step with a screenshot).
- `search.ts`: `searchWeb(env, query: string, opts?: { includeDomains?: string; recencyMinutes?: number }): Promise<{ url: string; title: string; snippet: string }[]>`.

- [ ] **Step 1: Write the failing tests** (fetchMock; assert request bodies: `startRun` sends `output_schema`, `browser_profile`, `webhook_url`, `agent_config.max_steps === 12`; `createTopicMonitor` sends `type: "search"` and `config.recency_minutes`; 429 then 200 on Agent start results in one `runId` and one 60 s wait (fake timers); `pickEvidenceStep` on `out/gmc-agent-run.json` returns the step whose action starts with "Open first matching entry" or later; `downloadStepScreenshot` returns bytes for a mocked `image/jpeg`)
- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to verify they pass; do NOT run the live test yet (it waits until the Fineprint registration is finished)** 
- [ ] **Step 5: Commit** `git commit -m "feat: TinyFish clients for Agent, Fetch, Search, Monitor (page and topic), Browser"`

---

### Task 6: Repositories and cache

**Files:**
- Create: `src/db/types.ts`, `checks.ts`, `records.ts`, `watches.ts`, `events.ts`, `publicUse.ts`
- Test: `tests/db.test.ts`

**Interfaces:**
- `checks.ts`: `cacheKey(registry, recordType, normalizedOrNumber, profession?)`, `findCached(db, key, withinHours): Promise<CheckRow | null>` (latest `done` check with `outcome in (match, ambiguous, no_match)` and `checked_at` within the window), `insertCheck`, `getCheck`, `getCheckByRunId`, `finishCheck(db, id, patch)`, `insertCandidates(db, checkId, rows)`, `listCandidates`, `expirePublicChecks(db, olderThanIso): Promise<{ ids: string[]; evidenceKeys: string[] }>` (unwatched public checks only).
- `records.ts`: `upsertRecord(db, r)` keyed by `(registry, licence_number)`, `getRecord`, `markWatched`, `listWatchedAndCurated`, `recordDiff(before: RecordRow, after: ParsedRecord): { changed: boolean; fields: string[] }` (compares `status`, `flags`, `conditions`/`disciplinary`, `status_raw`).
- `watches.ts`: `insertWatch`, `getWatch`, `getWatchByMonitorId`, `listWatches`, `countWatches(db, addedBy?)`, `expireWatches(db, nowIso)`, `getSharedMonitor(db, registry)`, `putSharedMonitor`.
- `events.ts`: `insertEvent`, `listEvents(db, sinceIso | null, limit)`, `listEventsForRecord`.
- `publicUse.ts`: `bump(db, ipHash, field: "checks" | "watches" | "discovers")`, `today(db, ipHash)`.

- [ ] **Step 1: Write the failing tests** (`findCached` respects the 24 h window and ignores `error` checks; `expirePublicChecks` skips watched records and returns evidence keys; `recordDiff` flags a new conditions block and ignores a timestamp-only difference; `countWatches("public")` excludes expired)
- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to verify they pass** (4 tests)
- [ ] **Step 5: Commit** `git commit -m "feat: D1 repositories with cache lookup, record diff, watch and event stores"`

---

### Task 7: Checks API, Agent callback, evidence

**Files:**
- Create: `src/checks/run.ts`, `src/checks/evidence.ts`, `src/handlers/checks.ts`, `src/handlers/webhooks.ts` (agent route), `src/handlers/objects.ts`
- Modify: `src/index.ts`
- Test: `tests/checks.test.ts`

**Interfaces:**
- `startCheck(env, input: CheckInput, who: { admin: boolean; ipHash: string }): Promise<{ checkId: string; status: "done" | "pending"; cached: boolean; estimatedCostUsd: number }>`: validates (`record_type` × `jurisdiction` via `getAdapter`, else 400 `unsupported` with `supported[]`); public caps (5 per day → 429 `daily_limit`); cache unless `fresh`; number path: `adapter.recordUrl` → `fetchPage` → `parseRecordPage` → `finishCheck` as `match` with `method "fetch"` and `storeFetchEvidence`; Companies House name path: `fetchSearch` → `classifyRows` → match → `fetchPage(recordUrl)`; Agent path: `startRun` with `adapter.goal({variants, number, profession})`, `callbackUrl = ${PUBLIC_BASE_URL}/hooks/agent/${WEBHOOK_SECRET}`, `finishCheck` pending with `run_id`. Spend pause at `SPEND_PAUSE_USD` → 503 `{error: "spend_paused"}`.
- **Constraint (3 Nov): at most ONE Agent run in flight for Standing at any time.** Standing shares the account's limit of 2 concurrent Agent runs with my other builds. A check whose Agent run is still pending holds the single slot; a second incoming check's run is queued (check `pending`, no `run_id`) until the first reaches a terminal status. The slot is a simple in-flight holder in D1 with a 5-minute stale timeout (a holder older than 5 minutes no longer blocks). Monitor-triggered re-checks (Task 9) share the same slot and queue. When the slot frees (Agent callback reaches a terminal status, or the cron follow-up resolves a run), the oldest queued check starts. Any 429 `RATE_LIMIT_EXCEEDED` still waits 60 s and retries up to 3 times.
- `resolveFromRows(env, check, adapter, result: AgentResult)`: builds `RegistryRow[]` from `result.rows`, `classifyRows`; `match` → if the agent opened the entry use its fields, else if `recordUrl` exists `fetchPage` and parse; `upsertRecord`; `storeAgentEvidence`; `finishCheck` with `outcome`, `record_id`, `variants_tried`, `checked_at = run.finished_at`, `spend_usd`; `ambiguous` → `insertCandidates`; `no_match` → `suggestions` from the adapter.
- `evidence.ts`: `storeAgentEvidence(env, checkId, runId): Promise<string | null>` (pick step, download JPEG, `STORE.put("evidence/<checkId>.jpg")`), `storeFetchEvidence(env, checkId, url, markdown): Promise<string>` (`evidence/<checkId>.md` plus `screenshotFullPage` → `.jpg`, spend `screenshot`).
- `POST /hooks/agent/:secret`: secret check; body with `run_id`; unknown run → 200 `{ok: true, ignored: true}`; check already done → 200 ignored; status not terminal → 200; `FAILED`/`CANCELLED` → `finishCheck` `outcome "error"`, `error` from the payload; `COMPLETED` → if `result` absent, `getRun`; `resolveFromRows`. Records `agent_step` spend from `num_of_steps`.
- `GET /api/checks/:id` → `toPublicRecord` or `{status: "pending", started_at, run_id}`. `GET /evidence/:key` → R2 object with immutable cache headers.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/checks.test.ts  (fetchMock for TinyFish; vi.mock browser screenshot)
it("POST /api/checks with unsupported type returns 400 and the supported list", async () => {});
it("number path for a doctor reads the record page with Fetch, stores markdown and screenshot evidence, outcome match, method fetch", async () => {});
it("name path starts one Agent run with the adapter goal and the callback url; check is pending", async () => {});
it("agent callback with the real match fixture resolves to match, stores evidence from the record-page step, checked_at = finished_at, spend = steps x 0.016", async () => {});
it("agent callback with the two-row fixture resolves to ambiguous with both candidates and no status", async () => {});
it("agent callback with one row whose name fails the match rule (query 'Christopher Wickfold', row 'Christine WICKFOLD') resolves to ambiguous with that one candidate, candidates_total 1, how_to_resolve, no status", async () => {});
it("a second identical check within 24h is served from cache with cached:true and the original checked_at; fresh:true starts a new run", async () => {});
it("sixth public check from the same ip in a day is 429 daily_limit", async () => {});
it("callback for an unknown run_id, and a duplicate callback, are 200 no-ops", async () => {});
it("company name check uses Fetch search, matches the single exact-name row and reads the company page", async () => {});
```

- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to verify they pass** (9 tests)
- [ ] **Step 5: Commit** `git commit -m "feat: checks API with cache, Agent callback resolution, ambiguity contract and evidence"`

---

### Task 8: NMC, SRA, CSLB, DCA adapters and the coverage endpoint

**Files:**
- Create: `src/registries/nmc.ts`, `sra.ts`, `cslb.ts`, `ca-dca.ts`, `src/handlers/registries.ts`
- Modify: `src/registries/index.ts`
- Test: `tests/adapters-more.test.ts`

**Interfaces:**
- Each adapter: `goal()` in the same one-run shape (variants, stop at first results, open only on the match rule, `rows[]` with the registry's distinguishing field: NMC register part and location; SRA admission date and firm; CSLB classification and city; DCA board and licence type), `outputSchema`, status map, `topicQuery` (NMC, SRA), `recordUrl` (CSLB: `https://www.cslb.ca.gov/OnlineServices/CheckLicenseII/LicenseDetail.aspx?LicNum=${n}`; DCA: requires `profession` → `https://search.dca.ca.gov/details/${board}/${type}/${n}/`, the board and type codes are confirmed from one free Fetch of a real detail page found via TinySearch; `null` when `profession` is missing), `parseRecordPage` for CSLB and DCA from one recorded fixture each (free Fetch, logged), `decisionPages` (NMC: the hearings outcomes page; SRA: the recent decisions page; URLs found with TinySearch and verified readable with Fetch; recorded as fixtures `nmc-decisions.md`, `sra-decisions.md`).
- `GET /api/registries` → `{ registries: [{ id, name, country, record_types[], lookup: "agent" | "fetch" | "agent+fetch", watch: "page" | "topic+decisions" | "none", supported: true, last_success_at, notes }], unsupported: [{ registry, country, reason }] }` exactly as spec section 6.

- [ ] **Step 1: Write the failing tests** (each adapter's status map against its fixture raw statuses; `recordUrl` for DCA returns null without profession; `GET /api/registries` lists 6 supported and 4 unsupported; decision page fixtures parse to at least one named entry)
- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement; record the fixtures with free Fetch calls (logged)**
- [ ] **Step 4: Run to verify they pass**
- [ ] **Step 5: Commit** `git commit -m "feat: NMC, SRA, CSLB and DCA adapters; coverage endpoint"`

---

### Task 9: Watches, Monitor webhook, events, read API

**Files:**
- Create: `src/handlers/watches.ts`, `src/handlers/records.ts`, `src/handlers/stats.ts`, `src/handlers/admin.ts`; add the monitor route to `src/handlers/webhooks.ts`
- Test: `tests/watches.test.ts`, fixtures `tests/fixtures/webhooks/page-changed.json`, `page-unchanged.json`, `topic-new-result.json` (hand-built from the documented shapes and `out/monitor-topic-create.json`; replaced by real recordings after deploy)

**Interfaces:**
- `POST /api/records/:id/watch` body `{callback_url?}`: caps (`countWatches() + SHARED_MONITORS < MAX_MONITORS`; public: `PUBLIC_WATCH_SLOTS`, `PUBLIC_WATCHES_PER_IP`), kind by adapter (`recordUrl` and record has `source_url` → Page monitor on it with spec 4.6 purpose, `schedule_cron` staggered 12 h; else Topic monitor with `adapter.topicQuery(full_name)`), `expires_at` for public, `markWatched`; 201 `{watch_id, kind, next_check}`. `DELETE` → `deleteMonitor`, status `expired`.
- `POST /api/admin/init-shared` (admin): creates the NMC and SRA decision-page monitors once (`monitors_shared`), 12 h cron, purpose "A new hearing outcome, sanction, decision or notice was published. Ignore dates and layout."
- `POST /hooks/monitor/:secret`: secret; look up by `fetch_monitor_id` (Page) or `search_monitor_id` (Topic): a watch → on `changed` (Page): `fetchPage(record.source_url)` → `parseRecordPage` → `recordDiff` → `status_change` event with `{before, after, fields}` if changed, else `recheck`; `upsertRecord`; notify `callback_url` (POST, 5 s timeout, best effort, `notified_at`). Topic with `new_result_positions.length > 0` → `notice` event per new URL + one Agent re-check run (`startRun` with the adapter goal for the record's number or exact name, callback resolves to a `recheck` or `status_change` event). A shared monitor → scan `diff` for each watched record's surname (case-insensitive, word boundary) → `notice` event per hit + one Agent re-check for that record. Unchanged → `recordSpend(monitor_check)` only. Unknown monitor → 404.
- `GET /api/records/:id`, `GET /api/records/:id/history`, `GET /api/events?since=&limit=`, `GET /api/export.json` (watched and curated records with events and absolute evidence URLs), `GET /api/stats` (checks, records, watches by kind, events by kind, spend total and by kind, cost per check, monitor health from `listMonitors`).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/watches.test.ts
it("watching a GMC record creates a Page monitor on its record url with the purpose and a 12h cron", async () => {});
it("watching an NMC record creates a Topic monitor with the adapter query", async () => {});
it("fifth public watch is 409 public_slots_full; ninth watch overall is 409 watchlist_full (10 minus 2 shared)", async () => {});
it("page changed webhook whose re-read adds a conditions block creates a status_change event with before/after and calls callback_url", async () => {});
it("page changed webhook whose re-read is identical creates a recheck event, not a status_change", async () => {});
it("topic webhook with a new result creates a notice event and starts one Agent re-check", async () => {});
it("shared decision-page webhook mentioning a watched surname creates a notice and starts one re-check; unrelated diff creates nothing", async () => {});
it("export and events include watched records only", async () => {});
```

- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to verify they pass** (8 tests)
- [ ] **Step 5: Commit** `git commit -m "feat: watches with Page and Topic monitors, Monitor webhook events, read API"`

---

### Task 10: Hourly cron

**Files:**
- Create: `src/cron.ts`; wire `scheduled` in `src/index.ts`
- Test: `tests/cron.test.ts`

**Interfaces:**
- `runCron(env): Promise<{ expired_watches: number; purged_checks: number; pending_followups: number; unhealthy: string[] }>`: expire public watches past `expires_at` (`deleteMonitor`, keep history); purge unwatched public checks older than `PUBLIC_RECORD_TTL_HOURS` (rows, candidates, R2 evidence); follow up `pending` checks older than 10 min via `getRun` (terminal → resolve as the callback would; older than 30 min and still running → `error "timeout"`); health: `listMonitors` vs watches and shared monitors, mark `failed` when missing or not active. Never calls a registry directly.

- [ ] **Step 1: Write the failing tests** (expiry deletes the Monitor and keeps events; purge removes evidence objects and skips watched records; a pending check with a completed run gets resolved; health marks a paused monitor's watch failed)
- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to verify they pass** (4 tests)
- [ ] **Step 5: Commit** `git commit -m "feat: hourly cron for watch expiry, public check purge, run follow-up and monitor health"`

---

### Task 11: Runbook, curated watches, README skeleton, CI, build log

**Files:**
- Create: `docs/runbook.md`, `scripts/init-shared-monitors.mjs`, `scripts/curate-watches.mjs`, `README.md`, `docs/build-log.md` (if not already started), `tests/integration/*.live.test.ts` (one per adapter, opt-in, skipped without a key)
- Test: `tests/scripts.test.ts` (the curate script's selection rules are pure functions and testable)

**Interfaces:**
- `scripts/curate-watches.mjs --base <url> --token <admin>`: for each of the four curated targets in spec 4.6, runs a TinySearch (`searchWeb`) with the documented query shapes ("MPTS hearing November 2026 doctor", "Companies House proposal to strike off Gazette notice", "NMC fitness to practise hearing November 2026", "SDT hearing November 2026 solicitor"), prints candidate names and sources, and **stops for a human choice**: it never watches automatically. With `--pick <n>` it runs the check and the watch for the chosen candidate and writes `docs/curated-watches.md` with the public source for each name. The naming rule from spec section 7 is printed at the top of its output.
- `docs/runbook.md`: D1 and R2 creation, secrets, `PUBLIC_BASE_URL`, migrate, deploy, `init-shared` (and verify two shared monitors exist on TinyFish), the four curated watches via the script with the approved picks, one live check per adapter recorded in `docs/build-log.md` with cost, then the first real Monitor webhook saved as a fixture.
- README skeleton: what it does, live URL placeholder, the coverage table (generated from `/api/registries`), "How TinyFish Agent, Fetch, Search, Monitor and Browser are used" table, run locally, API examples (match, ambiguous, no match), limits and posture.

- [ ] **Step 1: Write the failing test** (`selectCandidates(results)` filters to entries with a name and a date inside the window and returns at most 5)
- [ ] **Step 2: Run to verify it fails**
- [ ] **Step 3: Write the scripts, runbook, README skeleton, integration tests**
- [ ] **Step 4: `npm run check`**
- [ ] **Step 5: Commit** `git commit -m "feat: runbook, curated-watch selection script, README skeleton, live tests"`

---

## After Task 11

Stop here and write down: the commit list, the test counts per file, the changes from this plan in `docs/build-log.md`, and the exact deploy commands. Deploy only after reading that back, following the runbook. The names of the curated watches are approved one by one before `--pick`.

## Self-review notes

- Spec coverage: 4.1 (Tasks 4, 8), 4.2 (Task 2), 4.3 (Task 3), 4.4 (Tasks 7, 9), 4.5 (Tasks 2, 7), 4.6 (Tasks 9, 11), 4.7 (Task 7), retention (Task 10), 5 (Tasks 1, 6), 6 (Task 8), 7 (Tasks 1, 7, 9, 11), 8 (every task; live tests Task 11), 9 delivery (Task 11 runbook). The viewer (4.8) is a separate plan after the family design lands in code.
- Names used across tasks are defined once in the task that lists them under Produces: `normalizePerson`, `normalizeBusiness`, `variantsFor`, `personNamesEqual`, `businessNamesEqual`, `classifyRows`, `applyStatusMap`, `toPublicRecord`, `getAdapter`, `startRun`, `getRun`, `downloadStepScreenshot`, `pickEvidenceStep`, `createTopicMonitor`, `fetchPage`, `screenshotFullPage`, `searchWeb`, `findCached`, `recordDiff`, `startCheck`, `resolveFromRows`, `storeAgentEvidence`, `storeFetchEvidence`, `runCron`.
