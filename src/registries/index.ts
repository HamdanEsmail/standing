import { caDca } from "./ca-dca";
import { companiesHouse } from "./companies-house";
import { flSunbiz } from "./fl-sunbiz";
import { gmc } from "./gmc";
import { nmc } from "./nmc";
import { sra } from "./sra";
import type { Jurisdiction, RecordType, RegistryAdapter } from "./types";

// Every adapter the API answers with, in the order of the coverage table (spec section 6). The CSLB
// adapter (src/registries/cslb.ts) stays in the repository but is not listed: its licence pages show no
// licence data to automated tools (9 Nov 2026), so CSLB is in UNSUPPORTED.
const ADAPTERS: RegistryAdapter[] = [gmc, nmc, sra, companiesHouse, caDca, flSunbiz];

/** The (jurisdiction, record type) pairs the service answers, and the registry that answers
 *  each. Derived from the adapters, so adding an adapter adds its rows. */
export const SUPPORTED: { jurisdiction: Jurisdiction; record_type: RecordType; registry: string }[] = ADAPTERS.flatMap(
  (adapter) => adapter.recordTypes.map((record_type) => ({ jurisdiction: adapter.country, record_type, registry: adapter.id })),
);

/** Registries checked and found unreadable (spec section 3). The coverage table lists them
 *  with these reasons; there is no adapter. `reason` is the TinyFetch error code, or what was
 *  seen where there was none. */
export const UNSUPPORTED: { registry: string; country: string; reason: string }[] = [
  { registry: "UK FCA register", country: "GB", reason: "target_unreachable" },
  { registry: "New York Office of Professions", country: "US-NY", reason: "target_http_error" },
  { registry: "New York DOS corporations", country: "US-NY", reason: "empty_content" },
  { registry: "Dubai DHA Sheryan", country: "AE", reason: 'JavaScript app: the page reads as "Home"' },
  { registry: "CA Contractors State License Board", country: "US-CA", reason: "the licence page cannot be read reliably by automated tools yet" },
  {
    registry: "Medical Council of New Zealand",
    country: "NZ",
    reason: "a doctor's own register page shows no registration status to automated reads; it appears only in search lists, and Standing never takes a status from a search row",
  },
];

export function listAdapters(): RegistryAdapter[] {
  return [...ADAPTERS];
}

/** The adapter with this id, or null. Compares ids, so "constructor" is not a registry. */
export function getAdapterById(id: string): RegistryAdapter | null {
  return ADAPTERS.find((adapter) => adapter.id === id) ?? null;
}

/** The adapter that answers this (jurisdiction, record type), or null when none does. */
export function getAdapter(jurisdiction: Jurisdiction, recordType: RecordType): RegistryAdapter | null {
  const hit = SUPPORTED.find((s) => s.jurisdiction === jurisdiction && s.record_type === recordType);
  return hit === undefined ? null : getAdapterById(hit.registry);
}
