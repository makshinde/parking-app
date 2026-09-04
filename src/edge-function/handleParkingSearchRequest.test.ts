import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleParkingSearchRequest, type HandleParkingSearchRequestDeps } from "./handleParkingSearchRequest";
import type { GeocodeCacheSupabaseClient } from "../geocoding/geocodeAddress";
import type { NearbyBlockfaceRow, NearbyOffStreetFacilityRow, OccupancyStatsSupabaseClient } from "../scoring/assembleSearchResults";
import type { ParkingSearchRpcClient, RpcQueryResult } from "./handleParkingSearchRequest";

const API_KEY = "test-locationiq-key";
const NOW = new Date("2026-06-15T21:00:00.000Z"); // 2026-06-15T14:00:00 Pacific, Monday, PDT

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number; statusText?: string }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "OK",
    json: () => Promise.resolve(body),
  } as Response;
}

function makeLocationIQMatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    place_id: "409547841",
    osm_type: "way",
    osm_id: "992915366",
    lat: "47.6592579",
    lon: "-122.3124109",
    display_name: "4315, 15th Avenue Northeast, Seattle, Washington, 98105, USA",
    ...overrides,
  };
}

const NO_MATCH_RESPONSE = jsonResponse({ error: "Unable to geocode" }, { ok: false, status: 404, statusText: "Not Found" });

// --- Combined mock Supabase-shaped deps -----------------------------------
//
// One in-memory fake per concern (geocode_cache, occupancy_stats, rpc),
// matching this project's established narrow-DI-interface pattern -- but
// combined into one factory since handleParkingSearchRequest genuinely
// needs all three at once, the same way streamArchiveWithResume.test.ts's
// makeMockClients() combines multiple table concerns behind one call.

function makeMockDeps(
  options: {
    occupancyStatsRows?: Record<string, unknown>[];
    blockfaceRows?: NearbyBlockfaceRow[];
    facilityRows?: NearbyOffStreetFacilityRow[];
    blockfaceRpcError?: { message: string } | null;
    facilityRpcError?: { message: string } | null;
    occupancyStatsError?: { message: string } | null;
  } = {},
) {
  let cacheRow: Record<string, unknown> | null = null;
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];

  const geocodeCacheSelectBuilder = {
    eq: () => geocodeCacheSelectBuilder,
    maybeSingle: async () => ({ data: cacheRow, error: null }),
  };
  const geocodeCacheClient = {
    from: () => ({
      select: () => geocodeCacheSelectBuilder,
      upsert: async (row: Record<string, unknown>) => {
        cacheRow = { ...cacheRow, ...row };
        return { data: null, error: null };
      },
    }),
  } as unknown as GeocodeCacheSupabaseClient;

  const occupancyQueryBuilder = {
    eq: () => occupancyQueryBuilder,
    in: () => occupancyQueryBuilder,
    then: (onFulfilled?: (v: unknown) => unknown) =>
      Promise.resolve(
        options.occupancyStatsError !== undefined && options.occupancyStatsError !== null
          ? { data: null, error: options.occupancyStatsError }
          : { data: options.occupancyStatsRows ?? [], error: null },
      ).then(onFulfilled),
  };
  const occupancyStatsClient = {
    from: () => ({ select: () => occupancyQueryBuilder }),
  } as unknown as OccupancyStatsSupabaseClient;

  const rpcClient: ParkingSearchRpcClient = {
    rpc: (<T>(fn: string, args: Record<string, unknown>): PromiseLike<RpcQueryResult<T>> => {
      rpcCalls.push({ fn, args });
      if (fn === "nearby_blockfaces") {
        const result: RpcQueryResult<NearbyBlockfaceRow> = {
          data: options.blockfaceRpcError ? null : (options.blockfaceRows ?? []),
          error: options.blockfaceRpcError ?? null,
        };
        return Promise.resolve(result as unknown as RpcQueryResult<T>);
      }
      const result: RpcQueryResult<NearbyOffStreetFacilityRow> = {
        data: options.facilityRpcError ? null : (options.facilityRows ?? []),
        error: options.facilityRpcError ?? null,
      };
      return Promise.resolve(result as unknown as RpcQueryResult<T>);
    }) as ParkingSearchRpcClient["rpc"],
  };

  const deps: HandleParkingSearchRequestDeps = { geocodeCacheClient, occupancyStatsClient, rpcClient, locationIqApiKey: API_KEY };
  return { deps, rpcCalls, getCacheRow: () => cacheRow };
}

function makeBlockfaceRow(overrides: Partial<NearbyBlockfaceRow> & { id: string }): NearbyBlockfaceRow {
  return {
    street_name: "PIKE ST",
    cross_street_from: "1ST AVE",
    cross_street_to: "2ND AVE",
    side_of_street: "N",
    is_paid: true,
    starting_rate_usd: 2,
    operating_days: [1, 2, 3, 4, 5],
    operating_hours_start: "08:00:00",
    operating_hours_end: "18:00:00",
    rate_tiers: [],
    location_geojson: { type: "LineString", coordinates: [] },
    distance_meters: 100,
    ...overrides,
  };
}

describe("handleParkingSearchRequest", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function validBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      address: "4315 15th Ave NE, Seattle, WA",
      time: { type: "quick", option: "right_now" },
      ...overrides,
    });
  }

  describe("request validation (malformed_body)", () => {
    it("rejects malformed JSON", async () => {
      const { deps } = makeMockDeps();
      const result = await handleParkingSearchRequest(deps, "{not json", NOW);
      expect(result.status).toBe(400);
      expect(result.response).toMatchObject({ status: "invalid_request", reason: "malformed_body" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a missing address", async () => {
      const { deps } = makeMockDeps();
      const result = await handleParkingSearchRequest(deps, JSON.stringify({ time: { type: "quick", option: "right_now" } }), NOW);
      expect(result.response).toMatchObject({ status: "invalid_request", reason: "malformed_body" });
    });

    it("rejects an empty address", async () => {
      const { deps } = makeMockDeps();
      const result = await handleParkingSearchRequest(deps, validBody({ address: "   " }), NOW);
      expect(result.response).toMatchObject({ status: "invalid_request", reason: "malformed_body" });
    });

    it("rejects an unrecognized quick time option", async () => {
      const { deps } = makeMockDeps();
      const result = await handleParkingSearchRequest(deps, validBody({ time: { type: "quick", option: "next_tuesday" } }), NOW);
      expect(result.response).toMatchObject({ status: "invalid_request", reason: "malformed_body" });
    });

    it("rejects a specific time with an unparseable instant string", async () => {
      const { deps } = makeMockDeps();
      const result = await handleParkingSearchRequest(deps, validBody({ time: { type: "specific", instant: "not-a-date" } }), NOW);
      expect(result.response).toMatchObject({ status: "invalid_request", reason: "malformed_body" });
    });
  });

  describe("request validation (invalid_radius / invalid_limit)", () => {
    it.each([0, -1, 1001])("rejects an out-of-range radiusMeters (%s)", async (radius) => {
      const { deps } = makeMockDeps();
      const result = await handleParkingSearchRequest(deps, validBody({ radiusMeters: radius }), NOW);
      expect(result.response).toMatchObject({ status: "invalid_request", reason: "invalid_radius" });
    });

    it.each([0, -1, 1.5])("rejects an invalid limit (%s)", async (limit) => {
      const { deps } = makeMockDeps();
      const result = await handleParkingSearchRequest(deps, validBody({ limit }), NOW);
      expect(result.response).toMatchObject({ status: "invalid_request", reason: "invalid_limit" });
    });

    it('accepts limit: "all"', async () => {
      const { deps } = makeMockDeps();
      fetchMock.mockResolvedValueOnce(jsonResponse([makeLocationIQMatch()]));
      const result = await handleParkingSearchRequest(deps, validBody({ limit: "all" }), NOW);
      expect(result.response.status).toBe("ok");
    });
  });

  describe("time-request validation (post-shape, via resolveRequestTime)", () => {
    it("rejects a specific time more than 7 days in the future", async () => {
      const { deps } = makeMockDeps();
      const eightDaysOut = new Date(NOW.getTime() + 8 * 24 * 60 * 60 * 1000).toISOString();
      const result = await handleParkingSearchRequest(deps, validBody({ time: { type: "specific", instant: eightDaysOut } }), NOW);
      expect(result.status).toBe(400);
      expect(result.response).toMatchObject({ status: "invalid_request", reason: "time_too_far_in_future" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a specific time that resolves to the past", async () => {
      const { deps } = makeMockDeps();
      const oneHourAgo = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
      const result = await handleParkingSearchRequest(deps, validBody({ time: { type: "specific", instant: oneHourAgo } }), NOW);
      expect(result.response).toMatchObject({ status: "invalid_request", reason: "invalid_time_request" });
    });
  });

  describe("geocoding outcomes", () => {
    it("returns address_not_found (HTTP 200) when LocationIQ finds no match, without calling either RPC", async () => {
      const { deps, rpcCalls } = makeMockDeps();
      fetchMock.mockResolvedValueOnce(NO_MATCH_RESPONSE);

      const result = await handleParkingSearchRequest(deps, validBody({ address: "zzzznonexistentaddressxyz" }), NOW);

      expect(result.status).toBe(200);
      expect(result.response).toMatchObject({ status: "address_not_found", query: "zzzznonexistentaddressxyz" });
      expect(rpcCalls).toHaveLength(0);
    });

    it("returns geocoding_service_unavailable (502) when LocationIQ's retries are exhausted", async () => {
      vi.useFakeTimers();
      const { deps } = makeMockDeps();
      fetchMock.mockResolvedValue(jsonResponse({ error: "Rate Limited Second" }, { ok: false, status: 429, statusText: "Too Many Requests" }));

      const resultPromise = handleParkingSearchRequest(deps, validBody(), NOW);
      await vi.runAllTimersAsync();
      const result = await resultPromise;
      vi.useRealTimers();

      expect(result.status).toBe(502);
      expect(result.response).toMatchObject({ status: "geocoding_service_unavailable" });
      // The raw LocationIQ error text must never leak to the client.
      expect(JSON.stringify(result.response)).not.toMatch(/429|Rate Limited/);
    });

    it("returns geocoding_service_unavailable (502) on a non-retryable LocationIQ failure (bad API key)", async () => {
      const { deps } = makeMockDeps();
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Invalid key" }, { ok: false, status: 401, statusText: "Unauthorized" }));

      const result = await handleParkingSearchRequest(deps, validBody(), NOW);

      expect(result.status).toBe(502);
      expect(result.response).toMatchObject({ status: "geocoding_service_unavailable" });
    });
  });

  describe("downstream (RPC / occupancy_stats) failures -> internal_error", () => {
    it("returns internal_error (500) when nearby_blockfaces fails", async () => {
      const { deps } = makeMockDeps({ blockfaceRpcError: { message: "relation does not exist" } });
      fetchMock.mockResolvedValueOnce(jsonResponse([makeLocationIQMatch()]));

      const result = await handleParkingSearchRequest(deps, validBody(), NOW);

      expect(result.status).toBe(500);
      expect(result.response).toMatchObject({ status: "internal_error" });
      expect(JSON.stringify(result.response)).not.toMatch(/relation does not exist/);
    });

    it("returns internal_error (500) when nearby_off_street_facilities fails", async () => {
      const { deps } = makeMockDeps({ facilityRpcError: { message: "boom" } });
      fetchMock.mockResolvedValueOnce(jsonResponse([makeLocationIQMatch()]));

      const result = await handleParkingSearchRequest(deps, validBody(), NOW);

      expect(result.status).toBe(500);
      expect(result.response).toMatchObject({ status: "internal_error" });
    });

    it("returns internal_error (500) when the occupancy_stats query fails", async () => {
      const { deps } = makeMockDeps({
        blockfaceRows: [makeBlockfaceRow({ id: "bf-1" })],
        occupancyStatsError: { message: "connection reset" },
      });
      fetchMock.mockResolvedValueOnce(jsonResponse([makeLocationIQMatch()]));

      const result = await handleParkingSearchRequest(deps, validBody(), NOW);

      expect(result.status).toBe(500);
      expect(result.response).toMatchObject({ status: "internal_error" });
    });
  });

  describe("the real success path", () => {
    it("assembles a complete, correct ok response and calls both RPCs with the resolved center point and radius", async () => {
      const { deps, rpcCalls } = makeMockDeps({
        blockfaceRows: [makeBlockfaceRow({ id: "bf-1", distance_meters: 50 })],
        facilityRows: [
          {
            id: "os-1",
            name: "TEST GARAGE",
            address: "1 Test St",
            capacity: 10,
            facility_type: "GARAGE",
            operator_name: null,
            rate_tiers: [],
            location_geojson: { type: "Point", coordinates: [] },
            distance_meters: 80,
          },
        ],
        occupancyStatsRows: [{ blockface_id: "bf-1", mean_occupancy: 0.3, std_dev: 0.2, sample_count: 150 }],
      });
      fetchMock.mockResolvedValueOnce(jsonResponse([makeLocationIQMatch()]));

      const result = await handleParkingSearchRequest(deps, validBody({ radiusMeters: 350 }), NOW);

      expect(result.status).toBe(200);
      expect(result.response).toMatchObject({
        status: "ok",
        resolvedTime: { isoDay: 1, hour: 14 },
        geocodedAddress: { lat: 47.6592579, lon: -122.3124109 },
        totalCandidateCount: 2,
      });
      if (result.response.status === "ok") {
        expect(result.response.results).toHaveLength(2);
        expect(result.response.results[0]).toMatchObject({ id: "bf-1", hasData: true });
      }

      expect(rpcCalls).toHaveLength(2);
      expect(rpcCalls).toContainEqual({
        fn: "nearby_blockfaces",
        args: { center_lon: -122.3124109, center_lat: 47.6592579, radius_meters: 350 },
      });
      expect(rpcCalls).toContainEqual({
        fn: "nearby_off_street_facilities",
        args: { center_lon: -122.3124109, center_lat: 47.6592579, radius_meters: 350 },
      });
    });

    it("defaults radiusMeters to 200 when omitted", async () => {
      const { deps, rpcCalls } = makeMockDeps();
      fetchMock.mockResolvedValueOnce(jsonResponse([makeLocationIQMatch()]));

      await handleParkingSearchRequest(deps, validBody(), NOW);

      expect(rpcCalls[0]?.args).toMatchObject({ radius_meters: 200 });
    });
  });
});
