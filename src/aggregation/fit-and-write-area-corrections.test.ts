import { describe, expect, it } from "vitest";
import { parseCliOptions, writeAreaCorrections } from "./fit-and-write-area-corrections";
import type { WriteSupabaseClient } from "./fit-and-write-area-corrections";
import type { AreaCalibration } from "../scoring/areaCorrectionCalibration";

describe("parseCliOptions", () => {
  it("defaults to a dry run (write: false) with no flags", () => {
    expect(parseCliOptions([])).toEqual({ write: false });
  });

  it("enables writing only when --write is explicitly passed", () => {
    expect(parseCliOptions(["--write"])).toEqual({ write: true });
  });

  it("ignores unrelated flags", () => {
    expect(parseCliOptions(["--verbose"])).toEqual({ write: false });
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
