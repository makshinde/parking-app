import { describe, expect, it } from "vitest";
import {
  assembleSearchResults,
  type BlockfaceHasDataResult,
  type BlockfaceNoDataResult,
  type NearbyBlockfaceRow,
  type NearbyOffStreetFacilityRow,
  type OccupancyStatsSupabaseClient,
  type OffStreetFacilityResult,
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

describe("assembleSearchResults", () => {
  it("marks every off-street facility hasData: false unconditionally", async () => {
    const { client } = makeMockOccupancyStatsClient([]);
    const facility = makeFacilityRow({ id: "os-1" });

    const [result] = await assembleSearchResults(client, {
      blockfaceCandidates: [],
      facilityCandidates: [facility],
      isoDay: 1,
      hour: 9,
      daysInFuture: 0,
    });

    expect(result).toMatchObject({ type: "off_street_facility", hasData: false, id: "os-1" });
  });

  it("marks a blockface with no matching occupancy_stats row hasData: false", async () => {
    const { client } = makeMockOccupancyStatsClient([]); // no rows at all
    const blockface = makeBlockfaceRow({ id: "bf-1" });

    const [result] = await assembleSearchResults(client, {
      blockfaceCandidates: [blockface],
      facilityCandidates: [],
      isoDay: 1,
      hour: 9,
      daysInFuture: 0,
    });

    expect(result).toMatchObject({ type: "blockface", hasData: false, id: "bf-1" });
  });

  it("skips the occupancy_stats query entirely when there are no blockface candidates", async () => {
    const { client, fromCalls } = makeMockOccupancyStatsClient([]);

    await assembleSearchResults(client, {
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

    const results = await assembleSearchResults(client, {
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

    const byId = new Map(results.map((r) => [r.id, r]));
    expect(byId.get("bf-1")).toMatchObject({ hasData: true, confidence: { score: 10 } });
    expect(byId.get("bf-2")).toMatchObject({ hasData: false });
    expect(byId.get("bf-3")).toMatchObject({ hasData: true, confidence: { score: 2 } });
  });

  it("sorts a realistic mixed set: hasData first by ascending occupancy band then descending confidence, no-data last by real combined distance", async () => {
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
      makeBlockfaceRow({ id: "bf-e", distance_meters: 50 }), // no occupancy_stats row -> hasData: false
    ];
    const facilityCandidates = [
      makeFacilityRow({ id: "os-f", distance_meters: 30 }),
      makeFacilityRow({ id: "os-g", distance_meters: 200 }),
    ];

    const results = await assembleSearchResults(client, {
      blockfaceCandidates,
      facilityCandidates,
      isoDay: 1,
      hour: 9,
      daysInFuture: 0,
      limit: "all",
    });

    expect(results.map((r) => r.id)).toEqual(["bf-a", "bf-b", "bf-c", "bf-d", "os-f", "bf-e", "os-g"]);

    // Confirm the hasData block really is grouped/ordered by band then confidence, not by coincidence.
    const hasDataResults = results.slice(0, 4) as BlockfaceHasDataResult[];
    expect(hasDataResults.map((r) => r.confidence.color)).toEqual(["green", "yellow", "orange", "red"]);

    // Confirm the no-data tail really is in combined distance order (30, 50, 200),
    // interleaving both candidate types rather than grouping by type.
    const noDataResults = results.slice(4) as (BlockfaceNoDataResult | OffStreetFacilityResult)[];
    expect(noDataResults.map((r) => r.distanceMeters)).toEqual([30, 50, 200]);
    expect(noDataResults.every((r) => r.hasData === false)).toBe(true);
  });

  it("caps the result list at 20 by default", async () => {
    const stats = Array.from({ length: 25 }, (_, i) => ({ blockface_id: `bf-${i}`, ...GREEN_STATS, mean_occupancy: 0.1 }));
    const { client } = makeMockOccupancyStatsClient(stats);
    const blockfaceCandidates = Array.from({ length: 25 }, (_, i) => makeBlockfaceRow({ id: `bf-${i}` }));

    const results = await assembleSearchResults(client, {
      blockfaceCandidates,
      facilityCandidates: [],
      isoDay: 1,
      hour: 9,
      daysInFuture: 0,
    });

    expect(results).toHaveLength(20);
  });

  it("returns the full, uncapped list when limit: 'all' is requested", async () => {
    const stats = Array.from({ length: 25 }, (_, i) => ({ blockface_id: `bf-${i}`, ...GREEN_STATS, mean_occupancy: 0.1 }));
    const { client } = makeMockOccupancyStatsClient(stats);
    const blockfaceCandidates = Array.from({ length: 25 }, (_, i) => makeBlockfaceRow({ id: `bf-${i}` }));

    const results = await assembleSearchResults(client, {
      blockfaceCandidates,
      facilityCandidates: [],
      isoDay: 1,
      hour: 9,
      daysInFuture: 0,
      limit: "all",
    });

    expect(results).toHaveLength(25);
  });

  it("respects an explicit numeric limit smaller than the result set", async () => {
    const stats = Array.from({ length: 10 }, (_, i) => ({ blockface_id: `bf-${i}`, ...GREEN_STATS, mean_occupancy: 0.1 }));
    const { client } = makeMockOccupancyStatsClient(stats);
    const blockfaceCandidates = Array.from({ length: 10 }, (_, i) => makeBlockfaceRow({ id: `bf-${i}` }));

    const results = await assembleSearchResults(client, {
      blockfaceCandidates,
      facilityCandidates: [],
      isoDay: 1,
      hour: 9,
      daysInFuture: 0,
      limit: 5,
    });

    expect(results).toHaveLength(5);
  });

  it.each([0, -1, 1.5])("rejects an invalid limit (%s) rather than silently coercing it", async (badLimit) => {
    const { client } = makeMockOccupancyStatsClient([]);

    await expect(
      assembleSearchResults(client, {
        blockfaceCandidates: [],
        facilityCandidates: [makeFacilityRow({ id: "os-1" })],
        isoDay: 1,
        hour: 9,
        daysInFuture: 0,
        limit: badLimit,
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

    const [result] = await assembleSearchResults(client, {
      blockfaceCandidates: [blockface],
      facilityCandidates: [],
      isoDay: 1,
      hour: 9,
      daysInFuture: 0,
    });

    expect(result).toEqual({
      type: "blockface",
      id: "bf-1",
      name: "PIKE ST (1ST AVE to 2ND AVE), N side",
      geometry: blockface.location_geojson,
      distanceMeters: blockface.distance_meters,
      hasData: true,
      confidence: { score: 6, percentage: 60, color: "yellow", meanOccupancy: 0.42 },
      pricing: { isPaid: true, startingRateUsd: 2, rateTiers: blockface.rate_tiers },
    });
  });

  it("assembles an off-street facility's pricing from its own rate_tiers, with no isPaid concept", async () => {
    const { client } = makeMockOccupancyStatsClient([]);
    const facility = makeFacilityRow({ id: "os-1", name: "DIAMOND PARKING WX04" });

    const [result] = await assembleSearchResults(client, {
      blockfaceCandidates: [],
      facilityCandidates: [facility],
      isoDay: 1,
      hour: 9,
      daysInFuture: 0,
    });

    expect(result).toEqual({
      type: "off_street_facility",
      id: "os-1",
      name: "DIAMOND PARKING WX04",
      geometry: facility.location_geojson,
      distanceMeters: facility.distance_meters,
      hasData: false,
      pricing: { rateTiers: facility.rate_tiers },
    });
  });
});
