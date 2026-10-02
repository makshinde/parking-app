import { describe, expect, it } from "vitest";
import { filterCalibrationsForScope, parseCliOptions, writeAreaCorrections } from "./fit-and-write-area-corrections";
import type { WriteSupabaseClient } from "./fit-and-write-area-corrections";
import type { AreaCalibration } from "../scoring/areaCorrectionCalibration";

describe("parseCliOptions", () => {
  it("defaults to a dry run (write: false) with no --area/--subarea scope", () => {
    expect(parseCliOptions([])).toEqual({ write: false, area: null, subarea: null });
  });

  it("enables writing only when --write is explicitly passed", () => {
    expect(parseCliOptions(["--write"])).toEqual({ write: true, area: null, subarea: null });
  });

  it("ignores unrelated flags", () => {
    expect(parseCliOptions(["--verbose"])).toEqual({ write: false, area: null, subarea: null });
  });

  it("parses --area and --subarea together, for scoping to exactly one row", () => {
    expect(parseCliOptions(["--write", "--area=Ballard", "--subarea=Core"])).toEqual({
      write: true,
      area: "Ballard",
      subarea: "Core",
    });
  });

  it("parses --area alone as the bare area-level scope (no --subarea)", () => {
    expect(parseCliOptions(["--area=Ballard"])).toEqual({ write: false, area: "Ballard", subarea: null });
  });
});

describe("filterCalibrationsForScope", () => {
  const ballardCore: AreaCalibration = { paidParkingArea: "Ballard", paidParkingSubarea: "Core", bands: [] };
  const ballardEdge: AreaCalibration = { paidParkingArea: "Ballard", paidParkingSubarea: "Edge", bands: [] };
  const ballardAreaLevel: AreaCalibration = { paidParkingArea: "Ballard", paidParkingSubarea: null, bands: [] };
  const belltownNorth: AreaCalibration = { paidParkingArea: "Belltown", paidParkingSubarea: "North", bands: [] };
  const all = [ballardCore, ballardEdge, ballardAreaLevel, belltownNorth];

  it("returns every calibration unchanged when no area is given", () => {
    expect(filterCalibrationsForScope(all, null, null)).toEqual(all);
  });

  it("returns exactly the one matching area+subarea, excluding that area's other subareas", () => {
    expect(filterCalibrationsForScope(all, "Ballard", "Core")).toEqual([ballardCore]);
  });

  it("treats --area alone (no --subarea) as the bare area-level row, not every subarea under that area", () => {
    expect(filterCalibrationsForScope(all, "Ballard", null)).toEqual([ballardAreaLevel]);
  });

  it("returns an empty array when no calibration matches the requested scope at all", () => {
    expect(filterCalibrationsForScope(all, "Ballard", "NoSuchSubarea")).toEqual([]);
    expect(filterCalibrationsForScope(all, "NoSuchArea", null)).toEqual([]);
  });
});

function makeMockClient(response: { data: { id: string }[] | null; error: { message: string } | null }): { client: WriteSupabaseClient; upsertedRows: Record<string, unknown>[] | undefined } {
  let upsertedRows: Record<string, unknown>[] | undefined;
  const client: WriteSupabaseClient = {
    from: () => ({
      upsert: (values) => {
        upsertedRows = values;
        return { select: () => Promise.resolve(response) };
      },
    }),
  };
  return { client, upsertedRows };
}

const sampleCalibrations: AreaCalibration[] = [
  {
    paidParkingArea: "Ballard",
    paidParkingSubarea: null,
    bands: [{ predictedBandLow: 0, predictedBandHigh: 25, correctedPct: 45, sampleCount: 150 }],
  },
];

describe("writeAreaCorrections", () => {
  it("upserts one row per band and reports how many were written", async () => {
    const { client } = makeMockClient({ data: [{ id: "row-1" }], error: null });
    const result = await writeAreaCorrections(client, sampleCalibrations);
    expect(result).toEqual({ writtenCount: 1, errorMessage: null });
  });

  it("returns the error message on failure instead of throwing", async () => {
    const { client } = makeMockClient({ data: null, error: { message: "constraint violation" } });
    const result = await writeAreaCorrections(client, sampleCalibrations);
    expect(result).toEqual({ writtenCount: 0, errorMessage: "constraint violation" });
  });

  it("does nothing and reports zero when there are no calibrations to write", async () => {
    const { client } = makeMockClient({ data: [], error: null });
    const result = await writeAreaCorrections(client, []);
    expect(result).toEqual({ writtenCount: 0, errorMessage: null });
  });
});
