import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_FETCH_ATTEMPTS } from "./geocodeAddress";
import { reverseGeocodeCoordinates, type ReverseGeocodeCacheSupabaseClient } from "./reverseGeocodeCoordinates";

const API_KEY = "test-api-key";
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

// Live-captured real shape (this project's own reverse-geocoding
// investigation, "1900 Pike Place" resolved from 47.6097,-122.3422). Note
// this is a single object, not an array like forward search's fixture.
function makeReverseResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    place_id: "332664171376",
    licence: "https://locationiq.com/attribution",
    osm_type: "node",
    osm_id: "2397460997",
    lat: "47.609794",
    lon: "-122.342221",
    display_name: "1900, Pike Place, Pike Place Market, Seattle, King County, Washington, 98101, USA",
    boundingbox: ["47.609794", "47.609794", "-122.342221", "-122.342221"],
    address: { house_number: "1900", road: "Pike Place" },
    ...overrides,
  };
}

// Live-confirmed real shape of LocationIQ reverse's "no results" response --
// identical to forward search's: HTTP 404, {"error":"Unable to geocode"}.
const NO_MATCH_RESPONSE = jsonResponse({ error: "Unable to geocode" }, { ok: false, status: 404, statusText: "Not Found" });

// --- Mock reverse_geocode_cache client -----------------------------------

function makeMockClient(options: { existingRow?: Record<string, unknown> | null } = {}) {
  let currentRow: Record<string, unknown> | null = options.existingRow ?? null;
  const upsertCalls: Record<string, unknown>[] = [];

  const selectQueryBuilder = {
    eq: () => selectQueryBuilder,
    maybeSingle: async () => ({ data: currentRow, error: null }),
  };

  const client = {
    from: () => ({
      select: () => selectQueryBuilder,
      upsert: async (row: Record<string, unknown>) => {
        upsertCalls.push(row);
        currentRow = { ...currentRow, ...row };
        return { data: null, error: null };
      },
    }),
  } as unknown as ReverseGeocodeCacheSupabaseClient;

  return { client, upsertCalls, getCurrentRow: () => currentRow };
}

function makeFreshCacheRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    coordinate_key: "47.60979,-122.34222",
    matched: true,
    lat: 47.609794,
    lon: -122.342221,
    display_name: "1900, Pike Place, Pike Place Market, Seattle, Washington, 98101, USA",
    place_id: "332664171376",
    osm_type: "node",
    osm_id: "2397460997",
    raw_response: makeReverseResult(),
    // 1 hour old -- well within the 48h freshness window.
    updated_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe("reverseGeocodeCoordinates", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a fresh cache hit without calling LocationIQ at all", async () => {
    const { client, upsertCalls } = makeMockClient({ existingRow: makeFreshCacheRow() });

    const result = await reverseGeocodeCoordinates(client, API_KEY, LAT, LON, NOW);

    expect(result).toEqual({
      matched: true,
      lat: 47.609794,
      lon: -122.342221,
      displayName: "1900, Pike Place, Pike Place Market, Seattle, Washington, 98101, USA",
      placeId: "332664171376",
      osmType: "node",
      osmId: "2397460997",
      rawResponse: makeReverseResult(),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(upsertCalls).toHaveLength(0);
  });

  it("treats a cache entry older than 48 hours as stale and refreshes it from LocationIQ", async () => {
    const staleRow = makeFreshCacheRow({
      // Exactly 49 hours old -- past the 48h freshness window.
      updated_at: new Date(NOW.getTime() - 49 * 60 * 60 * 1000).toISOString(),
      display_name: "STALE VALUE",
    });
    const { client, upsertCalls } = makeMockClient({ existingRow: staleRow });
    fetchMock.mockResolvedValueOnce(jsonResponse(makeReverseResult({ display_name: "FRESH VALUE" })));

    const result = await reverseGeocodeCoordinates(client, API_KEY, LAT, LON, NOW);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ matched: true, displayName: "FRESH VALUE" });
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toMatchObject({ display_name: "FRESH VALUE", updated_at: NOW.toISOString() });
  });

  it("returns matched: false on a genuine no-match and caches the negative result", async () => {
    const { client, upsertCalls } = makeMockClient({ existingRow: null });
    fetchMock.mockResolvedValueOnce(NO_MATCH_RESPONSE);

    // A point far out in open ocean, the real case this was live-tested
    // against -- no enclosing administrative area at all.
    const result = await reverseGeocodeCoordinates(client, API_KEY, 0, -140, NOW);

    expect(result).toEqual({ matched: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toMatchObject({
      coordinate_key: "0.00000,-140.00000",
      matched: false,
      lat: null,
      lon: null,
      display_name: null,
      place_id: null,
      raw_response: null,
      updated_at: NOW.toISOString(),
    });
  });

  it("rounds coordinates to 5 decimal places to build the cache key", async () => {
    const { client } = makeMockClient({ existingRow: null });
    fetchMock.mockResolvedValueOnce(jsonResponse(makeReverseResult()));

    await reverseGeocodeCoordinates(client, API_KEY, 47.6097941234, -122.3422214321, NOW);

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    // The cache key rounds, but the actual LocationIQ request still uses
    // the caller's real, unrounded coordinates -- rounding is a caching
    // concern only, never a precision loss passed on to the real request.
    expect(requestedUrl.searchParams.get("lat")).toBe("47.6097941234");
    expect(requestedUrl.searchParams.get("lon")).toBe("-122.3422214321");
  });

  it("always requests format=json and addressdetails=1 against the reverse endpoint", async () => {
    const { client } = makeMockClient({ existingRow: null });
    fetchMock.mockResolvedValueOnce(jsonResponse(makeReverseResult()));

    await reverseGeocodeCoordinates(client, API_KEY, LAT, LON, NOW);

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.origin + requestedUrl.pathname).toBe("https://us1.locationiq.com/v1/reverse");
    expect(requestedUrl.searchParams.get("key")).toBe(API_KEY);
    expect(requestedUrl.searchParams.get("format")).toBe("json");
    expect(requestedUrl.searchParams.get("addressdetails")).toBe("1");
  });

  it("throws on an unexpected response shape (an array, like forward search returns) rather than silently miscaching it", async () => {
    // A plain Error (not LocationIQRequestError), so the retry loop's
    // "unrecognized failure defaults to retryable" rule applies -- every
    // attempt gets the same bad shape, so this needs fake timers just
    // like the other retry-path tests below, even though it isn't really
    // testing retry behavior itself.
    vi.useFakeTimers();
    const { client, upsertCalls } = makeMockClient({ existingRow: null });
    fetchMock.mockResolvedValue(jsonResponse([makeReverseResult()]));

    const assertion = expect(reverseGeocodeCoordinates(client, API_KEY, LAT, LON, NOW)).rejects.toThrow(/unexpected LocationIQ response shape/);
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(MAX_FETCH_ATTEMPTS);
    expect(upsertCalls).toHaveLength(0);
    vi.useRealTimers();
  });

  it("throws on a structurally-invalid (non-numeric) coordinate rather than silently miscaching it", async () => {
    const { client, upsertCalls } = makeMockClient({ existingRow: null });
    fetchMock.mockResolvedValueOnce(jsonResponse(makeReverseResult({ lat: "not-a-number" })));

    await expect(reverseGeocodeCoordinates(client, API_KEY, LAT, LON, NOW)).rejects.toThrow(RangeError);
    expect(upsertCalls).toHaveLength(0);
  });

  describe("retry-with-backoff-and-jitter on 429/5xx", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("retries a real 429 and succeeds once the next attempt goes through", async () => {
      const { client, upsertCalls } = makeMockClient({ existingRow: null });
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ error: "Rate Limited Second" }, { ok: false, status: 429, statusText: "Too Many Requests" }))
        .mockResolvedValueOnce(jsonResponse(makeReverseResult()));

      const resultPromise = reverseGeocodeCoordinates(client, API_KEY, LAT, LON, NOW);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.matched).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(upsertCalls).toHaveLength(1);
    });

    it("retries a transient 503 the same way as a 429", async () => {
      const { client } = makeMockClient({ existingRow: null });
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 503, statusText: "Service Unavailable" }))
        .mockResolvedValueOnce(jsonResponse(makeReverseResult()));

      const resultPromise = reverseGeocodeCoordinates(client, API_KEY, LAT, LON, NOW);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.matched).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("exhausts all retries on a sustained 429 and throws, without caching anything", async () => {
      const { client, upsertCalls } = makeMockClient({ existingRow: null });
      fetchMock.mockResolvedValue(jsonResponse({ error: "Rate Limited Second" }, { ok: false, status: 429, statusText: "Too Many Requests" }));

      const assertion = expect(reverseGeocodeCoordinates(client, API_KEY, LAT, LON, NOW)).rejects.toThrow(/429/);
      await vi.runAllTimersAsync();
      await assertion;

      expect(fetchMock).toHaveBeenCalledTimes(MAX_FETCH_ATTEMPTS);
      expect(upsertCalls).toHaveLength(0);
    });

    it("adds jitter on top of the exponential base delay, not just the bare doubling sequence", async () => {
      const { client } = makeMockClient({ existingRow: null });
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ error: "Rate Limited Second" }, { ok: false, status: 429, statusText: "Too Many Requests" }))
        .mockResolvedValueOnce(jsonResponse(makeReverseResult()));

      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const resultPromise = reverseGeocodeCoordinates(client, API_KEY, LAT, LON, NOW);
      await vi.runAllTimersAsync();
      await resultPromise;

      const delayArg = setTimeoutSpy.mock.calls[0]?.[1] as number;
      expect(delayArg).toBeGreaterThanOrEqual(1000);
      expect(delayArg).toBeLessThan(1000 + 250);
    });

    it("does not retry a non-retryable error (e.g. a bad API key), failing immediately", async () => {
      const { client, upsertCalls } = makeMockClient({ existingRow: null });
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Invalid key" }, { ok: false, status: 401, statusText: "Unauthorized" }));

      await expect(reverseGeocodeCoordinates(client, API_KEY, LAT, LON, NOW)).rejects.toThrow(/401/);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(upsertCalls).toHaveLength(0);
    });
  });
});
