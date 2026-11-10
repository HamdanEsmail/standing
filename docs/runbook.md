# Standing deploy-day runbook

Follow it top to bottom in **Git Bash**, from the `standing/` folder. Each step says what to run, what it should print, and what to do if it prints something else. Nothing here prints a secret: the TinyFish key, the admin token and the webhook secret are always read from files, never typed or echoed.

Spend so far is shown at every step by `/api/stats` (`spend_usd`). The Worker pauses all paid work by itself at $4. The budget for this whole runbook is $2.00; the costs below add up to about $1.80.

Two rules that hold all the way through:

- **Never pause a TinyFish Monitor.** A paused Monitor that is resumed cannot be relied on to run again. If a Monitor has to stop, delete it and create a new one.
- **Never touch a Monitor that is not Standing's.** The account holds other builds' Monitors (22 paused, 1 active on 9 Nov). If TinyFish refuses to create a Monitor, stop and report the HTTP status and error code; do not make room by deleting or editing anything.

---

## 0. Before you start

```bash
npm ci
```

```bash
npm run check
```

It should end with `Tests  N passed | 6 skipped` and `--dry-run: exiting now.` If anything fails, stop: do not deploy a red build.

Load the Cloudflare token into this shell only (the app's own login is stale). This prints nothing:

```bash
CF="$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r')"
```

```bash
CLOUDFLARE_API_TOKEN="$CF" npx wrangler whoami
```

It should print the account name and id. If it says you are not authenticated, the token in `../.cloudflare.env` is wrong or expired: stop and get a new one.

## 1. Create the database and the bucket

```bash
CLOUDFLARE_API_TOKEN="$CF" npx wrangler d1 create standing
```

It prints a block with `"database_id": "…"`. Open `wrangler.jsonc` and replace `TBD-after-create` with that id. If it says the database already exists, run `CLOUDFLARE_API_TOKEN="$CF" npx wrangler d1 list` and copy the id of `standing` from there.

```bash
CLOUDFLARE_API_TOKEN="$CF" npx wrangler r2 bucket create standing
```

It prints `Created bucket 'standing'`. "Already exists" is fine too.

```bash
CLOUDFLARE_API_TOKEN="$CF" npm run migrate:remote
```

It lists `0001_init.sql` with a ✅. If it asks to confirm, answer yes. If it says no migrations to apply, the database was already set up: fine.

## 2. First deploy, to learn the address

```bash
CLOUDFLARE_API_TOKEN="$CF" npm run deploy
```

It ends with a line like `https://standing.<your-subdomain>.workers.dev`. Copy it, then:

1. In `wrangler.jsonc`, set `vars.PUBLIC_BASE_URL` to that address (no trailing slash). Never leave it as `localhost`: Monitor webhooks and Agent callbacks would point nowhere.
2. Keep it in this shell too:

```bash
BASE="https://standing.<your-subdomain>.workers.dev"
```

```bash
CLOUDFLARE_API_TOKEN="$CF" npm run deploy
```

(The secrets come after the first deploy because `wrangler secret put` on a Worker that does not exist yet stops to ask a question. Until the secrets are set the Worker is safe: with no admin token nobody is admin, with no webhook secret every webhook is refused, and with no TinyFish key nothing can spend.)

## 3. Secrets

Make the admin token and the webhook secret into a file git ignores (`.dev.vars.production`). This prints nothing:

```bash
node -e "const c=require('crypto');console.log('ADMIN_TOKEN='+c.randomUUID()+c.randomUUID());console.log('WEBHOOK_SECRET='+c.randomUUID()+c.randomUUID())" > .dev.vars.production
```

Hand each secret to Cloudflare straight from its file:

```bash
grep -m1 '^TINYFISH_API_KEY=' .dev.vars | cut -d= -f2- | tr -d '\r' | CLOUDFLARE_API_TOKEN="$CF" npx wrangler secret put TINYFISH_API_KEY
```

```bash
grep -m1 '^ADMIN_TOKEN=' .dev.vars.production | cut -d= -f2- | CLOUDFLARE_API_TOKEN="$CF" npx wrangler secret put ADMIN_TOKEN
```

```bash
grep -m1 '^WEBHOOK_SECRET=' .dev.vars.production | cut -d= -f2- | CLOUDFLARE_API_TOKEN="$CF" npx wrangler secret put WEBHOOK_SECRET
```

Each prints `✨ Success! Uploaded secret …`. Keep `.dev.vars.production` safe (it is the only copy of the admin token); never commit it. Load the admin token into this shell, again without printing it:

```bash
ADMIN="$(grep -m1 '^ADMIN_TOKEN=' .dev.vars.production | cut -d= -f2-)"
```

Commit the two `wrangler.jsonc` edits (database id and address; neither is a secret):

```bash
git add wrangler.jsonc && git commit -m "chore: production database id and address" && git push
```

## 4. Is it up?

```bash
curl -s "$BASE/api/stats"
```

It should print counts of 0 and `"spend_usd":0`.

```bash
curl -s "$BASE/api/registries"
```

It should list six registries and four unsupported ones.

```bash
curl -s -X POST "$BASE/api/admin/ping" -H "Authorization: Bearer $ADMIN"
```

It should print `{"ok":true}`. `{"error":"admin_required"}` means the admin token secret did not take: redo step 3.

## 5. The two shared decision-page monitors

Cost: two Monitor baselines, $0.01.

```bash
node scripts/init-shared-monitors.mjs --base "$BASE" --token "$ADMIN"
```

It should print one line each for `nmc` and `sra`, with a monitor id and "created now". If a line says `NOT created` with an HTTP status and code, **stop** and report that status and code (this is where an account Monitor limit would show). Running the script again never creates a second one.

Check on TinyFish that both exist and that nothing else changed (this prints names and statuses only):

```bash
curl -s https://agent.tinyfish.ai/v1/monitors -H "X-API-Key: $(grep -m1 '^TINYFISH_API_KEY=' .dev.vars | cut -d= -f2- | tr -d '\r')" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const b=JSON.parse(s);for(const m of (b.monitors??b))console.log(m.status.padEnd(8),m.id,m.name)})"
```

You should see `standing-shared-nmc` and `standing-shared-sra` as `active`, and the two old probes `e92c04d7-…` and `7bd84544-…` still `paused`. Do not touch any other line.

## 6. One live check per register, cheapest first

Run them one at a time, in this order. The Worker allows one Agent run at a time anyway; a second one waits its turn. After each, note the result and the spend in `docs/build-log.md` (Live calls table).

Two helpers for this shell (paste once):

```bash
check() { curl -s -X POST "$BASE/api/checks" -H "Authorization: Bearer $ADMIN" -H "content-type: application/json" -d "$1"; echo; }
```

```bash
result() { curl -s "$BASE/api/checks/$1"; echo; }
```

`check` prints `{"check_id":"…","status":…}`. Run `result <check_id>` until `status` is no longer `"pending"` (an Agent check takes one to three minutes).

| # | Register | Command | Path | Cost at most |
|---|---|---|---|---|
| 1 | Companies House | `check '{"query":"GREGGS PLC","record_type":"company","jurisdiction":"GB"}'` | Fetch search + company page | $0.002 (screenshot) |
| 2 | California DCA by number | `check '{"number":"59020","record_type":"professional","jurisdiction":"US-CA","profession":"pharmacy"}'` | Fetch licence page | $0.002 |
| 3 | GMC by number | `check '{"number":"9360749","record_type":"doctor","jurisdiction":"GB"}'` | Fetch record page | $0.002 |
| 4 | GMC by name | `check '{"query":"<full name of the doctor behind number 9360749, as the register prints it>","record_type":"doctor","jurisdiction":"GB"}'` (type the name on the day; do not write it down) | Agent | $0.194 |
| 5 | NMC by PIN | `check '{"number":"22L4964O","record_type":"nurse","jurisdiction":"GB"}'` | Agent | $0.194 |
| 6 | SRA by number | `check '{"number":"961486","record_type":"solicitor","jurisdiction":"GB"}'` | Agent | $0.194 |
| 7 | Florida company by name | `check '{"query":"Publix Asset Management Company","record_type":"company","jurisdiction":"US-FL"}'` | Fetch search + record page | $0.002 |
| 8 | California DCA by name | `check '{"query":"Santa Fe Family Pharmacy","record_type":"professional","jurisdiction":"US-CA","profession":"pharmacy"}'` | Agent; on 9 Nov the DCA search showed a CAPTCHA, so expect `blocked` | $0.208 |

Total at most about $0.85. (California contractors were dropped on 9 Nov: their licence pages show no licence data to automated tools. The NMC search sometimes shows a robot check; Standing then answers `blocked` and never goes around it.) (The people and businesses are a public office holder, people named in public hearing and decision notices, and registered businesses, as spec section 7 allows.)

What a good result looks like: `"outcome":"match"` with a `status`, `full_name`, `licence_number`, `source_url` and an `evidence_screenshot_url` that opens. What to do otherwise:

- `"outcome":"error","error":"incomplete_agent_result"` on an Agent register (5 to 8): the run returned fields the adapter did not read. The NMC, SRA, CSLB and DCA field names have never been seen live. Look at the run itself (prints the result only):

  ```bash
  curl -s "https://agent.tinyfish.ai/v1/runs/<run_id>?screenshots=none&html=none" -H "X-API-Key: $(grep -m1 '^TINYFISH_API_KEY=' .dev.vars | cut -d= -f2- | tr -d '\r')" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s).result,null,2)))"
  ```

  (`run_id` is in `result <check_id>` while it is pending, or in the Worker log.) Save the output as a fixture, fix the adapter's `parseAgentResult` to it, and do not run that register again until the fix is in.
- `"error":"blocked…"`: the register showed a robot check. Note it; do not retry more than once.
- `"outcome":"ambiguous"` or `"no_match"`: that is an honest answer, not a failure. Note what it said.
- `"error":"spend_paused"`: total spend reached $4. Stop and report.
- `"error":"busy"`: TinyFish was rate-limited for three minutes. Wait ten minutes and run that one again.

Then check the spend:

```bash
curl -s "$BASE/api/stats"
```

`spend_usd` should be at most about $1.00, and `tinyfish_calls` should show agent, fetch and browser counts above 0.

Also replace the hand-built Agent fixture `tests/fixtures/registries/gmc-agent-result-ambiguous.json` with a real two-registrant search when one turns up (a common surname on the GMC register).

## 7. The curated watches

Cost: free searches, then for each picked name one check (Fetch $0.002 or Agent up to $0.194) and one Monitor ($0.005 baseline, then $0.005 per run, twice a day). Four watches cost up to about $0.80 on the first day, which fits in what is left of the $2.00 after step 6. Run `--pick` only after the names are approved.

List candidates (free; it never watches anything):

```bash
node scripts/curate-watches.mjs --base "$BASE" --token "$ADMIN"
```

It prints the naming rule, then up to five numbered candidates for each of the four targets, with the public source of each, and saves them to `.curate/candidates.json`. **Send that list for approval of the names.** Only after the okay:

```bash
node scripts/curate-watches.mjs --base "$BASE" --token "$ADMIN" --pick gmc:1 --pick companies-house:1 --pick nmc:1 --pick sra:1
```

(Use the numbers that were approved.) For each pick it prints `watched: page monitor …` or `topic monitor …`, or why it was not watched (a check that was not a clean match is never watched). It writes `docs/curated-watches.md`; commit that file.

**CSLB:** if a CSLB business is ever watched and its first Topic run brings back junk hits (pages about other businesses), make CSLB lookup-only: its watch becomes "none". Do not tune the query; delete that watch (`curl -s -X DELETE "$BASE/api/records/<record_id>/watch" -H "Authorization: Bearer $ADMIN"`) and report it.

## 8. The first real Monitor webhooks

Monitor runs come every 12 hours per watch. The Worker keeps each webhook body in R2 under `raw/monitor/<run id>.json`. List them:

```bash
CLOUDFLARE_API_TOKEN="$CF" npx wrangler r2 object list standing --prefix raw/monitor/ --remote
```

(If your wrangler has no `object list`, use the R2 page of the Cloudflare dashboard.) Fetch one of each kind:

```bash
CLOUDFLARE_API_TOKEN="$CF" npx wrangler r2 object get "standing/raw/monitor/<run id>.json" --remote --file tests/fixtures/webhooks/page-real.json
```

1. **Check a Topic webhook first.** TinyFish documents each result with its own `position`, counted from 1, and `new_result_positions` as the positions of the new ones; Standing finds a new result by that position (and reads a payload without positions by place in the list, from 0). No real Topic webhook with a new result had arrived when this was written. Open the first real one and check that each position names the new result; if it does not, fix `readMonitorPayload` in `src/monitoring/hook.ts` before trusting any Topic notice.
2. Replace the hand-built `tests/fixtures/webhooks/page-changed.json`, `topic-new-result.json` and `shared-changed.json` with real ones (keep the test expectations honest: if a real payload changes what a test can assert, change the test, not the payload), then `npm run check`.

## 9. Keep an eye on it

- `curl -s "$BASE/api/stats"` daily: spend, events, and `monitors` (active, failed).
- The hourly job logs a `cron` line when something needs a look: a Monitor that is missing or not active (its watch is marked failed), or a watch with no Monitor run for more than 26 hours (runs can arrive late or not at all). Read it with `CLOUDFLARE_API_TOKEN="$CF" npx wrangler tail`.
- A failed watch is not repaired automatically. Delete it and watch the record again (a new Monitor); never resume a paused one.

## 10. After 17 November (optional)

The NMC hearings page rolls monthly. On 1 December the shared NMC monitor still watches the November page. To move it: delete that Monitor on TinyFish, delete the `nmc` row of `monitors_shared`, point `nmc.decisionPages` at `nmcHearingsPageUrl(new Date())`, deploy, and run step 5 again.
