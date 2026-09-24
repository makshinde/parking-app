import { describe, expect, it } from "vitest";
import {
  assembleSearchResults,
  calculateOccupancyColor,
  type AreaCorrectionsSupabaseClient,
  type BlockfaceHasDataResult,
  type BlockfaceNoDataResult,
  type NearbyBlockfaceRow,
  type NearbyOffStreetFacilityRow,
  type OccupancyStatsSupabaseClient,
} from "./assembleSearchResults";

// --- Mock occupancy_stats client ------------------------------------------
//
// select().eq().eq().in() is awaited directly (no terminal method call like
// .maybeSingle()), so the object .in() returns must itself be thenable --
// implemented via a plain "then" property rather than a real Promise, the
// same structural-typing approach this project's other mock clients use.

function makeMockOccupancyStatsClient(rows: Record<string, unknown>[]) {
  const fromCalls: string[] = [];
  const eqCalls: [string, unknown][] = [];
  let inCallArgs: string[] | null = null;

  function makeQueryBuilder(): OccupancyStatsSupabaseClient["from"] extends (table: string) => infer T ? T : never {
    const builder = {
      eq: (column: string, value: unknown) => {
        eqCalls.push([column, value]);
        return builder;
      },
      in: (_column: string, values: string[]) => {
        inCallArgs = values;
        return builder;
      },
      then: (onFulfilled?: (value: { data: unknown; error: null }) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(onFulfilled, onRejected),
    };
    return builder as unknown as ReturnType<OccupancyStatsSupabaseClient["from"]>;
  }

  const client = {
    from: (table: string) => {
      fromCalls.push(table);
      return { select: () => makeQueryBuilder() };
    },
  } as unknown as OccupancyStatsSupabaseClient;

  return { client, fromCalls, eqCalls, getInCallArgs: () => inCallArgs };
}

// --- Mock area_occupancy_corrections client -------------------------------
//
// Simpler than occupancy_stats' mock: no .eq()/.in() to simulate, since the
// real client always reads the whole table in one unfiltered .select().

function makeMockAreaCorrectionsClient(rows: Record<string, unknown>[]) {
  const fromCalls: string[] = [];
  const client = {
    from: (table: string) => {
      fromCalls.push(table);
      return {
        select: () => ({
          then: (onFulfilled?: (value: { data: unknown; error: null }) => unknown, onRejected?: (reason: unknown) => unknown) =>
            Promise.resolve({ data: rows, error: null }).then(onFulfilled, onRejected),
        }),
      };
    },
  } as unknown as AreaCorrectionsSupabaseClient;
  return { client, fromCalls };
}

// The overwhelming majority of tests in this file don't care about area
// corrections at all -- this shared, always-empty client keeps every
// pre-existing occupancyPercent/occupancyColor value in this file exactly
// as it was before area corrections existed (identity: no calibration
// rows means applyAreaCorrection always returns its input unchanged).
// Tests that DO care about corrections (see "area correction" describe
// block below) build their own, real, non-empty rows instead.
const { client: NO_CORRECTIONS_CLIENT } = makeMockAreaCorrectionsClient([]);

// --- Fixtures --------------------------------------------------------------

function makeBlockfaceRow(overrides: Partial<NearbyBlockfaceRow> & { id: string }): NearbyBlockfaceRow {
  return {
    street_name: "TEST ST",
    cross_street_from: "1ST AVE",
    cross_street_to: "2ND AVE",
    side_of_street: "N",
    is_paid: true,
    starting_rate_usd: 2,
    operating_days: [1, 2, 3, 4, 5],
    operating_hours_start: "08:00:00",
    operating_hours_end: "18:00:00",
    rate_tiers: [{ day_type: "WKD", tier_number: 1, start_time: "08:00:00", end_time: "18:00:00", rate_usd: 2 }],
    location_geojson: { type: "LineString", coordinates: [[-122.33, 47.6], [-122.331, 47.601]] },
    distance_meters: 100,
    paidparkingarea: null,
    paidparkingsubarea: null,
    ...overrides,
  };
}

function makeFacilityRow(overrides: Partial<NearbyOffStreetFacilityRow> & { id: string }): NearbyOffStreetFacilityRow {
  return {
    name: "TEST GARAGE",
    address: "123 Test St, Seattle, WA",
    capacity: 50,
    facility_type: "GARAGE",
    operator_name: "Test Operator",
    rate_tiers: [{ duration_type: "1HR", rate_usd: 3, rate_note: null }],
    location_geojson: { type: "Point", coordinates: [-122.33, 47.6] },
    distance_meters: 100,
    ...overrides,
  };
}

// Real, verified calculateConfidenceScore outputs (live-checked, not
// hand-computed) at daysInFuture=0:
//   count=200, stdDev=0.1  -> score=10 -> 100% (green)
//   count=100, stdDev=0.5  -> score=6  -> 60%  (yellow)
//   count=50,  stdDev=0.75 -> score=4  -> 40%  (orange)
//   count=10,  stdDev=0.95 -> score=2  -> 20%  (red)
const GREEN_STATS = { mean_occupancy: 0, std_dev: 0.1, sample_count: 200 };
const YELLOW_STATS = { mean_occupancy: 0, std_dev: 0.5, sample_count: 100 };
const ORANGE_STATS = { mean_occupancy: 0, std_dev: 0.75, sample_count: 50 };
const RED_STATS = { mean_occupancy: 0, std_dev: 0.95, sample_count: 10 };

// Fixed confidence inputs (std_dev/sample_count borrowed from GREEN_STATS,
// a fixed, uninteresting confidence throughout) so each row below isolates
// the occupancy percentage/color calculation alone -- only mean_occupancy
// varies. Hand-verified: meanOccupancy * 100 = occupancyPercent exactly
// (a straight *100, not calculateConfidenceScore's /10*100), and each
// occupancyColor below is calculateOccupancyColor's real, direct output
// for that percentage, checked by hand against its 75/50/25 bands.
const OCCUPANCY_ZERO = { mean_occupancy: 0, std_dev: 0.1, sample_count: 200 }; // 0%  -> green
const OCCUPANCY_JUST_BELOW_25 = { mean_occupancy: 0.24, std_dev: 0.1, sample_count: 200 }; // 24% -> green
const OCCUPANCY_AT_25 = { mean_occupancy: 0.25, std_dev: 0.1, sample_count: 200 }; // 25% -> yellow
const OCCUPANCY_JUST_BELOW_50 = { mean_occupancy: 0.49, std_dev: 0.1, sample_count: 200 }; // 49% -> yellow
const OCCUPANCY_AT_50 = { mean_occupancy: 0.5, std_dev: 0.1, sample_count: 200 }; // 50% -> orange
const OCCUPANCY_JUST_BELOW_75 = { mean_occupancy: 0.74, std_dev: 0.1, sample_count: 200 }; // 74% -> orange
// 90% -- deliberately using GREEN_STATS' own std_dev/sample_count (the
// exact combination that produces confidence.color: "green") paired with
// a near-full mean_occupancy, so this row proves the inversion holds even
// when confidence itself is green: occupancyColor must be RED regardless
// of what confidence.color says, since they are two independent
// calculations. This is the specific, dangerous mistake this whole split
// exists to prevent -- a 90%-full block face must never show green.
const OCCUPANCY_HIGH = { mean_occupancy: 0.9, std_dev: 0.1, sample_count: 200 }; // 90% -> RED, not green

describe("assembleSearchResults", () => {
  it("marks every off-street facility hasData: false unconditionally", async () => {
    const { client } = makeMockOccupancyStatsClient([]);
    const facility = makeFacilityRow({ id: "os-1" });

    const { facilityResults } = await assembleSearchResults({ occupancyStatsClient: client, areaCorrectionsClient: NO_CORRECTIONS_CLIENT }, {
      blockfaceCandidates: [],
      facilityCandidates: [facility],
      isoDay: 1,
      hour: 9,
      daysInFuture: 0,
    });

    expect(facilityResults[0]).toMatchObject({ type: "off_street_facility", hasData: false, id: "os-1" });
  });

  it("marks a blockface with no matching occupancy_stats row hasData: false", async () => {
    const { client } = makeMockOccupancyStatsClient([]); // no rows at all
    const blockface = makeBlockfaceRow({ id: "bf-1" });

    const { blockfaceResults } = await assembleSearchResults({ occupancyStatsClient: client, areaCorrectionsClient: NO_CORRECTIONS_CLIENT }, {
      blockfaceCandidates: [blockface],
      facilityCandidates: [],
      isoDay: 1,
      hour: 9,
      daysInFuture: 0,
    });

    expect(blockfaceResults[0]).toMatchObject({ type: "blockface", hasData: false, id: "bf-1" });
  });

  it("skips the occupancy_stats query entirely when there are no blockface candidates", async () => {
    const { client, fromCalls } = makeMockOccupancyStatsClient([]);

    await assembleSearchResults({ occupancyStatsClient: client, areaCorrectionsClient: NO_CORRECTIONS_CLIENT }, {
      blockfaceCandidates: [],
      facilityCandidates: [makeFacilityRow({ id: "os-1" })],
      isoDay: 1,
      hour: 9,
      daysInFuture: 0,
    });

    expect(fromCalls).toHaveLength(0);
  });

  it("uses exactly one batched query (an IN clause) for multiple blockface candidates, not one per candidate", async () => {
    const { client, fromCalls, eqCalls, getInCallArgs } = makeMockOccupancyStatsClient([
      { blockface_id: "bf-1", ...GREEN_STATS },
      { blockface_id: "bf-3", ...RED_STATS },
      // bf-2 deliberately has no matching row.
    ]);

    const { blockfaceResults } = await assembleSearchResults({ occupancyStatsClient: client, areaCorrectionsClient: NO_CORRECTIONS_CLIENT }, {
      blockfaceCandidates: [
        makeBlockfaceRow({ id: "bf-1" }),
        makeBlockfaceRow({ id: "bf-2" }),
        makeBlockfaceRow({ id: "bf-3" }),
      ],
      facilityCandidates: [],
      isoDay: 3,
      hour: 14,
      daysInFuture: 0,
    });

    // Exactly one round trip to occupancy_stats, regardless of candidate count.
    expect(fromCalls).toEqual(["occupancy_stats"]);
    expect(eqCalls).toEqual([
      ["day_of_week", 3],
      ["hour_of_day", 14],
    ]);
    expect(getInCallArgs()).toEqual(["bf-1", "bf-2", "bf-3"]);

    const byId = new Map(blockfaceResults.map((r) => [r.id, r]));
    expect(byId.get("bf-1")).toMatchObject({ hasData: true, confidence: { score: 10 } });
    expect(byId.get("bf-2")).toMatchObject({ hasData: false });
    expect(byId.get("bf-3")).toMatchObject({ hasData: true, confidence: { score: 2 } });
  });

  it("sorts blockfaceResults: hasData first by ascending occupancy band then descending confidence, no-data blockfaces last by distance", async () => {
    const { client } = makeMockOccupancyStatsClient([
      { blockface_id: "bf-a", mean_occupancy: 0.12, std_dev: 0.1, sample_count: 200 }, // band 1, 100% (green)
      { blockface_id: "bf-b", mean_occupancy: 0.14, std_dev: 0.5, sample_count: 100 }, // band 1, 60% (yellow)
      { blockface_id: "bf-c", mean_occupancy: 0.5, std_dev: 0.75, sample_count: 50 }, // band 5, 40% (orange)
      { blockface_id: "bf-d", mean_occupancy: 0.54, std_dev: 0.95, sample_count: 10 }, // band 5, 20% (red)
    ]);

    const blockfaceCandidates = [
      makeBlockfaceRow({ id: "bf-a", distance_meters: 400 }),
      makeBlockfaceRow({ id: "bf-b", distance_meters: 410 }),
      makeBlockfaceRow({ id: "bf-c", distance_meters: 420 }),
      makeBlockfaceRow({ id: "bf-d", distance_meters: 430 }),
      makeBlockfaceRow({ id: "bf-e", distance_meters: 200 }), // no occupancy_stats row -> hasData: false
      makeBlockfaceRow({ id: "bf-f", distance_meters: 50 }), // no occupancy_stats row -> hasData: false
    ];

    const { blockfaceResults } = await assembleSearchResults({ occupancyStatsClient: client, areaCorrectionsClient: NO_CORRECTIONS_CLIENT }, {
      blockfaceCandidates,
      facilityCandidates: [],
      isoDay: 1,
      hour: 9,
      daysInFuture: 0,
      blockfaceLimit: "all",
    });

    expect(blockfaceResults.map((r) => r.id)).toEqual(["bf-a", "bf-b", "bf-c", "bf-d", "bf-f", "bf-e"]);

    // Confirm the hasData block really is grouped/ordered by band then confidence, not by coincidence.
    const hasDataResults = blockfaceResults.slice(0, 4) as BlockfaceHasDataResult[];
    expect(hasDataResults.map((r) => r.confidence.color)).toEqual(["green", "yellow", "orange", "red"]);

    // Confirm the no-data tail really is in distance order (50, 200).
    const noDataResults = blockfaceResults.slice(4) as BlockfaceNoDataResult[];
    expect(noDataResults.map((r) => r.distanceMeters)).toEqual([50, 200]);
    expect(noDataResults.every((r) => r.hasData === false)).toBe(true);
  });

  it("sorts facilityResults by distance alone, independent of any blockface in the same search", async () => {
    const { client } = makeMockOccupancyStatsClient([]);

    const { facilityResults } = await assembleSearchResults({ occupancyStatsClient: client, areaCorrectionsClient: NO_CORRECTIONS_CLIENT }, {
      blockfaceCandidates: [makeBlockfaceRow({ id: "bf-a", distance_meters: 10 })], // closer than every facility below
      facilityCandidates: [
        makeFacilityRow({ id: "os-far", distance_meters: 200 }),
        makeFacilityRow({ id: "os-near", distance_meters: 30 }),
        makeFacilityRow({ id: "os-mid", distance_meters: 90 }),
      ],
      isoDay: 1,
      hour: 9,
      daysInFuture: 0,
      blockfaceLimit: "all",
      facilityLimit: "all",
    });

    expect(facilityResults.map((r) => r.id)).toEqual(["os-near", "os-mid", "os-far"]);
  });

  it("REGRESSION (the real 2026-09-17 field-test bug): a dense blockface area never crowds facilities out, because each category has its own independent cap", async () => {
    // Exactly the failure mode found live: 69 real blockfaces vs. 6 real
    // facilities within the same radius, with a real Diamond Parking
    // location genuinely closer (69m) than most blockfaces shown -- yet
    // the old shared-cap design could fill all 20 slots with blockfaces
    // alone before a single facility was ever considered. Modeled here at
    // a smaller but structurally identical scale: more blockfaces than
    // the default cap, plus facilities that a shared cap would have
    // silently dropped.
    const stats = Array.from({ length: 25 }, (_, i) => ({ blockface_id: `bf-${i}`, ...GREEN_STATS, mean_occupancy: 0.1 }));
    const { client } = makeMockOccupancyStatsClient(stats);
    const blockfaceCandidates = Array.from({ length: 25 }, (_, i) => makeBlockfaceRow({ id: `bf-${i}`, distance_meters: i }));
    const facilityCandidates = [
      makeFacilityRow({ id: "os-1", distance_meters: 69 }),
      makeFacilityRow({ id: "os-2", distance_meters: 150 }),
    ];

    const { blockfaceResults, facilityResults } = await assembleSearchResults({ occupancyStatsClient: client, areaCorrectionsClient: NO_CORRECTIONS_CLIENT }, {
      blockfaceCandidates,
      facilityCandidates,
      isoDay: 1,
      hour: 9,
      daysInFuture: 0,
      // default caps (20 each) -- no explicit limit passed, matching what
      // a real request with no limit fields set would get.
    });

    expect(blockfaceResults).toHaveLength(20); // the default cap, exactly as before
    expect(facilityResults).toHaveLength(2); // BOTH facilities present -- never crowded out by the 25 blockfaces
    expect(facilityResults.map((r) => r.id)).toEqual(["os-1", "os-2"]);
  });

  it("caps blockfaceResults at 20 by default", async () => {
    const stats = Array.from({ length: 25 }, (_, i) => ({ blockface_id: `bf-${i}`, ...GREEN_STATS, mean_occupancy: 0.1 }));
    const { client } = makeMockOccupancyStatsClient(stats);
    const blockfaceCandidates = Array.from({ length: 25 }, (_, i) => makeBlockfaceRow({ id: `bf-${i}` }));

    const { blockfaceResults } = await assembleSearchResults({ occupancyStatsClient: client, areaCorrectionsClient: NO_CORRECTIONS_CLIENT }, {
      blockfaceCandidates,
      facilityCandidates: [],
      isoDay: 1,
      hour: 9,
      daysInFuture: 0,
    });

    expect(blockfaceResults).toHaveLength(20);
  });

  it("caps facilityResults at 20 by default, independently of blockfaceResults' own cap", async () => {
    const facilityCandidates = Array.from({ length: 25 }, (_, i) => makeFacilityRow({ id: `os-${i}`, distance_meters: i }));
    const { client } = makeMockOccupancyStatsClient([]);

    const { facilityResults } = await assembleSearchResults({ occupancyStatsClient: client, areaCorrectionsClient: NO_CORRECTIONS_CLIENT }, {
      blockfaceCandidates: [],
      facilityCandidates,
      isoDay: 1,
      hour: 9,
      daysInFuture: 0,
    });

    expect(facilityResults).toHaveLength(20);
  });

  it("returns the full, uncapped blockfaceResults list when blockfaceLimit: 'all' is requested, without affecting facilityResults' own cap", async () => {
    const stats = Array.from({ length: 25 }, (_, i) => ({ blockface_id: `bf-${i}`, ...GREEN_STATS, mean_occupancy: 0.1 }));
    const { client } = makeMockOccupancyStatsClient(stats);
    const blockfaceCandidates = Array.from({ length: 25 }, (_, i) => makeBlockfaceRow({ id: `bf-${i}` }));
    const facilityCandidates = Array.from({ length: 25 }, (_, i) => makeFacilityRow({ id: `os-${i}`, distance_meters: i }));

    const { blockfaceResults, facilityResults } = await assembleSearchResults({ occupancyStatsClient: client, areaCorrectionsClient: NO_CORRECTIONS_CLIENT }, {
      blockfaceCandidates,
      facilityCandidates,
      isoDay: 1,
      hour: 9,
      daysInFuture: 0,
      blockfaceLimit: "all",
      // facilityLimit deliberately omitted -- "all" for one category must
      // not force the other to uncap too.
    });

    expect(blockfaceResults).toHaveLength(25);
    expect(facilityResults).toHaveLength(20);
  });

  it("returns the full, uncapped facilityResults list when facilityLimit: 'all' is requested", async () => {
    const facilityCandidates = Array.from({ length: 25 }, (_, i) => makeFacilityRow({ id: `os-${i}`, distance_meters: i }));
    const { client } = makeMockOccupancyStatsClient([]);

    const { facilityResults } = await assembleSearchResults({ occupancyStatsClient: client, areaCorrectionsClient: NO_CORRECTIONS_CLIENT }, {
      blockfaceCandidates: [],
      facilityCandidates,
      isoDay: 1,
      hour: 9,
      daysInFuture: 0,
      facilityLimit: "all",
    });

    expect(facilityResults).toHaveLength(25);
  });

  it("respects an explicit numeric blockfaceLimit smaller than the result set", async () => {
    const stats = Array.from({ length: 10 }, (_, i) => ({ blockface_id: `bf-${i}`, ...GREEN_STATS, mean_occupancy: 0.1 }));
    const { client } = makeMockOccupancyStatsClient(stats);
    const blockfaceCandidates = Array.from({ length: 10 }, (_, i) => makeBlockfaceRow({ id: `bf-${i}` }));

    const { blockfaceResults } = await assembleSearchResults({ occupancyStatsClient: client, areaCorrectionsClient: NO_CORRECTIONS_CLIENT }, {
      blockfaceCandidates,
      facilityCandidates: [],
      isoDay: 1,
      hour: 9,
      daysInFuture: 0,
      blockfaceLimit: 5,
    });

    expect(blockfaceResults).toHaveLength(5);
  });

  it("respects an explicit numeric facilityLimit smaller than the result set", async () => {
    const facilityCandidates = Array.from({ length: 10 }, (_, i) => makeFacilityRow({ id: `os-${i}`, distance_meters: i }));
    const { client } = makeMockOccupancyStatsClient([]);

    const { facilityResults } = await assembleSearchResults({ occupancyStatsClient: client, areaCorrectionsClient: NO_CORRECTIONS_CLIENT }, {
      blockfaceCandidates: [],
      facilityCandidates,
      isoDay: 1,
      hour: 9,
      daysInFuture: 0,
      facilityLimit: 5,
    });

    expect(facilityResults).toHaveLength(5);
  });

  it.each([0, -1, 1.5])("rejects an invalid blockfaceLimit (%s) rather than silently coercing it", async (badLimit) => {
    const { client } = makeMockOccupancyStatsClient([]);

    await expect(
      assembleSearchResults({ occupancyStatsClient: client, areaCorrectionsClient: NO_CORRECTIONS_CLIENT }, {
        blockfaceCandidates: [makeBlockfaceRow({ id: "bf-1" })],
        facilityCandidates: [],
        isoDay: 1,
        hour: 9,
        daysInFuture: 0,
        blockfaceLimit: badLimit,
      }),
    ).rejects.toThrow(RangeError);
  });

  it.each([0, -1, 1.5])("rejects an invalid facilityLimit (%s) rather than silently coercing it", async (badLimit) => {
    const { client } = makeMockOccupancyStatsClient([]);

    await expect(
      assembleSearchResults({ occupancyStatsClient: client, areaCorrectionsClient: NO_CORRECTIONS_CLIENT }, {
        blockfaceCandidates: [],
        facilityCandidates: [makeFacilityRow({ id: "os-1" })],
        isoDay: 1,
        hour: 9,
        daysInFuture: 0,
        facilityLimit: badLimit,
      }),
    ).rejects.toThrow(RangeError);
  });

  it("assembles the full response shape: type, id, name, geometry, confidence, pricing", async () => {
    const { client } = makeMockOccupancyStatsClient([{ blockface_id: "bf-1", ...YELLOW_STATS, mean_occupancy: 0.42 }]);
    const blockface = makeBlockfaceRow({
      id: "bf-1",
      street_name: "PIKE ST",
      cross_street_from: "1ST AVE",
      cross_street_to: "2ND AVE",
      side_of_street: "N",
    });

    const { blockfaceResults } = await assembleSearchResults({ occupancyStatsClient: client, areaCorrectionsClient: NO_CORRECTIONS_CLIENT }, {
      blockfaceCandidates: [blockface],
      facilityCandidates: [],
      isoDay: 1,
      hour: 9,
      daysInFuture: 0,
    });

    expect(blockfaceResults[0]).toEqual({
      type: "blockface",
      id: "bf-1",
      name: "PIKE ST (1ST AVE to 2ND AVE), N side",
      geometry: blockface.location_geojson,
      distanceMeters: blockface.distance_meters,
      hasData: true,
      confidence: { score: 6, percentage: 60, color: "yellow", meanOccupancy: 0.42 },
      occupancyPercent: 42,
      occupancyColor: "yellow",
      pricing: { isPaid: true, startingRateUsd: 2, rateTiers: blockface.rate_tiers },
    });
  });

  it("assembles an off-street facility's pricing from its own rate_tiers, with no isPaid concept", async () => {
    const { client } = makeMockOccupancyStatsClient([]);
    const facility = makeFacilityRow({ id: "os-1", name: "DIAMOND PARKING WX04" });

    const { facilityResults } = await assembleSearchResults({ occupancyStatsClient: client, areaCorrectionsClient: NO_CORRECTIONS_CLIENT }, {
      blockfaceCandidates: [],
      facilityCandidates: [facility],
      isoDay: 1,
      hour: 9,
      daysInFuture: 0,
    });

    expect(facilityResults[0]).toEqual({
      type: "off_street_facility",
      id: "os-1",
      name: "DIAMOND PARKING WX04",
      geometry: facility.location_geojson,
      distanceMeters: facility.distance_meters,
      hasData: false,
      pricing: { rateTiers: facility.rate_tiers },
    });
  });

  describe("calculateOccupancyColor", () => {
    it.each([
      [0, "green"],
      [10, "green"],
      [24, "green"],
      [25, "yellow"],
      [42, "yellow"],
      [49, "yellow"],
      [50, "orange"],
      [60, "orange"],
      [74, "orange"],
      [75, "red"],
      // The specific, dangerous mistake this test suite exists to catch:
      // a HIGH occupancy percentage must produce RED (nearly full, bad),
      // never GREEN -- the exact opposite of what percentageToColor
      // (confidence's mapping) would produce for the same 90.
      [90, "red"],
      [100, "red"],
    ])("maps occupancy percentage %s%% to %s (inverted vs confidence's mapping)", (percentage, expectedColor) => {
      expect(calculateOccupancyColor(percentage)).toBe(expectedColor);
    });

    it("never returns the same color confidence's percentageToColor would for a shared boundary value", () => {
      // At the exact same percentage, occupancy and confidence colors must
      // be opposites at every one of the three real threshold-crossing
      // values -- confirming the inversion isn't just correct "on average"
      // but at each individual boundary.
      expect(calculateOccupancyColor(24)).toBe("green");
      expect(calculateOccupancyColor(25)).toBe("yellow");
      expect(calculateOccupancyColor(49)).toBe("yellow");
      expect(calculateOccupancyColor(50)).toBe("orange");
      expect(calculateOccupancyColor(74)).toBe("orange");
      expect(calculateOccupancyColor(75)).toBe("red");
    });
  });

  describe("occupancyPercent/occupancyColor via assembleSearchResults", () => {
    it("computes occupancyPercent as meanOccupancy formatted as a percentage, independent of confidence", async () => {
      const { client } = makeMockOccupancyStatsClient([{ blockface_id: "bf-1", ...OCCUPANCY_AT_25 }]);

      const { blockfaceResults } = await assembleSearchResults({ occupancyStatsClient: client, areaCorrectionsClient: NO_CORRECTIONS_CLIENT }, {
        blockfaceCandidates: [makeBlockfaceRow({ id: "bf-1" })],
        facilityCandidates: [],
        isoDay: 1,
        hour: 9,
        daysInFuture: 0,
      });
      const [result] = blockfaceResults as [BlockfaceHasDataResult];

      expect(result.occupancyPercent).toBe(25);
      expect(result.occupancyColor).toBe("yellow");
    });

    it("a 90% occupancy result is red, NOT green, even though its confidence inputs are the exact GREEN_STATS combination", async () => {
      // The critical, hand-verified regression test: OCCUPANCY_HIGH reuses
      // GREEN_STATS' own std_dev/sample_count (which makes
      // confidence.color: "green"), paired with mean_occupancy: 0.9. If
      // occupancyColor were ever accidentally computed via confidence's
      // own percentageToColor (or the two colors were ever conflated),
      // this would wrongly come back green. It must be red.
      const { client } = makeMockOccupancyStatsClient([{ blockface_id: "bf-1", ...OCCUPANCY_HIGH }]);

      const { blockfaceResults } = await assembleSearchResults({ occupancyStatsClient: client, areaCorrectionsClient: NO_CORRECTIONS_CLIENT }, {
        blockfaceCandidates: [makeBlockfaceRow({ id: "bf-1" })],
        facilityCandidates: [],
        isoDay: 1,
        hour: 9,
        daysInFuture: 0,
      });
      const [result] = blockfaceResults as [BlockfaceHasDataResult];

      expect(result.occupancyPercent).toBe(90);
      expect(result.occupancyColor).toBe("red");
      expect(result.confidence.color).toBe("green");
      expect(result.occupancyColor).not.toBe(result.confidence.color);
    });

    it("occupancyColor crosses bands independently across a realistic mixed set, confirmed at every boundary", async () => {
      const { client } = makeMockOccupancyStatsClient([
        { blockface_id: "bf-green", ...OCCUPANCY_JUST_BELOW_25 },
        { blockface_id: "bf-yellow", ...OCCUPANCY_JUST_BELOW_50 },
        { blockface_id: "bf-orange", ...OCCUPANCY_JUST_BELOW_75 },
        { blockface_id: "bf-red", ...OCCUPANCY_HIGH },
      ]);

      const { blockfaceResults } = await assembleSearchResults({ occupancyStatsClient: client, areaCorrectionsClient: NO_CORRECTIONS_CLIENT }, {
        blockfaceCandidates: [
          makeBlockfaceRow({ id: "bf-green" }),
          makeBlockfaceRow({ id: "bf-yellow" }),
          makeBlockfaceRow({ id: "bf-orange" }),
          makeBlockfaceRow({ id: "bf-red" }),
        ],
        facilityCandidates: [],
        isoDay: 1,
        hour: 9,
        daysInFuture: 0,
        blockfaceLimit: "all",
      });
      const results = blockfaceResults as BlockfaceHasDataResult[];

      const byId = new Map(results.map((r) => [r.id, r]));
      expect(byId.get("bf-green")?.occupancyColor).toBe("green");
      expect(byId.get("bf-yellow")?.occupancyColor).toBe("yellow");
      expect(byId.get("bf-orange")?.occupancyColor).toBe("orange");
      expect(byId.get("bf-red")?.occupancyColor).toBe("red");
    });
  });

  describe("confidence color logic is unaffected by occupancy color (regression guard)", () => {
    it("confidence.color still reflects only calculateConfidenceScore's output, not occupancy", async () => {
      // Same fixtures already used above for confidence's own color
      // mapping (GREEN/YELLOW/ORANGE/RED_STATS), now with a HIGH
      // mean_occupancy on the otherwise-green row -- confirming confidence
      // still comes back green (unaffected by the near-full occupancy),
      // proving the two color calculations are genuinely independent in
      // both directions, not just that occupancy ignores confidence.
      const { client } = makeMockOccupancyStatsClient([{ blockface_id: "bf-1", ...GREEN_STATS, mean_occupancy: 0.9 }]);

      const { blockfaceResults } = await assembleSearchResults({ occupancyStatsClient: client, areaCorrectionsClient: NO_CORRECTIONS_CLIENT }, {
        blockfaceCandidates: [makeBlockfaceRow({ id: "bf-1" })],
        facilityCandidates: [],
        isoDay: 1,
        hour: 9,
        daysInFuture: 0,
      });
      const [result] = blockfaceResults as [BlockfaceHasDataResult];

      expect(result.confidence.color).toBe("green");
      expect(result.confidence.percentage).toBe(100);
      expect(result.occupancyColor).toBe("red");
    });
  });

  describe("area correction wiring (area_occupancy_corrections)", () => {
    it("applies a real, matching area/subarea+band calibration to occupancyPercent/occupancyColor", async () => {
      const { client: statsClient } = makeMockOccupancyStatsClient([{ blockface_id: "bf-1", ...GREEN_STATS, mean_occupancy: 0.48 }]);
      const { client: correctionsClient } = makeMockAreaCorrectionsClient([
        { paidparkingarea: "Ballard", paidparkingsubarea: "Core", predicted_band_low: 25, predicted_band_high: 50, corrected_pct: 61.6, sample_count: 413 },
      ]);
      const blockface = makeBlockfaceRow({ id: "bf-1", paidparkingarea: "Ballard", paidparkingsubarea: "Core" });

      const { blockfaceResults } = await assembleSearchResults({ occupancyStatsClient: statsClient, areaCorrectionsClient: correctionsClient }, {
        blockfaceCandidates: [blockface],
        facilityCandidates: [],
        isoDay: 2,
        hour: 14,
        daysInFuture: 0,
      });
      const [result] = blockfaceResults as [BlockfaceHasDataResult];

      expect(result.occupancyPercent).toBe(61.6);
      expect(result.occupancyColor).toBe("orange"); // 61.6% -> orange band (50-75)
    });

    it("leaves confidence.meanOccupancy RAW even when occupancyPercent is corrected -- they must never both carry the correction", async () => {
      const { client: statsClient } = makeMockOccupancyStatsClient([{ blockface_id: "bf-1", ...GREEN_STATS, mean_occupancy: 0.48 }]);
      const { client: correctionsClient } = makeMockAreaCorrectionsClient([
        { paidparkingarea: "Ballard", paidparkingsubarea: "Core", predicted_band_low: 25, predicted_band_high: 50, corrected_pct: 61.6, sample_count: 413 },
      ]);
      const blockface = makeBlockfaceRow({ id: "bf-1", paidparkingarea: "Ballard", paidparkingsubarea: "Core" });

      const { blockfaceResults } = await assembleSearchResults({ occupancyStatsClient: statsClient, areaCorrectionsClient: correctionsClient }, {
        blockfaceCandidates: [blockface],
        facilityCandidates: [],
        isoDay: 2,
        hour: 14,
        daysInFuture: 0,
      });
      const [result] = blockfaceResults as [BlockfaceHasDataResult];

      expect(result.confidence.meanOccupancy).toBe(0.48);
      expect(result.occupancyPercent).toBe(61.6);
    });

    it("does NOT apply a Core calibration to a real Edge blockface in the same area -- subarea must match exactly", async () => {
      const { client: statsClient } = makeMockOccupancyStatsClient([{ blockface_id: "bf-edge", ...GREEN_STATS, mean_occupancy: 0.48 }]);
      const { client: correctionsClient } = makeMockAreaCorrectionsClient([
        { paidparkingarea: "Ballard", paidparkingsubarea: "Core", predicted_band_low: 25, predicted_band_high: 50, corrected_pct: 61.6, sample_count: 413 },
      ]);
      const blockface = makeBlockfaceRow({ id: "bf-edge", paidparkingarea: "Ballard", paidparkingsubarea: "Edge" });

      const { blockfaceResults } = await assembleSearchResults({ occupancyStatsClient: statsClient, areaCorrectionsClient: correctionsClient }, {
        blockfaceCandidates: [blockface],
        facilityCandidates: [],
        isoDay: 2,
        hour: 14,
        daysInFuture: 0,
      });
      const [result] = blockfaceResults as [BlockfaceHasDataResult];

      expect(result.occupancyPercent).toBe(48);
    });

    it("does NOT apply a Ballard/Core calibration to a blockface in an entirely different area", async () => {
      const { client: statsClient } = makeMockOccupancyStatsClient([{ blockface_id: "bf-other", ...GREEN_STATS, mean_occupancy: 0.48 }]);
      const { client: correctionsClient } = makeMockAreaCorrectionsClient([
        { paidparkingarea: "Ballard", paidparkingsubarea: "Core", predicted_band_low: 25, predicted_band_high: 50, corrected_pct: 61.6, sample_count: 413 },
      ]);
      const blockface = makeBlockfaceRow({ id: "bf-other", paidparkingarea: "Belltown", paidparkingsubarea: "North" });

      const { blockfaceResults } = await assembleSearchResults({ occupancyStatsClient: statsClient, areaCorrectionsClient: correctionsClient }, {
        blockfaceCandidates: [blockface],
        facilityCandidates: [],
        isoDay: 2,
        hour: 14,
        daysInFuture: 0,
      });
      const [result] = blockfaceResults as [BlockfaceHasDataResult];

      expect(result.occupancyPercent).toBe(48);
    });

    it("does NOT apply any correction to a blockface with no paidparkingarea at all (the overwhelming majority of the city)", async () => {
      const { client: statsClient } = makeMockOccupancyStatsClient([{ blockface_id: "bf-unareaed", ...GREEN_STATS, mean_occupancy: 0.48 }]);
      const { client: correctionsClient } = makeMockAreaCorrectionsClient([
        { paidparkingarea: "Ballard", paidparkingsubarea: "Core", predicted_band_low: 25, predicted_band_high: 50, corrected_pct: 61.6, sample_count: 413 },
      ]);
      const blockface = makeBlockfaceRow({ id: "bf-unareaed", paidparkingarea: null, paidparkingsubarea: null });

      const { blockfaceResults } = await assembleSearchResults({ occupancyStatsClient: statsClient, areaCorrectionsClient: correctionsClient }, {
        blockfaceCandidates: [blockface],
        facilityCandidates: [],
        isoDay: 2,
        hour: 14,
        daysInFuture: 0,
      });
      const [result] = blockfaceResults as [BlockfaceHasDataResult];

      expect(result.occupancyPercent).toBe(48);
    });

    it("multiple distinct real candidates in the same request each get correctly, independently matched -- no cross-contamination between them", async () => {
      const { client: statsClient } = makeMockOccupancyStatsClient([
        { blockface_id: "bf-core", ...GREEN_STATS, mean_occupancy: 0.48 },
        { blockface_id: "bf-edge", ...GREEN_STATS, mean_occupancy: 0.48 },
        { blockface_id: "bf-none", ...GREEN_STATS, mean_occupancy: 0.48 },
      ]);
      const { client: correctionsClient } = makeMockAreaCorrectionsClient([
        { paidparkingarea: "Ballard", paidparkingsubarea: "Core", predicted_band_low: 25, predicted_band_high: 50, corrected_pct: 61.6, sample_count: 413 },
      ]);

      const { blockfaceResults } = await assembleSearchResults({ occupancyStatsClient: statsClient, areaCorrectionsClient: correctionsClient }, {
        blockfaceCandidates: [
          makeBlockfaceRow({ id: "bf-core", paidparkingarea: "Ballard", paidparkingsubarea: "Core" }),
          makeBlockfaceRow({ id: "bf-edge", paidparkingarea: "Ballard", paidparkingsubarea: "Edge" }),
          makeBlockfaceRow({ id: "bf-none", paidparkingarea: null, paidparkingsubarea: null }),
        ],
        facilityCandidates: [],
        isoDay: 2,
        hour: 14,
        daysInFuture: 0,
        blockfaceLimit: "all",
      });
      const byId = new Map((blockfaceResults as BlockfaceHasDataResult[]).map((r) => [r.id, r]));

      expect(byId.get("bf-core")?.occupancyPercent).toBe(61.6);
      expect(byId.get("bf-edge")?.occupancyPercent).toBe(48);
      expect(byId.get("bf-none")?.occupancyPercent).toBe(48);
    });

    it("reads area_occupancy_corrections exactly once per request, via a single unfiltered select -- not once per candidate", async () => {
      const { client: statsClient } = makeMockOccupancyStatsClient([]);
      const { client: correctionsClient, fromCalls } = makeMockAreaCorrectionsClient([]);

      await assembleSearchResults({ occupancyStatsClient: statsClient, areaCorrectionsClient: correctionsClient }, {
        blockfaceCandidates: [makeBlockfaceRow({ id: "bf-1" }), makeBlockfaceRow({ id: "bf-2" }), makeBlockfaceRow({ id: "bf-3" })],
        facilityCandidates: [],
        isoDay: 2,
        hour: 14,
        daysInFuture: 0,
      });

      expect(fromCalls).toEqual(["area_occupancy_corrections"]);
    });

    it("propagates a real area_occupancy_corrections read failure as a thrown error, the same as an occupancy_stats failure would", async () => {
      const { client: statsClient } = makeMockOccupancyStatsClient([]);
      const correctionsClient = {
        from: () => ({
          select: () => ({
            then: (onFulfilled?: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "connection reset" } }).then(onFulfilled),
          }),
        }),
      } as unknown as AreaCorrectionsSupabaseClient;

      await expect(
        assembleSearchResults({ occupancyStatsClient: statsClient, areaCorrectionsClient: correctionsClient }, {
          blockfaceCandidates: [makeBlockfaceRow({ id: "bf-1" })],
          facilityCandidates: [],
          isoDay: 2,
          hour: 14,
          daysInFuture: 0,
        }),
      ).rejects.toThrow(/connection reset/);
    });
  });
});
