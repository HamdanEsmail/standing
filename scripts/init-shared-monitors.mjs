#!/usr/bin/env node
// Creates the two shared decision-page monitors (NMC hearings, SRA recent decisions) on the deployed
// Worker, once. Running it again creates nothing.
//
//   node scripts/init-shared-monitors.mjs --base https://<worker> --token <ADMIN_TOKEN>
const argv = process.argv.slice(2);
const get = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : (argv[i + 1] ?? null);
};
const base = get("--base")?.replace(/\/+$/, "");
const token = get("--token");
if (!base || !token) {
  console.error("usage: node scripts/init-shared-monitors.mjs --base <worker url> --token <admin token>");
  process.exit(2);
}

const res = await fetch(`${base}/api/admin/init-shared`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
const body = await res.json().catch(() => null);
if (!res.ok || !body || !Array.isArray(body.shared)) {
  console.error(`init-shared answered HTTP ${res.status}: ${JSON.stringify(body)}`);
  process.exit(1);
}
let refused = false;
for (const m of body.shared) {
  if (m.monitor_id) console.log(`${m.registry}: monitor ${m.monitor_id} (${m.created ? "created now" : "already there"}) on ${m.url}`);
  else {
    refused = true;
    console.log(`${m.registry}: NOT created. TinyFish answered HTTP ${m.http_status ?? "?"} with code ${m.code ?? "?"}. Stop and report this; do not touch other monitors.`);
  }
}
process.exit(refused ? 1 : 0);
