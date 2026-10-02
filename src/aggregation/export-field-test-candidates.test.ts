import { describe, expect, it } from "vitest";
import {
  buildCandidateName,
  buildCandidateRow,
  meanOccupancyToPct,
  parseCliOptions,
  resolveIsoDayAndHour,
  rowsToCsv,
} from "./export-field-test-candidates.ts";
import type { CandidateBlockface, FieldTestCandidateRow } from "./export-field-test-candidates.ts";

describe("parseCliOptions", () => {
  it("parses a real, minimal invocation with only --area, defaulting to paid-only", () => {
    expect(parseCliOptions(["--area=Ballard"])).toEqual({
      area: "Ballard",
      subarea: null,
      isoDay: null,
      hour: null,
      outPath: null,
      includeUnpaid: false,
    });
  });

  it("parses every flag when all are given, including --include-unpaid", () => {
    expect(parseCliOptions(["--area=South Lake Union", "--subarea=North", "--day=2", "--hour=14", "--out=/tmp/x.csv", "--include-unpaid"])).toEqual({
      area: "South Lake Union",
      subarea: "North",
      isoDay: 2,
      hour: 14,
      outPath: "/tmp/x.csv",
      includeUnpaid: true,
    });
  });

  it("defaults includeUnpaid to false when --include-unpaid is not passed", () => {
    expect(parseCliOptions(["--area=Ballard"]).includeUnpaid).toBe(false);
  });

  it("throws when --area is missing -- there is no sensible default area", () => {
    expect(() => parseCliOptions([])).toThrow(/--area/);
  });

  it("throws when --area is present but empty", () => {
    expect(() => parseCliOptions(["--area="])).toThrow(/--area/);
  });

  it("throws on a --day outside 1-7 (a discrete, fixed-domain input, not a value to clamp)", () => {
    expect(() => parseCliOptions(["--area=Ballard", "--day=8"])).toThrow(/--day/);
    expect(() => parseCliOptions(["--area=Ballard", "--day=0"])).toThrow(/--day/);
  });

  it("throws on a non-integer --day", () => {
    expect(() => parseCliOptions(["--area=Ballard", "--day=2.5"])).toThrow(/--day/);
    expect(() => parseCliOptions(["--area=Ballard", "--day=nope"])).toThrow(/--day/);
  });

  it("throws on an --hour outside 0-23", () => {
    expect(() => parseCliOptions(["--area=Ballard", "--hour=24"])).toThrow(/--hour/);
    expect(() => parseCliOptions(["--area=Ballard", "--hour=-1"])).toThrow(/--hour/);
  });
});

describe("resolveIsoDayAndHour", () => {
  it("uses the explicit --day/--hour when both are given, ignoring the current time", () => {
    const now = new Date(2026, 0, 1, 9); // a Thursday, 9am -- deliberately different from the override
    expect(resolveIsoDayAndHour({ isoDay: 3, hour: 17 }, now)).toEqual({ isoDay: 3, hour: 17 });
  });

  it("defaults to the real current ISO day/hour when neither is given", () => {
    const now = new Date(2026, 0, 6, 14, 30); // 2026-01-06 is a real Tuesday
    expect(resolveIsoDayAndHour({ isoDay: null, hour: null }, now)).toEqual({ isoDay: 2, hour: 14 });
  });

  it("correctly remaps a real Sunday to ISO day 7, not JS's native 0", () => {
    const now = new Date(2026, 0, 4, 10); // 2026-01-04 is a real Sunday
    expect(resolveIsoDayAndHour({ isoDay: null, hour: null }, now)).toEqual({ isoDay: 7, hour: 10 });
  });

  it("lets an explicit --day of 0 still be overridden -- null is the only 'unset' signal", () => {
    // isoDay: null is the only way to request "use now"; any real integer
    // the CLI parser already validated (1-7) passes through untouched.
    const now = new Date(2026, 0, 1, 9);
    expect(resolveIsoDayAndHour({ isoDay: 1, hour: 0 }, now)).toEqual({ isoDay: 1, hour: 0 });
  });
});

describe("buildCandidateName", () => {
  it("formats a real street/cross-street pair the same way the rest of the app displays one", () => {
    expect(buildCandidateName("8TH AVE N", "ALOHA ST", "WESTLAKE S AVE N")).toBe("8TH AVE N (ALOHA ST-WESTLAKE S AVE N)");
  });
});

describe("meanOccupancyToPct", () => {
  it("converts a real 0-1 fraction to a rounded whole percent", () => {
    expect(meanOccupancyToPct(0.437)).toBe(44);
    expect(meanOccupancyToPct(0)).toBe(0);
    expect(meanOccupancyToPct(1)).toBe(100);
  });

  it("throws on a structurally invalid value (NaN/Infinity), not a merely out-of-range one", () => {
    expect(() => meanOccupancyToPct(NaN)).toThrow(RangeError);
    expect(() => meanOccupancyToPct(Infinity)).toThrow(RangeError);
    expect(() => meanOccupancyToPct(-Infinity)).toThrow(RangeError);
  });
});

const SLU_NORTH_BLOCKFACE: CandidateBlockface = {
  sourceElementKey: 53550,
  sideOfStreet: "E",
  streetName: "8TH AVE N",
  crossStreetFrom: "ALOHA ST",
  crossStreetTo: "WESTLAKE S AVE N",
  paidParkingArea: "South Lake Union",
  paidParkingSubarea: "North",
};

describe("buildCandidateRow", () => {
  it("carries the real, DB-sourced area AND subarea through onto the row -- the exact detail last round's fixture was missing", () => {
    const row = buildCandidateRow(SLU_NORTH_BLOCKFACE, 0.18);
    expect(row).toEqual({
      name: "8TH AVE N (ALOHA ST-WESTLAKE S AVE N)",
      sourceElementKey: 53550,
      sideOfStreet: "E",
      paidParkingArea: "South Lake Union",
      paidParkingSubarea: "North",
      appPredictedPct: 18,
    });
  });

  it("reports a null appPredictedPct (not zero, not a guess) when this bucket has no occupancy_stats row at all", () => {
    const row = buildCandidateRow(SLU_NORTH_BLOCKFACE, null);
    expect(row.appPredictedPct).toBeNull();
  });

  it("preserves a null paidParkingSubarea for a blockface with no real subarea division, rather than inventing one", () => {
    const row = buildCandidateRow({ ...SLU_NORTH_BLOCKFACE, paidParkingSubarea: null }, 0.5);
    expect(row.paidParkingSubarea).toBeNull();
  });
});

describe("rowsToCsv", () => {
  it("writes a header row followed by one row per candidate, with blank real-count/notes columns to fill in during the trip", () => {
    const rows: FieldTestCandidateRow[] = [
      {
        name: "8TH AVE N (ALOHA ST-WESTLAKE S AVE N)",
        sourceElementKey: 53550,
        sideOfStreet: "E",
        paidParkingArea: "South Lake Union",
        paidParkingSubarea: "North",
        appPredictedPct: 18,
      },
    ];
    const csv = rowsToCsv(rows);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("name,sourceElementKey,sideOfStreet,paidParkingArea,paidParkingSubarea,appPredictedPct,realOccupiedCount,realTotalSpaces,notes");
    expect(lines[1]).toBe("8TH AVE N (ALOHA ST-WESTLAKE S AVE N),53550,E,South Lake Union,North,18,,,");
  });

  it("renders a null appPredictedPct and a null paidParkingSubarea as empty CSV fields, not the string 'null'", () => {
    const rows: FieldTestCandidateRow[] = [
      {
        name: "SOME ST (A-B)",
        sourceElementKey: 1,
        sideOfStreet: "N",
        paidParkingArea: "SomeArea",
        paidParkingSubarea: null,
        appPredictedPct: null,
      },
    ];
    const lines = rowsToCsv(rows).trim().split("\n");
    expect(lines[1]).toBe("SOME ST (A-B),1,N,SomeArea,,,,,");
  });

  it("quotes a field containing a comma, and escapes an embedded double quote", () => {
    const rows: FieldTestCandidateRow[] = [
      {
        name: 'MAIN ST, "the strip" (A-B)',
        sourceElementKey: 2,
        sideOfStreet: "S",
        paidParkingArea: "SomeArea",
        paidParkingSubarea: null,
        appPredictedPct: 50,
      },
    ];
    const lines = rowsToCsv(rows).trim().split("\n");
    expect(lines[1]).toBe('"MAIN ST, ""the strip"" (A-B)",2,S,SomeArea,,50,,,');
  });

  it("produces just the header line for zero candidates", () => {
    expect(rowsToCsv([]).trim()).toBe("name,sourceElementKey,sideOfStreet,paidParkingArea,paidParkingSubarea,appPredictedPct,realOccupiedCount,realTotalSpaces,notes");
  });
});
