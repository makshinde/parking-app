import { describe, expect, it } from "vitest";
import {
  buildBlockfaceLookup,
  buildLookupKey,
  extractIsoDayAndHour,
  normalizeReading,
} from "./blockfaceLookup";
import type { BlockfaceLookupRow, BlockfaceLookupSupabaseClient, RawReading } from "./blockfaceLookup";

// Mirrors real Supabase .range(from, to) semantics (inclusive range, sliced
// against the full underlying row set) rather than ignoring the range
// arguments and always returning everything -- a mock that did the latter
// would pass even an unpaginated implementation, defeating the point of
// testing pagination at all.
function createMockClient(rows: BlockfaceLookupRow[], error: { message: string } | null = null) {
  const rangeCalls: Array<{ from: number; to: number }> = [];
  const select = (_columns: string) => ({
    range: async (from: number, to: number) => {
      rangeCalls.push({ from, to });
      if (error !== null) {
        return { data: null, error };
      }
      return { data: rows.slice(from, to + 1), error: null };
    },
  });
  const client: BlockfaceLookupSupabaseClient = {
    from: (_table: string) => ({ select }),
  };
  return { client, rangeCalls };
}

function makeRows(count: number, offset = 0): BlockfaceLookupRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `blockface-${offset + i}`,
    source_element_key: offset + i,
    side_of_street: "N",
  }));
}

describe("buildBlockfaceLookup", () => {
  it("builds a map keyed by source_element_key:side_of_street to id", async () => {
    const { client } = createMockClient([
      { id: "blockface-1", source_element_key: 81189, side_of_street: "NW" },
      { id: "blockface-2", source_element_key: 81189, side_of_street: "SE" },
      { id: "blockface-3", source_element_key: 70501, side_of_street: "W" },
    ]);

    const lookup = await buildBlockfaceLookup(client);

    expect(lookup.get("81189:NW")).toBe("blockface-1");
    expect(lookup.get("81189:SE")).toBe("blockface-2");
    expect(lookup.get("70501:W")).toBe("blockface-3");
    expect(lookup.size).toBe(3);
  });

  it("returns an empty map when blockfaces has no rows", async () => {
    const { client } = createMockClient([]);
    const lookup = await buildBlockfaceLookup(client);
    expect(lookup.size).toBe(0);
  });

  it("throws a clear error when the read fails", async () => {
    const { client } = createMockClient([], { message: "connection reset" });
    await expect(buildBlockfaceLookup(client)).rejects.toThrow(/reading blockfaces failed.*connection reset/s);
  });

  // Regression test for a real bug: an earlier, unpaginated version of this
  // function did a single select() with no range, which Supabase's
  // PostgREST layer silently caps at 1000 rows -- live-verified this
  // session against the real database (blockfaces has 2792 real rows; the
  // unpaginated version returned only 1000, with no error). A test that
  // only exercised a handful of rows (like the tests above) would never
  // have caught this -- this one uses a result set larger than one page.
  it("paginates past Supabase's default 1000-row page cap, loading every row rather than just the first page", async () => {
    const rows = makeRows(2792);
    const { client, rangeCalls } = createMockClient(rows);

    const lookup = await buildBlockfaceLookup(client);

    expect(lookup.size).toBe(2792);
    // Spot-check both edges of every page, not just the total count --
    // confirms rows from the second and third pages genuinely made it in,
    // not just that the total happens to add up.
    expect(lookup.get("0:N")).toBe("blockface-0");
    expect(lookup.get("999:N")).toBe("blockface-999"); // last row of page 1
    expect(lookup.get("1000:N")).toBe("blockface-1000"); // first row of page 2
    expect(lookup.get("1999:N")).toBe("blockface-1999"); // last row of page 2
    expect(lookup.get("2000:N")).toBe("blockface-2000"); // first row of page 3
    expect(lookup.get("2791:N")).toBe("blockface-2791"); // last row overall

    expect(rangeCalls).toEqual([
      { from: 0, to: 999 },
      { from: 1000, to: 1999 },
      { from: 2000, to: 2999 },
    ]);
  });

  it("stops exactly at a page boundary (a row count that's an exact multiple of the page size) without treating the boundary itself as incomplete", async () => {
    const rows = makeRows(2000);
    const { client, rangeCalls } = createMockClient(rows);

    const lookup = await buildBlockfaceLookup(client);

    expect(lookup.size).toBe(2000);
    // A full-length page (page 2) must still trigger one more request to
    // confirm there's nothing after it -- row count alone can't tell a
    // "the table ends exactly here" full page from a "there's more" one.
    expect(rangeCalls).toEqual([
      { from: 0, to: 999 },
      { from: 1000, to: 1999 },
      { from: 2000, to: 2999 },
    ]);
  });
});

describe("buildLookupKey", () => {
  it("joins sourceElementKey and sideOfStreet with a colon", () => {
    expect(buildLookupKey(81189, "NW")).toBe("81189:NW");
  });
});

function makeReading(overrides: Partial<RawReading> = {}): RawReading {
  return {
    sourceElementKey: 81189,
    sideOfStreet: "NW",
    occupancyDateTime: "2026-07-30T17:38:00.000",
    paidOccupancy: 6,
    parkingSpaceCount: 8,
    ...overrides,
  };
}

describe("normalizeReading", () => {
  it("returns a matched, fully-computed result for a reading with a known blockface", () => {
    const lookup = new Map([["81189:NW", "blockface-1"]]);
    // now is exactly 3 wall-clock days after the reading, both expressed
    // with an explicit -07:00 (PDT) offset so the "3 days" is unambiguous
    // real elapsed time, not a timezone artifact.
    const now = new Date("2026-08-02T17:38:00.000-07:00");

    const result = normalizeReading(makeReading(), lookup, now);

    expect(result).toEqual({
      matched: true,
      blockfaceId: "blockface-1",
      // 2026-07-30 is a Thursday (ISO day 4) -- see the hand-verified test
      // below for the independent by-hand derivation.
      isoDay: 4,
      hour: 17,
      ageInDays: 3,
      occupancyRatio: 0.75, // 6 / 8
    });
  });

  it("returns an unmatched result, without throwing, when no blockface matches", () => {
    const lookup = new Map([["81189:NW", "blockface-1"]]);
    const now = new Date("2026-08-02T17:38:00.000-07:00");

    // A different side of the same element -- e.g. one of the 48 ELMNTKEYs
    // import-blockfaces.ts documented as skipped during the real import.
    const result = normalizeReading(makeReading({ sideOfStreet: "SE" }), lookup, now);

    expect(result).toEqual({ matched: false, sourceElementKey: 81189, sideOfStreet: "SE" });
  });

  // Hand-verified date/day-of-week conversions, independent of this
  // project's own jsDayToIsoDay test fixture, using Zeller's congruence
  // (Gregorian form) worked out by hand rather than trusting a Date object:
  //
  //   h = (q + floor(13(m+1)/5) + K + floor(K/4) + floor(J/4) - 2J) mod 7
  //   where h: 0=Saturday, 1=Sunday, 2=Monday, ..., 6=Friday
  //
  // For 2026-07-30 (q=30, m=7, year=2026 -> K=26, J=20):
  //   floor(13*8/5) = floor(20.8) = 20
  //   floor(26/4) = 6, floor(20/4) = 5, 2J = 40
  //   h = (30 + 20 + 26 + 6 + 5 - 40) mod 7 = 47 mod 7 = 5 -> Thursday
  //   ISO day-of-week for Thursday = 4.
  it("matches a hand-verified Thursday (2026-07-30, via Zeller's congruence)", () => {
    const lookup = new Map([["81189:NW", "blockface-1"]]);
    const reading = makeReading({ occupancyDateTime: "2026-07-30T09:00:00.000" });

    const result = normalizeReading(reading, lookup, new Date("2026-07-30T12:00:00.000-07:00"));

    expect(result.matched).toBe(true);
    expect((result as { isoDay: number }).isoDay).toBe(4);
  });

  // For 2026-08-02 (q=2, m=8, year=2026 -> K=26, J=20):
  //   floor(13*9/5) = floor(23.4) = 23
  //   floor(26/4) = 6, floor(20/4) = 5, 2J = 40
  //   h = (2 + 23 + 26 + 6 + 5 - 40) mod 7 = 22 mod 7 = 1 -> Sunday
  //   ISO day-of-week for Sunday = 7 (the one JS-vs-ISO remapping case).
  it("matches a hand-verified Sunday (2026-08-02, via Zeller's congruence) -- exercises the Sunday=7 edge case", () => {
    const lookup = new Map([["81189:NW", "blockface-1"]]);
    const reading = makeReading({ occupancyDateTime: "2026-08-02T09:00:00.000" });

    const result = normalizeReading(reading, lookup, new Date("2026-08-02T12:00:00.000-07:00"));

    expect(result.matched).toBe(true);
    expect((result as { isoDay: number }).isoDay).toBe(7);
  });

  it("applies PST's winter offset (-8), not a hardcoded -7, when resolving ageInDays", () => {
    const lookup = new Map([["81189:NW", "blockface-1"]]);
    // 2026-01-15 is well within standard time (PST, UTC-8) -- unlike the
    // main successful-match test above, which uses a summer PDT (UTC-7)
    // reading. 10:00 Pacific on 2026-01-15 is 18:00 UTC (10:00 + 8h).
    const reading = makeReading({ occupancyDateTime: "2026-01-15T10:00:00.000" });
    // `now` is constructed directly in UTC (not via a local-offset string)
    // so the expected 5-day gap is exact and hand-verifiable without
    // needing to reason about `now`'s own offset: 2026-01-20T18:00:00Z is
    // exactly 5*86400000ms after 2026-01-15T18:00:00Z.
    const now = new Date(Date.UTC(2026, 0, 20, 18, 0, 0));

    const result = normalizeReading(reading, lookup, now);

    expect(result.matched).toBe(true);
    expect((result as { ageInDays: number }).ageInDays).toBeCloseTo(5, 10);
  });

  it("throws for a malformed occupancyDateTime", () => {
    const lookup = new Map([["81189:NW", "blockface-1"]]);
    const reading = makeReading({ occupancyDateTime: "not-a-date" });

    expect(() => normalizeReading(reading, lookup, new Date())).toThrow(/does not match the expected/);
  });

  it("propagates calculateOccupancyRatio's own validation for a matched reading", () => {
    const lookup = new Map([["81189:NW", "blockface-1"]]);
    const reading = makeReading({ parkingSpaceCount: 0 });

    expect(() => normalizeReading(reading, lookup, new Date())).toThrow(/parkingSpaceCount must be a positive number/);
  });

  // getTimeZoneOffsetMinutes caches its Intl.DateTimeFormat instance keyed
  // by timeZone (see its own comment for why) rather than constructing one
  // per call -- these two tests confirm that reuse doesn't corrupt or
  // stale-cache the result: repeated calls with the same input must stay
  // identical, and calls across different DST periods (interleaved, to
  // rule out call-order effects) must each still get their own correct,
  // independently-recomputed offset rather than one leaking into another.
  it("returns identical results across repeated calls using the same cached formatter", () => {
    const lookup = new Map([["81189:NW", "blockface-1"]]);
    const reading = makeReading({ occupancyDateTime: "2026-07-30T17:38:00.000" });
    const now = new Date("2026-08-02T17:38:00.000-07:00");

    const first = normalizeReading(reading, lookup, now);
    const second = normalizeReading(reading, lookup, now);
    const third = normalizeReading(reading, lookup, now);

    expect(first).toEqual(second);
    expect(second).toEqual(third);
  });

  it("still resolves the correct DST-aware offset for each instant when summer and winter calls are interleaved through the shared cache", () => {
    const lookup = new Map([["81189:NW", "blockface-1"]]);
    const summerReading = makeReading({ occupancyDateTime: "2026-07-30T17:38:00.000" });
    const summerNow = new Date("2026-08-02T17:38:00.000-07:00");
    const winterReading = makeReading({ occupancyDateTime: "2026-01-15T10:00:00.000" });
    const winterNow = new Date(Date.UTC(2026, 0, 20, 18, 0, 0));

    // Interleaved (summer, winter, summer again) rather than grouped, so a
    // cache keyed only by timeZone -- which both readings share -- can't
    // accidentally pass by coincidentally never needing to recompute for a
    // different instant.
    const summerResult1 = normalizeReading(summerReading, lookup, summerNow);
    const winterResult = normalizeReading(winterReading, lookup, winterNow);
    const summerResult2 = normalizeReading(summerReading, lookup, summerNow);

    // Same hand-verified expected values as the standalone summer/winter
    // tests above (ageInDays 3 and 5 respectively).
    expect((summerResult1 as { ageInDays: number }).ageInDays).toBeCloseTo(3, 10);
    expect((winterResult as { ageInDays: number }).ageInDays).toBeCloseTo(5, 10);
    expect(summerResult1).toEqual(summerResult2);
  });
});

describe("extractIsoDayAndHour", () => {
  it("matches the isoDay/hour normalizeReading computes for the same occupancyDateTime", () => {
    const lookup = new Map([["81189:NW", "blockface-1"]]);
    const reading = makeReading({ occupancyDateTime: "2026-07-30T17:38:00.000" });

    const result = normalizeReading(reading, lookup, new Date("2026-08-02T17:38:00.000-07:00"));
    const extracted = extractIsoDayAndHour(reading.occupancyDateTime);

    expect(result.matched).toBe(true);
    expect(extracted).toEqual({
      isoDay: (result as { isoDay: number }).isoDay,
      hour: (result as { hour: number }).hour,
    });
  });

  // Same hand-verified Sunday=7 edge case as normalizeReading's own test
  // above, exercised directly through this smaller entry point.
  it("matches a hand-verified Sunday (2026-08-02, via Zeller's congruence)", () => {
    expect(extractIsoDayAndHour("2026-08-02T09:00:00.000")).toEqual({ isoDay: 7, hour: 9 });
  });

  it("throws for a malformed occupancyDateTime, same as normalizeReading", () => {
    expect(() => extractIsoDayAndHour("not-a-date")).toThrow(/does not match the expected/);
  });
});
