import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleReverseGeocodeRequest, type HandleReverseGeocodeRequestDeps } from "./handleReverseGeocodeRequest";
import { MAX_FETCH_ATTEMPTS } from "../geocoding/geocodeAddress";
import type { ReverseGeocodeCacheSupabaseClient } from "../geocoding/reverseGeocodeCoordinates";

const API_KEY = "test-locationiq-key";
const NOW = new Date("2026-09-05T12:00:00.000Z");
const LAT = 47.609794;
const LON = -122.342221;

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number; statusText?: string }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "OK",
    json: () => Promise.resolve(body),
  } as Response;
}

function makeReverseResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    place_id: "332664171376",
    osm_type: "node",
    osm_id: "2397460997",
    lat: "47.609794",
    lon: "-122.342221",
    display_name: "1900, Pike Place, Pike Place Market, Seattle, Washington, 98101, USA",
    ...overrides,
  };
}

const NO_MATCH_RESPONSE = jsonResponse({ error: "Unable to geocode" }, { ok: false, status: 404, statusText: "Not Found" });

// Same DI mock pattern as reverseGeocodeCoordinates.test.ts / handleParkingSearchRequest.test.ts.
function makeMockDeps(options: { cacheReadError?: { message: string } | null } = {}) {
  let cacheRow: Record<string, unknown> | null = null;

  const selectQueryBuilder = {
    eq: () => selectQueryBuilder,
    maybeSingle: async () => (options.cacheReadError ? { data: null, error: options.cacheReadError } : { data: cacheRow, error: null }),
  };

  const reverseGeocodeCacheClient = {
    from: () => ({
      select: () => selectQueryBuilder,
      upsert: async (row: Record<string, unknown>) => {
        cacheRow = { ...cacheRow, ...row };
        return { data: null, error: null };
      },
    }),
  } as unknown as ReverseGeocodeCacheSupabaseClient;

  const deps: HandleReverseGeocodeRequestDeps = { reverseGeocodeCacheClient, locationIqApiKey: API_KEY };
  return { deps };
}

describe("handleReverseGeocodeRequest", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function validBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({ lat: LAT, lon: LON, ...overrides });
  }

  describe("request validation (malformed_body)", () => {
    it("rejects malformed JSON", async () => {
      const { deps } = makeMockDeps();
      const result = await handleReverseGeocodeRequest(deps, "{not json", NOW);
      expect(result.status).toBe(400);
      expect(result.response).toMatchObject({ status: "invalid_request", reason: "malformed_body" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a non-object body", async () => {
      const { deps } = makeMockDeps();
      const result = await handleReverseGeocodeRequest(deps, JSON.stringify("just a string"), NOW);
      expect(result.response).toMatchObject({ status: "invalid_request", reason: "malformed_body" });
    });
  });

  describe("request validation (invalid_coordinates)", () => {
    it.each([
      ["missing lat", { lon: LON }],
      ["missing lon", { lat: LAT }],
      ["lat as a string", { lat: "47.6", lon: LON }],
      ["lat too high (91)", { lat: 91, lon: LON }],
      ["lat too low (-91)", { lat: -91, lon: LON }],
      ["lon too high (181)", { lat: LAT, lon: 181 }],
      ["lon too low (-181)", { lat: LAT, lon: -181 }],
      ["lat is NaN", { lat: Number.NaN, lon: LON }],
      ["lon is Infinity", { lat: LAT, lon: Number.POSITIVE_INFINITY }],
    ])("rejects %s", async (_label, body) => {
      const { deps } = makeMockDeps();
      const result = await handleReverseGeocodeRequest(deps, JSON.stringify(body), NOW);
      expect(result.status).toBe(400);
      expect(result.response).toMatchObject({ status: "invalid_request", reason: "invalid_coordinates" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("accepts real boundary values (lat=90, lon=-180)", async () => {
      const { deps } = makeMockDeps();
      fetchMock.mockResolvedValueOnce(jsonResponse(makeReverseResult()));
      const result = await handleReverseGeocodeRequest(deps, JSON.stringify({ lat: 90, lon: -180 }), NOW);
      expect(result.response.status).toBe("ok");
    });
  });

  describe("geocoding outcomes", () => {
    it("returns ok (200) with the resolved address on a real match", async () => {
      const { deps } = makeMockDeps();
      fetchMock.mockResolvedValueOnce(jsonResponse(makeReverseResult()));

      const result = await handleReverseGeocodeRequest(deps, validBody(), NOW);

      expect(result.status).toBe(200);
      expect(result.response).toEqual({
        status: "ok",
        resolvedAddress: {
          displayName: "1900, Pike Place, Pike Place Market, Seattle, Washington, 98101, USA",
          lat: 47.609794,
          lon: -122.342221,
        },
      });
    });

    it("returns no_match (200, not an error) when LocationIQ genuinely can't resolve the point", async () => {
      const { deps } = makeMockDeps();
      fetchMock.mockResolvedValueOnce(NO_MATCH_RESPONSE);

      const result = await handleReverseGeocodeRequest(deps, JSON.stringify({ lat: 0, lon: -140 }), NOW);

      expect(result.status).toBe(200);
      expect(result.response).toMatchObject({ status: "no_match" });
    });

    it("returns geocoding_service_unavailable (502) when LocationIQ's retries are exhausted", async () => {
      vi.useFakeTimers();
      const { deps } = makeMockDeps();
      fetchMock.mockResolvedValue(jsonResponse({ error: "Rate Limited Second" }, { ok: false, status: 429, statusText: "Too Many Requests" }));

      const resultPromise = handleReverseGeocodeRequest(deps, validBody(), NOW);
      await vi.runAllTimersAsync();
      const result = await resultPromise;
      vi.useRealTimers();

      expect(result.status).toBe(502);
      expect(result.response).toMatchObject({ status: "geocoding_service_unavailable" });
      expect(fetchMock).toHaveBeenCalledTimes(MAX_FETCH_ATTEMPTS);
      // The raw LocationIQ error text must never leak to the client.
      expect(JSON.stringify(result.response)).not.toMatch(/429|Rate Limited/);
    });

    it("returns geocoding_service_unavailable (502) on a non-retryable LocationIQ failure (bad API key)", async () => {
      const { deps } = makeMockDeps();
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Invalid key" }, { ok: false, status: 401, statusText: "Unauthorized" }));

      const result = await handleReverseGeocodeRequest(deps, validBody(), NOW);

      expect(result.status).toBe(502);
      expect(result.response).toMatchObject({ status: "geocoding_service_unavailable" });
    });

    it("returns geocoding_service_unavailable (502) on a structurally-invalid coordinate in LocationIQ's response", async () => {
      const { deps } = makeMockDeps();
      fetchMock.mockResolvedValueOnce(jsonResponse(makeReverseResult({ lat: "not-a-number" })));

      const result = await handleReverseGeocodeRequest(deps, validBody(), NOW);

      expect(result.status).toBe(502);
      expect(result.response).toMatchObject({ status: "geocoding_service_unavailable" });
    });

    it("returns geocoding_service_unavailable (502) on an unexpected (array-shaped) LocationIQ response", async () => {
      vi.useFakeTimers();
      const { deps } = makeMockDeps();
      fetchMock.mockResolvedValue(jsonResponse([makeReverseResult()]));

      const resultPromise = handleReverseGeocodeRequest(deps, validBody(), NOW);
      await vi.runAllTimersAsync();
      const result = await resultPromise;
      vi.useRealTimers();

      expect(result.status).toBe(502);
      expect(result.response).toMatchObject({ status: "geocoding_service_unavailable" });
    });
  });

  describe("cache failures -> internal_error", () => {
    it("returns internal_error (500) when reading reverse_geocode_cache fails", async () => {
      const { deps } = makeMockDeps({ cacheReadError: { message: "connection reset" } });

      const result = await handleReverseGeocodeRequest(deps, validBody(), NOW);

      expect(result.status).toBe(500);
      expect(result.response).toMatchObject({ status: "internal_error" });
      // The raw internal error text must never leak to the client.
      expect(JSON.stringify(result.response)).not.toMatch(/connection reset/);
    });
  });
});
