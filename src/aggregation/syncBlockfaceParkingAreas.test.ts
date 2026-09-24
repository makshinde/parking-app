import { describe, expect, it } from "vitest";
import type { ArcGisFeature } from "../utils/fetchArcGisFeatures";
import { parseBlockfaceParkingAreaFeature, syncBlockfaceParkingAreas } from "./syncBlockfaceParkingAreas";
import type { SyncSupabaseClient } from "./syncBlockfaceParkingAreas";

function makeFeature(attributes: Record<string, unknown>): ArcGisFeature {
  return { attributes };
}

describe("parseBlockfaceParkingAreaFeature", () => {
  it("parses a normal record with both area and subarea", () => {
    const result = parseBlockfaceParkingAreaFeature(
      makeFeature({ ELMNTKEY: 31854, SIDE: "NE", PAIDAREA: "Ballard", SUBAREA: "Core" }),
    );
    expect(result).toEqual({
      sourceElementKey: 31854,
      sideOfStreet: "NE",
      paidParkingArea: "Ballard",
      paidParkingSubarea: "Core",
    });
  });

  it("returns null for area/subarea when SDOT has none on record -- this is the normal case for most blockfaces", () => {
    const result = parseBlockfaceParkingAreaFeature(
      makeFeature({ ELMNTKEY: 10281, SIDE: "W", PAIDAREA: null, SUBAREA: null }),
    );
    expect(result.paidParkingArea).toBeNull();
    expect(result.paidParkingSubarea).toBeNull();
  });

  it("treats an empty-string PAIDAREA the same as null, not as a real area name", () => {
    const result = parseBlockfaceParkingAreaFeature(
      makeFeature({ ELMNTKEY: 10281, SIDE: "W", PAIDAREA: "", SUBAREA: "" }),
    );
    expect(result.paidParkingArea).toBeNull();
    expect(result.paidParkingSubarea).toBeNull();
  });

  it("throws when ELMNTKEY is missing or non-numeric", () => {
    expect(() => parseBlockfaceParkingAreaFeature(makeFeature({ SIDE: "N" }))).toThrow(/ELMNTKEY/);
  });

  it("throws on a SIDE value outside the 8 real compass directions", () => {
    expect(() => parseBlockfaceParkingAreaFeature(makeFeature({ ELMNTKEY: 1, SIDE: "C" }))).toThrow(/unrecognized SIDE/);
  });
});

function makeMockClient(errorsByKey: Map<string, string>): { client: SyncSupabaseClient; calls: { key: string; values: Record<string, unknown> }[] } {
  const calls: { key: string; values: Record<string, unknown> }[] = [];
  const client: SyncSupabaseClient = {
    from: () => ({
      update: (values: Record<string, unknown>) => ({
        eq: (_col1: string, val1: unknown) => ({
          eq: (_col2: string, val2: unknown) => {
            const key = `${String(val1)}:${String(val2)}`;
            calls.push({ key, values });
            const errorMessage = errorsByKey.get(key);
            return Promise.resolve({ error: errorMessage === undefined ? null : { message: errorMessage } });
          },
        }),
      }),
    }),
  };
  return { client, calls };
}

describe("syncBlockfaceParkingAreas", () => {
  it("updates every record and counts them all as updated when nothing errors", async () => {
    const { client, calls } = makeMockClient(new Map());
    const summary = await syncBlockfaceParkingAreas(client, [
      { sourceElementKey: 1, sideOfStreet: "N", paidParkingArea: "Ballard", paidParkingSubarea: "Core" },
      { sourceElementKey: 2, sideOfStreet: "S", paidParkingArea: null, paidParkingSubarea: null },
    ]);
    expect(summary.updated).toBe(2);
    expect(summary.failed).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.values).toEqual({ paidparkingarea: "Ballard", paidparkingsubarea: "Core" });
  });

  it("records a failure (without throwing) when the update itself errors, and keeps processing the rest", async () => {
    const { client } = makeMockClient(new Map([["1:N", "connection reset"]]));
    const summary = await syncBlockfaceParkingAreas(client, [
      { sourceElementKey: 1, sideOfStreet: "N", paidParkingArea: "Ballard", paidParkingSubarea: null },
      { sourceElementKey: 2, sideOfStreet: "S", paidParkingArea: "Fremont", paidParkingSubarea: null },
    ]);
    expect(summary.updated).toBe(1);
    expect(summary.failed).toEqual([{ sourceElementKey: 1, sideOfStreet: "N", errorMessage: "connection reset" }]);
  });

  it("returns a zero-length summary for an empty input", async () => {
    const { client } = makeMockClient(new Map());
    const summary = await syncBlockfaceParkingAreas(client, []);
    expect(summary).toEqual({ updated: 0, noMatchingBlockface: 0, failed: [] });
  });
});
