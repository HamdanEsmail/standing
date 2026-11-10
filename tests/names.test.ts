import { describe, expect, it } from "vitest";
import {
  businessNamesEqual,
  normalizeBusiness,
  normalizePerson,
  personNamesEqual,
  variantsFor,
} from "../src/core/names";

describe("normalizePerson", () => {
  it("strips titles, reorders SURNAME, Given, keeps hyphens", () => {
    expect(normalizePerson("Dr. WICKFOLD, Christopher J.").display).toBe("christopher j wickfold");
    expect(normalizePerson("Prof Anne-Marie O'Neill").surname).toBe("o'neill");
    expect(normalizePerson("Prof Anne-Marie O'Neill").given).toBe("anne-marie");
  });

  it("splits given, middle and surname", () => {
    expect(normalizePerson("Christopher John Marlow Wickfold")).toEqual({
      given: "christopher",
      middle: ["john", "marlow"],
      surname: "wickfold",
      display: "christopher john marlow wickfold",
    });
    expect(normalizePerson("Dr. WICKFOLD, Christopher J.")).toEqual({
      given: "christopher",
      middle: ["j"],
      surname: "wickfold",
      display: "christopher j wickfold",
    });
  });

  it("reads the register's own print form: given names first, surname in capitals", () => {
    expect(normalizePerson("Christopher John Marlow WICKFOLD").display).toBe("christopher john marlow wickfold");
    expect(normalizePerson("Rachael Rebecca BICKFOLD")).toMatchObject({
      given: "rachael",
      middle: ["rebecca"],
      surname: "bickfold",
    });
  });

  it("strips every listed title and postnominal, in front or behind", () => {
    for (const title of ["Dr", "Mr", "Mrs", "Ms", "Miss", "Mx", "Prof", "Sir", "Dame"]) {
      expect(normalizePerson(`${title} Jane Doe`).display).toBe("jane doe");
      expect(normalizePerson(`${title}. Jane Doe`).display).toBe("jane doe");
    }
    for (const post of ["Esq", "MD", "M.D.", "MBBS", "PhD", "Ph.D.", "QC", "KC"]) {
      expect(normalizePerson(`Jane Doe ${post}`).display).toBe("jane doe");
      expect(normalizePerson(`DOE, Jane, ${post}`).display).toBe("jane doe");
    }
    expect(normalizePerson("Prof Sir Christopher Wickfold KC").display).toBe("christopher wickfold");
  });

  it("does not strip a title word that is really part of the name", () => {
    // "Dame" and "Sir" are only honorifics in front; "Md" is only a postnominal behind.
    expect(normalizePerson("Jane Dame").surname).toBe("dame");
    expect(normalizePerson("Md Rarrowby").given).toBe("md");
  });

  it("collapses whitespace and case-folds", () => {
    expect(normalizePerson("   CHRISTOPHER \t  john\n wickfold ").display).toBe("christopher john wickfold");
  });

  it("folds curly apostrophes to a straight one and keeps hyphenated names as one token", () => {
    expect(normalizePerson("Siobhan O’Neill").surname).toBe("o'neill");
    expect(normalizePerson("Siobhan O‘Neill").surname).toBe("o'neill");
    const p = normalizePerson("Anne-Marie Smith-Jones");
    expect(p.given).toBe("anne-marie");
    expect(p.surname).toBe("smith-jones");
    expect(p.middle).toEqual([]);
  });

  it("treats a single token as a surname with an empty given name", () => {
    expect(normalizePerson("Wickfold")).toEqual({ given: "", middle: [], surname: "wickfold", display: "wickfold" });
    expect(normalizePerson("Dr. WICKFOLD")).toEqual({ given: "", middle: [], surname: "wickfold", display: "wickfold" });
  });

  it("returns an empty name for blank input", () => {
    expect(normalizePerson("   ")).toEqual({ given: "", middle: [], surname: "", display: "" });
    expect(normalizePerson("Dr.")).toEqual({ given: "", middle: [], surname: "", display: "" });
  });

  it("takes the whole text before the comma as the surname", () => {
    // Choice: "VAN DER BERG, Jan" keeps a multi-word surname. It will not equal the
    // natural-order "Jan van der Berg" (surname "berg"), which errs towards ambiguous.
    expect(normalizePerson("VAN DER BERG, Jan")).toEqual({
      given: "jan",
      middle: [],
      surname: "van der berg",
      display: "jan van der berg",
    });
  });

  it("round-trips its own display string", () => {
    for (const input of ["Dr. WICKFOLD, Christopher J.", "Prof Anne-Marie O'Neill", "Wickfold", "Christopher John Marlow WICKFOLD"]) {
      const once = normalizePerson(input);
      expect(normalizePerson(once.display)).toEqual(once);
    }
  });
});

describe("variantsFor", () => {
  it("variants are ordered and deduped; surname-only only when allowed", () => {
    expect(variantsFor(normalizePerson("Christopher John Wickfold"), true)).toEqual([
      "christopher john wickfold",
      "christopher wickfold",
      "wickfold c",
      "wickfold",
    ]);
    expect(variantsFor(normalizePerson("Christopher Wickfold"), false)).toEqual(["christopher wickfold", "wickfold c"]);
  });

  it("dedupes the full name against given + surname when there is no middle name", () => {
    expect(variantsFor(normalizePerson("Christopher Wickfold"), true)).toEqual([
      "christopher wickfold",
      "wickfold c",
      "wickfold",
    ]);
  });

  it("keeps hyphens and apostrophes in variants and takes the initial from the first letter of the given name", () => {
    expect(variantsFor(normalizePerson("Prof Anne-Marie O'Neill"), true)).toEqual([
      "anne-marie o'neill",
      "o'neill a",
      "o'neill",
    ]);
  });

  it("a single-token input is a surname: one variant when surname-only is allowed, none when it is not", () => {
    expect(variantsFor(normalizePerson("Wickfold"), true)).toEqual(["wickfold"]);
    // Choice: no variants at all, so the caller says so instead of searching a form the registry cannot answer.
    expect(variantsFor(normalizePerson("Wickfold"), false)).toEqual([]);
  });

  it("a blank name has no variants", () => {
    expect(variantsFor(normalizePerson(""), true)).toEqual([]);
    expect(variantsFor(normalizePerson(""), false)).toEqual([]);
  });

  it("dedupes when the given name is already an initial", () => {
    expect(variantsFor(normalizePerson("C Wickfold"), false)).toEqual(["c wickfold", "wickfold c"]);
  });
});

describe("personNamesEqual", () => {
  it("a query without middle names matches a candidate with them, not the reverse", () => {
    expect(personNamesEqual("Christopher Wickfold", "Christopher John Marlow Wickfold")).toBe(true);
    expect(personNamesEqual("Christopher John Wickfold", "Christopher Wickfold")).toBe(false);
  });

  it("a query with middle names matches only when every one appears in the candidate, in order", () => {
    const candidate = "Christopher John Marlow Wickfold";
    expect(personNamesEqual("Christopher John Wickfold", candidate)).toBe(true);
    expect(personNamesEqual("Christopher Marlow Wickfold", candidate)).toBe(true);
    expect(personNamesEqual("Christopher John Marlow Wickfold", candidate)).toBe(true);
    expect(personNamesEqual("Christopher Marlow John Wickfold", candidate)).toBe(false);
    expect(personNamesEqual("Christopher Peter Wickfold", candidate)).toBe(false);
    expect(personNamesEqual("Christopher John Marlow Peter Wickfold", candidate)).toBe(false);
  });

  it("repeated middle names need as many occurrences in the candidate", () => {
    expect(personNamesEqual("Ann Mary Mary Lee", "Ann Mary Rose Mary Lee")).toBe(true);
    expect(personNamesEqual("Ann Mary Mary Lee", "Ann Mary Rose Lee")).toBe(false);
  });

  it("does not expand initials either way", () => {
    expect(personNamesEqual("Christopher J Wickfold", "Christopher John Wickfold")).toBe(false);
    expect(personNamesEqual("Christopher John Wickfold", "Christopher J Wickfold")).toBe(false);
    expect(personNamesEqual("C Wickfold", "Christopher Wickfold")).toBe(false);
    expect(personNamesEqual("Christopher J Wickfold", "Christopher J Wickfold")).toBe(true);
  });

  it("given name and surname must be equal", () => {
    expect(personNamesEqual("Christopher Wickfold", "Christine Wickfold")).toBe(false);
    expect(personNamesEqual("Christopher Wickfold", "Christopher Whitley")).toBe(false);
    expect(personNamesEqual("Christopher Wickfold", "Wickfold Christopher")).toBe(false);
  });

  it("is case-folded and ignores titles and word order notation", () => {
    expect(personNamesEqual("Christopher Wickfold", "Christopher John Marlow WICKFOLD")).toBe(true);
    expect(personNamesEqual("Rachael Bickfold", "Rachael Rebecca BICKFOLD")).toBe(true);
    expect(personNamesEqual("Dr. WICKFOLD, Christopher J.", "Christopher John Marlow WICKFOLD")).toBe(false);
    expect(personNamesEqual("Dr. WICKFOLD, Christopher", "Christopher John Marlow WICKFOLD")).toBe(true);
    expect(personNamesEqual("  christopher   wickfold ", "CHRISTOPHER WICKFOLD")).toBe(true);
  });

  it("folds curly apostrophes and keeps hyphenated names as one token", () => {
    expect(personNamesEqual("Siobhan O’Neill", "SIOBHAN O'NEILL")).toBe(true);
    expect(personNamesEqual("Anne-Marie Smith", "Anne-Marie Smith")).toBe(true);
    expect(personNamesEqual("Anne-Marie Smith", "Anne Marie Smith")).toBe(false);
    expect(personNamesEqual("Anne Marie Smith", "Anne-Marie Smith")).toBe(false);
  });

  it("accepts normalizePerson results as well as strings", () => {
    const q = normalizePerson("Christopher Wickfold");
    const c = normalizePerson("Christopher John Marlow Wickfold");
    expect(personNamesEqual(q, c)).toBe(true);
    expect(personNamesEqual(q, "Christopher John Marlow Wickfold")).toBe(true);
    expect(personNamesEqual("Christopher Wickfold", c)).toBe(true);
    expect(personNamesEqual(c, q)).toBe(false);
  });

  it("a multi-word comma-form surname equals itself but not a natural-order reading of it", () => {
    const q = normalizePerson("VAN DER BERG, Jan");
    expect(personNamesEqual(q, "VAN DER BERG, Jan")).toBe(true);
    expect(personNamesEqual(q, "Jan van der Berg")).toBe(false);
  });

  it("a single-token name equals only the same single token", () => {
    expect(personNamesEqual("Wickfold", "Wickfold")).toBe(true);
    expect(personNamesEqual("Wickfold", "Christopher Wickfold")).toBe(false);
  });

  it("a blank name equals nothing, not even another blank name", () => {
    expect(personNamesEqual("", "")).toBe(false);
    expect(personNamesEqual("Dr.", "")).toBe(false);
    expect(personNamesEqual("", "Christopher Wickfold")).toBe(false);
    expect(personNamesEqual("Christopher Wickfold", "")).toBe(false);
  });
});

describe("business names", () => {
  it("business names normalize suffixes and punctuation", () => {
    expect(businessNamesEqual("Greggs PLC", "GREGGS P.L.C.")).toBe(true);
    expect(businessNamesEqual("Acme Ltd", "Acme Limited")).toBe(true);
    expect(businessNamesEqual("Acme Ltd", "Acme Holdings Ltd")).toBe(false);
  });

  it("normalizeBusiness case-folds, strips punctuation and collapses whitespace", () => {
    expect(normalizeBusiness("GREGGS P.L.C.")).toBe("greggs plc");
    expect(normalizeBusiness("  Rolls-Royce   Holdings,  PLC ")).toBe("rolls royce holdings plc");
    expect(normalizeBusiness("Sainsbury’s (Supermarkets) Ltd.")).toBe("sainsburys supermarkets ltd");
  });

  it("maps the suffix words and keeps the suffix", () => {
    expect(normalizeBusiness("Acme Limited")).toBe("acme ltd");
    expect(normalizeBusiness("Acme Public Limited Company")).toBe("acme plc");
    expect(normalizeBusiness("Acme Incorporated")).toBe("acme inc");
    expect(normalizeBusiness("Acme Company")).toBe("acme co");
    expect(normalizeBusiness("Acme LLP")).toBe("acme llp");
    expect(normalizeBusiness("Acme L.L.C.")).toBe("acme llc");
  });

  it("treats & and 'and' as the same word", () => {
    expect(businessNamesEqual("Smith & Sons Ltd", "SMITH AND SONS LIMITED")).toBe(true);
    expect(businessNamesEqual("Smith & Sons Ltd", "Smith Sons Ltd")).toBe(false);
  });

  it("different suffixes are different companies", () => {
    expect(businessNamesEqual("Acme Ltd", "Acme LLP")).toBe(false);
    expect(businessNamesEqual("Acme Ltd", "Acme")).toBe(false);
    expect(businessNamesEqual("Acme Inc", "Acme Ltd")).toBe(false);
  });

  it("round-trips its own output", () => {
    for (const input of ["GREGGS P.L.C.", "Acme Public Limited Company", "Smith & Sons Limited", "Acme Company Limited"]) {
      const once = normalizeBusiness(input);
      expect(normalizeBusiness(once)).toBe(once);
    }
  });

  it("a blank name equals nothing", () => {
    expect(businessNamesEqual("", "")).toBe(false);
    expect(businessNamesEqual("...", "")).toBe(false);
  });
});

describe("apostrophe look-alikes and stray punctuation", () => {
  const ch = (code: number) => String.fromCodePoint(code);
  // Everything a keyboard, a word processor or a registry may print for an apostrophe.
  const lookalikes: [string, number][] = [
    ["grave accent / backtick", 0x0060],
    ["acute accent", 0x00b4],
    ["modifier letter prime", 0x02b9],
    ["modifier letter turned comma", 0x02bb],
    ["modifier letter apostrophe", 0x02bc],
    ["modifier letter reversed comma", 0x02bd],
    ["modifier letter vertical line", 0x02c8],
    ["left single quotation mark", 0x2018],
    ["right single quotation mark", 0x2019],
    ["single high-reversed-9 quotation mark", 0x201b],
    ["prime", 0x2032],
    ["reversed prime", 0x2035],
    ["latin small letter saltillo", 0xa78c],
    ["fullwidth apostrophe", 0xff07],
  ];

  it.each(lookalikes)("%s folds to a straight apostrophe, so it never splits the surname", (_name, code) => {
    const a = ch(code);
    expect(normalizePerson(`Maria D${a}SOUZA`)).toEqual({
      given: "maria",
      middle: [],
      surname: "d'souza",
      display: "maria d'souza",
    });
    expect(personNamesEqual(`Maria D${a}Souza`, "MARIA D'SOUZA")).toBe(true);
    expect(personNamesEqual("Maria D'Souza", `Maria D${a}SOUZA`)).toBe(true);
    // "d'souza" is a different surname from "souza".
    expect(personNamesEqual("Maria Souza", `Maria D${a}SOUZA`)).toBe(false);
    expect(personNamesEqual(`Maria D${a}SOUZA`, "Maria Souza")).toBe(false);
    // The business rule drops apostrophes, and does so for the look-alikes too.
    expect(businessNamesEqual(`D${a}Souza Ltd`, "D'Souza Limited")).toBe(true);
  });

  it("a backtick surname is not read as a middle name (the Maria D`SOUZA trace)", () => {
    const p = normalizePerson("Maria D`SOUZA");
    expect(p.middle).toEqual([]);
    expect(p.surname).toBe("d'souza");
    expect(personNamesEqual("Maria Souza", "Maria D`SOUZA")).toBe(false);
  });

  it("a markdown escape in front of punctuation is dropped, so it cannot split the surname either", () => {
    const bs = String.fromCharCode(0x5c);
    const cases: [string, string, string][] = [
      ["backtick", `Maria D${bs}${ch(0x60)}SOUZA`, "d'souza"],
      ["apostrophe", `Maria D${bs}'SOUZA`, "d'souza"],
      ["underscore", `Maria D${bs}_SOUZA`, "dsouza"],
    ];
    for (const [label, input, surname] of cases) {
      const p = normalizePerson(input);
      expect(p, label).toEqual({ given: "maria", middle: [], surname, display: `maria ${surname}` });
      expect(personNamesEqual("Maria Souza", input), label).toBe(false);
      expect(personNamesEqual(input, "Maria Souza"), label).toBe(false);
    }
    expect(personNamesEqual("Maria D'Souza", `Maria D${bs}${ch(0x60)}SOUZA`)).toBe(true);
    // The business rule reads the escaped form the same way.
    expect(businessNamesEqual(`D${bs}${ch(0x60)}Souza Ltd`, "D'Souza Limited")).toBe(true);
    expect(businessNamesEqual(`Smith ${bs}& Sons Ltd`, "Smith & Sons Limited")).toBe(true);
  });

  it("a backslash is not a word separator: between two letters it is just a stray character", () => {
    expect(normalizePerson(`Maria Silva${String.fromCharCode(0x5c)}Souza`)).toMatchObject({
      given: "maria",
      middle: [],
      surname: "silvasouza",
    });
  });

  it("an apostrophe look-alike at the edge of a word is dropped, as a quote mark would be", () => {
    expect(normalizePerson("`Maria` Souza").display).toBe("maria souza");
    expect(normalizePerson("Maria Souza’").display).toBe("maria souza");
  });

  it("other punctuation inside a word is deleted, so a stray character cannot create a middle name", () => {
    for (const stray of ["*", "_", "#", "@", "!", "?", "%", "~", "^", "$", ch(0x00b7), ch(0x2022), ch(0x2027)]) {
      const p = normalizePerson(`Maria D${stray}Souza`);
      expect(p).toEqual({ given: "maria", middle: [], surname: "dsouza", display: "maria dsouza" });
      expect(personNamesEqual("Maria Souza", `Maria D${stray}Souza`)).toBe(false);
    }
    // Several stray characters in a row, and next to an apostrophe or a hyphen.
    expect(normalizePerson("Maria D**Souza").surname).toBe("dsouza");
    expect(normalizePerson("Maria D'*Souza").surname).toBe("d'souza");
    expect(normalizePerson("Maria Smith-*Jones").surname).toBe("smith-jones");
    // The given name is protected too.
    expect(normalizePerson("Mar*ia Souza")).toMatchObject({ given: "maria", middle: [], surname: "souza" });
  });

  it("real separators between words still separate them", () => {
    expect(normalizePerson("Jane Doe(MD)").display).toBe("jane doe");
    expect(normalizePerson("Christopher (Chris) Wickfold")).toMatchObject({ given: "christopher", middle: ["chris"] });
    expect(normalizePerson("Maria Silva/Souza")).toMatchObject({ given: "maria", middle: ["silva"], surname: "souza" });
    expect(normalizePerson("Maria Silva;Souza")).toMatchObject({ given: "maria", middle: ["silva"], surname: "souza" });
  });

  it("stray punctuation at the edge of a word still just disappears", () => {
    expect(normalizePerson("Maria *Souza*").display).toBe("maria souza");
    expect(normalizePerson("Maria ... Souza").display).toBe("maria souza");
  });
});
