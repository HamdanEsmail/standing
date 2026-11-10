// The curate script's selection rule: candidates must name someone and print a date inside the window.
import { describe, expect, it } from "vitest";
import { selectCandidates } from "../scripts/lib/curate.mjs";

const hit = (title: string, snippet: string, url = `https://example.org/${encodeURIComponent(title)}`) => ({ url, title, snippet });

describe("selectCandidates", () => {
  it("keeps results with a name and a date inside the window, at most 5, ordered by date", () => {
    const results = [
      hit("MPTS hearing: Dr Ada Fictitious", "Hearing listed for 14 November 2026"),
      hit("Medical Practitioners Tribunal Service news", "Hearings in November 2026"), // no person, no day
      hit("Bo Imaginary tribunal outcome", "Hearing held on 2 October 2026"), // date before the window
      hit("Cy Madeup hearing", "Listed for 20 November 2026"), // date after 17 Nov
      hit("FICTITIOUS, Bob", "12/11/2026 hearing"),
      hit("Dee Notreal", "Nov 10, 2026 hearing"),
      hit("Eve Pretend", "2026-11-16"),
      hit("Fay Invented", "11 November 2026"),
      hit("Gus Unreal", "13 November 2026"),
    ];
    const out = selectCandidates(results, { now: "2026-11-10T08:00:00Z" });
    expect(out).toHaveLength(5);
    expect(out.map((c) => [c.name, c.date])).toEqual([
      ["Dee Notreal", "2026-11-10"],
      ["Fay Invented", "2026-11-11"],
      ["Bob Fictitious", "2026-11-12"],
      ["Gus Unreal", "2026-11-13"],
      ["Ada Fictitious", "2026-11-14"],
    ]);
    // A company target needs a Gazette notice more than two months old.
    const companies = selectCandidates(
      [hit("FICTIONAL ROOFING LIMITED", "Proposal to strike off, 1 September 2026"), hit("MADEUP TRADING LTD", "Proposal to strike off, 1 November 2026")],
      { now: "2026-11-10", kind: "company" },
    );
    expect(companies.map((c) => c.name)).toEqual(["FICTIONAL ROOFING LIMITED"]);
  });
});
