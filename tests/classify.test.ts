import { describe, expect, it } from "vitest";
import { classifyRows } from "../src/core/classify";
import { CANDIDATES_MAX } from "../src/core/limits";
import { normalizePerson } from "../src/core/names";
import type { RegistryRow } from "../src/registries/types";

function row(name: string, over: Partial<RegistryRow> = {}): RegistryRow {
  return { name, number: null, status_raw: null, detail: null, url: null, ...over };
}

const person = (q: string) => ({ kind: "person" as const, normalized: normalizePerson(q) });
const business = (q: string) => ({ kind: "business" as const, normalized: q });

describe("classifyRows", () => {
  it("zero rows is no_match", () => {
    expect(classifyRows([], person("Christopher Wickfold"))).toEqual({ outcome: "no_match" });
    expect(classifyRows([], business("Greggs PLC"))).toEqual({ outcome: "no_match" });
  });

  it("one row whose name passes the match rule is a match", () => {
    // A query without middle names still matches a row that has them.
    const withMiddle = row("Christopher John Marlow WICKFOLD", { number: "9360749" });
    expect(classifyRows([withMiddle], person("Christopher Wickfold"))).toEqual({ outcome: "match", row: withMiddle });
    // Equal as printed, in any case.
    const plain = row("Christopher WICKFOLD", { number: "2" });
    expect(classifyRows([plain], person("Christopher Wickfold"))).toEqual({ outcome: "match", row: plain });
    // A query with middle names that the row has, in order.
    expect(classifyRows([withMiddle], person("Christopher Marlow Wickfold"))).toEqual({
      outcome: "match",
      row: withMiddle,
    });
    // Companies House style: a different spelling of the suffix and punctuation is the same name.
    const greggs = row("GREGGS P.L.C.", { number: "00502851" });
    expect(classifyRows([greggs], business("Greggs PLC"))).toEqual({ outcome: "match", row: greggs });
    const acme = row("ACME LIMITED", { number: "1" });
    expect(classifyRows([acme], business("Acme Ltd"))).toEqual({ outcome: "match", row: acme });
  });

  it("one row whose name fails the match rule is ambiguous with that one candidate, never a match", () => {
    // The same rule whichever search variant produced the row
    // (for example "wickfold c" returning "Christine WICKFOLD").
    const christine = row("Christine WICKFOLD", { number: "1111111", status_raw: "Registered with a licence to practise" });
    const result = classifyRows([christine], person("Christopher Wickfold"));
    expect(result).toEqual({ outcome: "ambiguous", candidates: [christine], total: 1 });
    expect(result).not.toHaveProperty("status");
    expect(result).not.toHaveProperty("row");

    // A query with a middle name that the row lacks, an initial that is not expanded,
    // and a longer registered company name are all failures too.
    const bare = row("Christopher WICKFOLD", { number: "2" });
    expect(classifyRows([bare], person("Christopher John Wickfold"))).toMatchObject({ outcome: "ambiguous", total: 1 });
    const john = row("Christopher John WICKFOLD", { number: "3" });
    expect(classifyRows([john], person("Christopher J Wickfold"))).toMatchObject({ outcome: "ambiguous", total: 1 });
    const greggs = row("GREGGS PLC", { number: "4" });
    expect(classifyRows([greggs], business("Greggs"))).toEqual({ outcome: "ambiguous", candidates: [greggs], total: 1 });
    expect(classifyRows([row("GREGGS FOODS LTD")], business("Greggs PLC"))).toMatchObject({
      outcome: "ambiguous",
      total: 1,
    });
  });

  it("a blank or unparseable query never matches, even against a single row", () => {
    const only = row("Christopher John Marlow WICKFOLD", { number: "9360749" });
    for (const q of ["", "   ", "Dr.", "..."]) {
      expect(classifyRows([only], person(q))).toEqual({ outcome: "ambiguous", candidates: [only], total: 1 });
      expect(classifyRows([only], { kind: "person", normalized: q })).toMatchObject({ outcome: "ambiguous" });
      expect(classifyRows([only], business(q))).toEqual({ outcome: "ambiguous", candidates: [only], total: 1 });
    }
    // A blank name on the register side equals nothing either.
    expect(classifyRows([row("")], person("Christopher Wickfold"))).toMatchObject({ outcome: "ambiguous", total: 1 });
    expect(classifyRows([row("")], person(""))).toMatchObject({ outcome: "ambiguous", total: 1 });
    // Several rows and a blank query: nothing is equal, so ambiguous.
    const rows = [only, row("Christine WICKFOLD")];
    expect(classifyRows(rows, person(""))).toEqual({ outcome: "ambiguous", candidates: rows, total: 2 });
  });

  it("several rows with exactly one exact-name row is a match on that row", () => {
    const rows = [
      row("Christine WICKFOLD", { number: "1" }),
      row("Christopher WICKFOLD", { number: "2" }),
      row("Christopher WHITLEY", { number: "3" }),
    ];
    expect(classifyRows(rows, person("Christopher Wickfold"))).toEqual({ outcome: "match", row: rows[1] });
  });

  it("a middle name on the register does not stop the match, and a middle name in the query must be on the register", () => {
    const rows = [
      row("Christopher WICKFOLD", { number: "1" }),
      row("Christopher John Marlow WICKFOLD", { number: "2" }),
      row("Christine WICKFOLD", { number: "3" }),
    ];
    // No middle name in the query: both Christophers match, so this is ambiguous.
    expect(classifyRows(rows, person("Christopher Wickfold"))).toMatchObject({ outcome: "ambiguous", total: 3 });
    // A middle name in the query singles out the row that has it.
    expect(classifyRows(rows, person("Christopher John Wickfold"))).toEqual({ outcome: "match", row: rows[1] });
    // ...and an initial is not expanded, so "J" does not find "John".
    expect(classifyRows(rows, person("Christopher J Wickfold"))).toMatchObject({ outcome: "ambiguous", total: 3 });
  });

  it("two rows with the same normalized name are ambiguous with both as candidates and no status", () => {
    // Syeda Varisha Amira Sickfold vs Syeda Humaira Sickfold for query 'Syeda Sickfold' -> ambiguous, 2 candidates.
    // One holds a licence to practise and one does not; that must not decide anything.
    const licensed = row("Syeda Varisha Amira SICKFOLD", {
      number: "7010000",
      status_raw: "Registered with a licence to practise",
    });
    const unlicensed = row("Syeda Humaira SICKFOLD", {
      number: "7020000",
      status_raw: "Registered without a licence to practise",
    });
    const result = classifyRows([licensed, unlicensed], person("Syeda Sickfold"));
    expect(result).toEqual({ outcome: "ambiguous", candidates: [licensed, unlicensed], total: 2 });
    expect(result).not.toHaveProperty("status");
    expect(result).not.toHaveProperty("row");

    // The order of rows does not change the answer.
    expect(classifyRows([unlicensed, licensed], person("Syeda Sickfold"))).toEqual({
      outcome: "ambiguous",
      candidates: [unlicensed, licensed],
      total: 2,
    });
    // And a query that passes the normalized person gives the same answer as a plain string.
    expect(classifyRows([licensed, unlicensed], { kind: "person", normalized: "Syeda Sickfold" })).toEqual(result);
  });

  it("two rows with literally the same printed name are ambiguous even when one has a licence and one does not", () => {
    const a = row("John SMITH", { number: "1", status_raw: "Registered with a licence to practise" });
    const b = row("John SMITH", { number: "2", status_raw: "Registered without a licence to practise" });
    const result = classifyRows([a, b], person("John Smith"));
    expect(result).toEqual({ outcome: "ambiguous", candidates: [a, b], total: 2 });
    expect(result).not.toHaveProperty("status");
  });

  it("several rows and none with the query's name is ambiguous, not no_match", () => {
    const rows = [row("Christine WICKFOLD"), row("Christopher WHITLEY"), row("Chris WICKFOLD")];
    expect(classifyRows(rows, person("Christopher Wickfold"))).toEqual({
      outcome: "ambiguous",
      candidates: rows,
      total: 3,
    });
  });

  it("candidates are capped at 10 with total preserved", () => {
    expect(CANDIDATES_MAX).toBe(10);
    const rows = Array.from({ length: 12 }, (_, i) => row("John SMITH", { number: String(i) }));
    const result = classifyRows(rows, person("John Smith"));
    expect(result.outcome).toBe("ambiguous");
    if (result.outcome !== "ambiguous") throw new Error("unreachable");
    expect(result.candidates).toHaveLength(CANDIDATES_MAX);
    expect(result.candidates).toEqual(rows.slice(0, CANDIDATES_MAX));
    expect(result.total).toBe(12);

    // Exactly at the cap nothing is cut.
    const ten = classifyRows(rows.slice(0, 10), person("John Smith"));
    expect(ten).toMatchObject({ outcome: "ambiguous", total: 10 });
    if (ten.outcome !== "ambiguous") throw new Error("unreachable");
    expect(ten.candidates).toHaveLength(10);
  });

  it("when ambiguous, the exact-name rows come first so the cap cannot cut the rows that caused the ambiguity", () => {
    const filler = (i: number) => row(`Jonathan SMITH${i}`, { number: `f${i}` });
    const first = Array.from({ length: 10 }, (_, i) => filler(i));
    const a = row("John SMITH", { number: "a", status_raw: "Registered with a licence to practise" });
    const b = row("JOHN Smith", { number: "b", status_raw: "Registered without a licence to practise" });
    // A Companies House page has up to 20 rows: the two equal-name rows sit at positions 11 and 12.
    const rows = [...first, a, b, filler(10), filler(11)];
    const result = classifyRows(rows, person("John Smith"));
    if (result.outcome !== "ambiguous") throw new Error(`expected ambiguous, got ${result.outcome}`);
    expect(result.total).toBe(14);
    expect(result.candidates).toHaveLength(CANDIDATES_MAX);
    expect(result.candidates.slice(0, 2)).toEqual([a, b]);
    // The rest follow in registry order.
    expect(result.candidates.slice(2)).toEqual(first.slice(0, 8));
  });

  it("exact-name rows keep registry order among themselves, and the other rows keep theirs", () => {
    const rows = [
      row("Jonathan SMITH", { number: "0" }),
      row("Jane SMITH", { number: "1" }),
      row("John SMITH", { number: "2" }),
      row("Jon SMITH", { number: "3" }),
      row("John SMITH", { number: "4" }),
      row("Joan SMITH", { number: "5" }),
    ];
    const result = classifyRows(rows, person("John Smith"));
    expect(result).toEqual({
      outcome: "ambiguous",
      candidates: [rows[2], rows[4], rows[0], rows[1], rows[3], rows[5]],
      total: 6,
    });
  });

  it("with no exact-name row the candidates stay in registry order", () => {
    const rows = Array.from({ length: 13 }, (_, i) => row(`Jonathan SMITH${i}`, { number: String(i) }));
    const result = classifyRows(rows, person("John Smith"));
    expect(result).toEqual({ outcome: "ambiguous", candidates: rows.slice(0, CANDIDATES_MAX), total: 13 });
  });

  it("a backtick in a surname does not make 'Maria D`SOUZA' equal 'Maria Souza'", () => {
    const rows = [row("Maria D`SOUZA", { number: "1" }), row("Maria Silva", { number: "2" })];
    // Neither row is "Maria Souza": ambiguous, never a guess.
    expect(classifyRows(rows, person("Maria Souza"))).toEqual({ outcome: "ambiguous", candidates: rows, total: 2 });
    // The person who really is D'Souza is found, whichever apostrophe the register prints.
    expect(classifyRows(rows, person("Maria D'Souza"))).toEqual({ outcome: "match", row: rows[0] });
    expect(classifyRows(rows, person("Maria D’Souza"))).toEqual({ outcome: "match", row: rows[0] });
  });

  it("an exact-name row among more than the cap still wins, wherever it sits", () => {
    const rows = Array.from({ length: 14 }, (_, i) => row(`Jonathan SMITH${i}`, { number: String(i) }));
    const exact = row("John SMITH", { number: "99" });
    rows.splice(12, 0, exact);
    expect(classifyRows(rows, person("John Smith"))).toEqual({ outcome: "match", row: exact });
  });

  it("does not mutate or alias the input rows", () => {
    const rows = Array.from({ length: 11 }, (_, i) => row("John SMITH", { number: String(i) }));
    const copy = rows.slice();
    const result = classifyRows(rows, person("John Smith"));
    expect(rows).toEqual(copy);
    if (result.outcome !== "ambiguous") throw new Error("unreachable");
    expect(result.candidates).not.toBe(rows);
  });

  describe("businesses", () => {
    it("exactly one row whose registered name equals the query is a match (Companies House search is fuzzy)", () => {
      const rows = [
        row("GREGGS (HOLDINGS) LIMITED", { number: "01" }),
        row("GREGGS PLC", { number: "00502851" }),
        row("GREGGS PROPERTIES LTD", { number: "03" }),
      ];
      expect(classifyRows(rows, business("Greggs P.L.C."))).toEqual({ outcome: "match", row: rows[1] });
      expect(classifyRows(rows, business("Greggs Holdings Limited"))).toEqual({ outcome: "match", row: rows[0] });
    });

    it("two rows with the same normalized name are ambiguous", () => {
      const a = row("ACME LTD", { number: "1", status_raw: "Active" });
      const b = row("Acme Limited", { number: "2", status_raw: "Dissolved" });
      expect(classifyRows([a, b], business("Acme Ltd"))).toEqual({
        outcome: "ambiguous",
        candidates: [a, b],
        total: 2,
      });
    });

    it("a longer registered name is not the same company", () => {
      const rows = [row("ACME HOLDINGS LTD"), row("ACME TRADING LTD")];
      expect(classifyRows(rows, business("Acme Ltd"))).toMatchObject({ outcome: "ambiguous", total: 2 });
    });

    it("a normalized person object passed for a business falls back to its display string", () => {
      const rows = [row("GREGGS PLC"), row("GREGGS FOODS LTD")];
      expect(classifyRows(rows, { kind: "business", normalized: normalizePerson("Greggs plc") })).toEqual({
        outcome: "match",
        row: rows[0],
      });
    });
  });
});
