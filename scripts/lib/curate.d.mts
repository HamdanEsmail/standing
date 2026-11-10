// Types for scripts/lib/curate.mjs (plain JavaScript so Node runs it without a build step).
export interface CurateTarget {
  id: string;
  label: string;
  query: string;
  check: { record_type: string; jurisdiction: string };
  kind: "person" | "company";
}
export interface Candidate {
  name: string;
  date: string;
  url: string;
  title: string;
}
export const TARGETS: CurateTarget[];
export const NAMING_RULE: string;
export const WINDOW_END: string;
export function datesIn(text: string): string[];
export function selectCandidates(
  results: { url: string; title: string; snippet: string }[],
  opts: { now: string; windowEnd?: string; kind?: "person" | "company" },
): Candidate[];
export function curatedWatchesMarkdown(
  rows: { target: string; name: string; registry: string; licence_number: string | null; source: string; watch_id: string; date: string }[],
  generatedAt: string,
): string;
