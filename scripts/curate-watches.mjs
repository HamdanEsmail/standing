#!/usr/bin/env node
// Finds candidates for the four curated watches (spec 4.6) and, only when a person picks them,
// checks and watches them on the deployed Worker.
//
//   node scripts/curate-watches.mjs --base https://<worker> --token <ADMIN_TOKEN>
//       Prints the naming rule, runs the four free TinySearch queries, prints numbered candidates with
//       their public sources, saves them to .curate/candidates.json, and stops. It never watches.
//
//   node scripts/curate-watches.mjs --base https://<worker> --token <ADMIN_TOKEN> --pick gmc:2 --pick nmc:1
//       For each pick (target:number from the saved list): POST /api/checks (admin), waits for the
//       result, and only on a match watches the record with added_by "curated". Then writes
//       docs/curated-watches.md. The checks and Monitors it starts are the Worker's (paid).
//
// The TinyFish key is read from .dev.vars, else from TINYFISH_API_KEY. It is never printed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { curatedWatchesMarkdown, NAMING_RULE, selectCandidates, TARGETS } from "./lib/curate.mjs";

const SEARCH_API = "https://api.search.tinyfish.ai";
const SAVED = ".curate/candidates.json";
const POLL_MS = 5_000;
const WAIT_MS = 300_000;

function args() {
  const out = { base: null, token: null, picks: [] };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") out.base = argv[++i]?.replace(/\/+$/, "") ?? null;
    else if (argv[i] === "--token") out.token = argv[++i] ?? null;
    else if (argv[i] === "--pick") out.picks.push(argv[++i] ?? "");
  }
  if (!out.base || !out.token) {
    console.error("usage: node scripts/curate-watches.mjs --base <worker url> --token <admin token> [--pick <target>:<n> ...]");
    process.exit(2);
  }
  return out;
}

// The project's .dev.vars first: an old key left in the shell environment must not override it.
function tinyfishKey() {
  try {
    for (const line of readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
      const i = line.indexOf("=");
      if (i > 0 && line.slice(0, i).trim() === "TINYFISH_API_KEY" && line.slice(i + 1).trim() !== "") return line.slice(i + 1).trim();
    }
  } catch {
    // no .dev.vars
  }
  if (process.env.TINYFISH_API_KEY) return process.env.TINYFISH_API_KEY;
  console.error("No TinyFish key: create .dev.vars or set TINYFISH_API_KEY.");
  process.exit(2);
}

async function search(key, query) {
  const u = new URL(SEARCH_API);
  u.searchParams.set("query", query);
  u.searchParams.set("purpose", "find public hearing and regulatory notices to choose demo watches");
  const res = await fetch(u, { headers: { "X-API-Key": key } });
  if (!res.ok) throw new Error(`TinySearch answered HTTP ${res.status}`);
  const body = await res.json();
  return Array.isArray(body.results)
    ? body.results.filter((r) => r && typeof r.url === "string").map((r) => ({ url: r.url, title: r.title ?? "", snippet: r.snippet ?? "" }))
    : [];
}

async function list() {
  const key = tinyfishKey();
  const now = new Date().toISOString();
  const saved = { generated_at: now, targets: {} };
  for (const t of TARGETS) {
    const candidates = selectCandidates(await search(key, t.query), { now, kind: t.kind });
    saved.targets[t.id] = candidates;
    console.log(`\n${t.id}: ${t.label}\n  query: ${t.query}`);
    if (candidates.length === 0) console.log("  (no candidates: try again later or search by hand)");
    candidates.forEach((c, i) => console.log(`  ${i + 1}. ${c.name} | ${c.date} | ${c.url}`));
  }
  mkdirSync(".curate", { recursive: true });
  writeFileSync(SAVED, JSON.stringify(saved, null, 2));
  console.log(`\nSaved to ${SAVED}. Nothing was watched. Send the list for approval, then run again with --pick <target>:<n>.`);
}

async function api(base, token, path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // not JSON
  }
  return { status: res.status, body };
}

async function pick(base, token, picks) {
  if (!existsSync(SAVED)) {
    console.error(`No ${SAVED}: run without --pick first.`);
    process.exit(2);
  }
  const saved = JSON.parse(readFileSync(SAVED, "utf8"));
  const rows = [];
  for (const p of picks) {
    const [id, n] = p.split(":");
    const target = TARGETS.find((t) => t.id === id);
    const candidate = saved.targets?.[id]?.[Number(n) - 1];
    if (!target || !candidate) {
      console.error(`${p}: no such candidate in ${SAVED}`);
      continue;
    }
    console.log(`\n${p}: checking ${candidate.name} on ${target.id}...`);
    const started = await api(base, token, "/api/checks", { method: "POST", body: JSON.stringify({ query: candidate.name, ...target.check }) });
    if (started.status !== 202) {
      console.error(`  POST /api/checks answered ${started.status}: ${JSON.stringify(started.body)}`);
      continue;
    }
    const checkId = started.body.check_id;
    let result = started.body;
    const until = Date.now() + WAIT_MS;
    while (Date.now() < until) {
      result = (await api(base, token, `/api/checks/${checkId}`)).body;
      if (result && result.status !== "pending") break;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    if (!result || result.outcome !== "match") {
      console.log(`  not watched: the check ended ${result?.outcome ?? "pending"}${result?.error ? ` (${result.error})` : ""}`);
      continue;
    }
    const watched = await api(base, token, `/api/records/${result.record_id}/watch`, { method: "POST", body: JSON.stringify({ added_by: "curated" }) });
    if (watched.status !== 201) {
      console.error(`  watch answered ${watched.status}: ${JSON.stringify(watched.body)}`);
      continue;
    }
    console.log(`  watched: ${watched.body.kind} monitor, watch ${watched.body.watch_id}, next run ${watched.body.next_check}`);
    rows.push({
      target: target.id,
      name: result.full_name ?? candidate.name,
      registry: result.registry_name ?? target.id,
      licence_number: result.licence_number ?? null,
      source: candidate.url,
      watch_id: watched.body.watch_id,
      date: candidate.date,
    });
  }
  if (rows.length > 0) {
    writeFileSync("docs/curated-watches.md", curatedWatchesMarkdown(rows, new Date().toISOString()));
    console.log("\nWrote docs/curated-watches.md.");
  }
}

const opts = args();
console.log(NAMING_RULE);
if (opts.picks.length === 0) await list();
else await pick(opts.base, opts.token, opts.picks);
