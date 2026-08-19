import { describe, expect, it } from "vitest";
import { buildLookupKey, type RawReading } from "./blockfaceLookup.ts";
import { groupReadingsByBlockface } from "./groupReadingsByBlockface.ts";

const NOW = new Date("2026-07-20T12:00:00Z");

const LOOKUP = new Map<string, string>([
  [buildLookupKey(1029, "N"), "blockface-a"],
  [buildLookupKey(2000, "S"), "blockface-b"],
]);

function makeReading(overrides: Partial<RawReading> = {}): RawReading {
  return {
    sourceElementKey: 1029,
    sideOfStreet: "N",
    occupancyDateTime: "2026-07-15T09:00:00.000",
    paidOccupancy: 5,
    parkingSpaceCount: 8,
    ...overrides,
  };
}

describe("groupReadingsByBlockface", () => {
  it("groups multiple readings for the same blockface together", () => {
    const readings = [
      makeReading({ occupancyDateTime: "2026-07-15T09:00:00.000" }),
      makeReading({ occupancyDateTime: "2026-07-16T10:00:00.000", paidOccupancy: 6 }),
    ];

    const { grouped, unmatchedCount } = groupReadingsByBlockface(readings, LOOKUP, NOW);

    expect(grouped.size).toBe(1);
    expect(grouped.get("blockface-a")).toHaveLength(2);
    expect(unmatchedCount).toBe(0);
  });

  it("keeps readings for different blockfaces in separate groups", () => {
    const readings = [
      makeReading({ sourceElementKey: 1029, sideOfStreet: "N" }),
      makeReading({ sourceElementKey: 2000, sideOfStreet: "S", paidOccupancy: 2, parkingSpaceCount: 4 }),
    ];

    const { grouped, unmatchedCount } = groupReadingsByBlockface(readings, LOOKUP, NOW);

    expect(grouped.size).toBe(2);
    expect(grouped.get("blockface-a")).toHaveLength(1);
    expect(grouped.get("blockface-b")).toHaveLength(1);
    expect(grouped.get("blockface-b")?.[0]?.value).toBeCloseTo(0.5); // 2/4
    expect(unmatchedCount).toBe(0);
  });

  it("counts an unmatched reading and excludes it from any group", () => {
    const readings = [
      makeReading({ sourceElementKey: 1029, sideOfStreet: "N" }),
      makeReading({ sourceElementKey: 9999, sideOfStreet: "X" }), // not in LOOKUP
    ];

    const { grouped, unmatchedCount } = groupReadingsByBlockface(readings, LOOKUP, NOW);

    expect(grouped.size).toBe(1);
    expect(grouped.get("blockface-a")).toHaveLength(1);
    expect(unmatchedCount).toBe(1);
  });

  it("handles an empty input array cleanly, not as an error", () => {
    const { grouped, unmatchedCount } = groupReadingsByBlockface([], LOOKUP, NOW);

    expect(grouped.size).toBe(0);
    expect(unmatchedCount).toBe(0);
  });
});
