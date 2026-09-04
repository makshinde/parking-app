import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { geocodeAddress, MAX_FETCH_ATTEMPTS, type GeocodeCacheSupabaseClient } from "./geocodeAddress";

const API_KEY = "test-api-key";
const NOW = new Date("2026-09-05T12:00:00.000Z");

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number; statusText?: string }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "OK",
    json: () => Promise.resolve(body),
  } as Response;
}

// Live-captured real shape (this project's own LocationIQ investigation),
// used as the test fixture rather than an invented one.
function makeSearchResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    place_id: "409547841",
    licence: "https://locationiq.com/attribution",
    osm_type: "way",
    osm_id: "992915366",
    lat: "47.6592579",
    lon: "-122.3124109",
    class: "place",
    type: "house",
    importance: 0.0001,
    display_name: "4315, 15th Avenue Northeast, Greek Row, University District, Seattle, King County, Washington, 98105, USA",
    address: { house_number: "4315", road: "15th Avenue Northeast" },
    boundingbox: ["47.6599420", "47.6600420", "-122.3121471", "-122.3120471"],
    ...overrides,
  };
}

const NO_MATCH_RESPONSE = jsonResponse({ error: "Unable to geocode" }, { ok: false, status: 404, statusText: "Not Found" });

// --- Mock geocode_cache client -----------------------------------------
//
// Minimal in-memory backing store, same DI pattern as this project's other
// mock Supabase clients (e.g. streamArchiveWithResume.test.ts's
// makeMockClients): select/eq/maybeSingle for the cache read,
// upsert(onConflict) for the cache write.

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
  } as unknown as GeocodeCacheSupabaseClient;

  return { client, upsertCalls, getCurrentRow: () => currentRow };
}

function makeFreshCacheRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    query_text: "4315 15th ave ne, seattle, wa",
    matched: true,
    lat: 47.6592579,
    lon: -122.3124109,
    display_name: "4315, 15th Avenue Northeast, University District, Seattle, Washington, 98105, USA",
    place_id: "409547841",
    osm_type: "way",
    osm_id: "992915366",
    raw_response: makeSearchResult(),
    // 1 hour old -- well within the 48h freshness window.
    updated_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe("geocodeAddress", () => {
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

    const result = await geocodeAddress(client, API_KEY, "4315 15th Ave NE, Seattle, WA", NOW);

    expect(result).toEqual({
      matched: true,
      lat: 47.6592579,
      lon: -122.3124109,
      displayName: "4315, 15th Avenue Northeast, University District, Seattle, Washington, 98105, USA",
      placeId: "409547841",
      osmType: "way",
      osmId: "992915366",
      rawResponse: makeSearchResult(),
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
    fetchMock.mockResolvedValueOnce(jsonResponse([makeSearchResult({ display_name: "FRESH VALUE" })]));

    const result = await geocodeAddress(client, API_KEY, "4315 15th Ave NE, Seattle, WA", NOW);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ matched: true, displayName: "FRESH VALUE" });
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toMatchObject({ display_name: "FRESH VALUE", updated_at: NOW.toISOString() });
  });

  it("returns matched: false on a genuine no-match and caches the negative result", async () => {
    const { client, upsertCalls } = makeMockClient({ existingRow: null });
    fetchMock.mockResolvedValueOnce(NO_MATCH_RESPONSE);

    const result = await geocodeAddress(client, API_KEY, "zzzznonexistentaddressxyz", NOW);

    expect(result).toEqual({ matched: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toMatchObject({
      query_text: "zzzznonexistentaddressxyz",
      matched: false,
      lat: null,
      lon: null,
      display_name: null,
      place_id: null,
      raw_response: null,
      updated_at: NOW.toISOString(),
    });
  });

  it("treats an empty result array (a 200 with no matches) the same as a confirmed no-match", async () => {
    const { client } = makeMockClient({ existingRow: null });
    fetchMock.mockResolvedValueOnce(jsonResponse([]));

    const result = await geocodeAddress(client, API_KEY, "some empty-result query", NOW);

    expect(result).toEqual({ matched: false });
  });

  it("always requests the fixed Seattle viewbox with bounded=1, format=json, and limit=1", async () => {
    const { client } = makeMockClient({ existingRow: null });
    fetchMock.mockResolvedValueOnce(jsonResponse([makeSearchResult()]));

    await geocodeAddress(client, API_KEY, "701 5th Ave, Seattle, WA", NOW);

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.origin + requestedUrl.pathname).toBe("https://us1.locationiq.com/v1/search");
    expect(requestedUrl.searchParams.get("key")).toBe(API_KEY);
    expect(requestedUrl.searchParams.get("q")).toBe("701 5th ave, seattle, wa");
    expect(requestedUrl.searchParams.get("format")).toBe("json");
    expect(requestedUrl.searchParams.get("limit")).toBe("1");
    expect(requestedUrl.searchParams.get("viewbox")).toBe("-122.46,47.49,-122.22,47.73");
    expect(requestedUrl.searchParams.get("bounded")).toBe("1");
  });

  it("throws on a structurally-invalid (non-numeric) coordinate rather than silently miscaching it", async () => {
    const { client, upsertCalls } = makeMockClient({ existingRow: null });
    fetchMock.mockResolvedValueOnce(jsonResponse([makeSearchResult({ lat: "not-a-number" })]));

    await expect(geocodeAddress(client, API_KEY, "a bad coordinate query", NOW)).rejects.toThrow(RangeError);
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
        .mockResolvedValueOnce(jsonResponse([makeSearchResult()]));

      const resultPromise = geocodeAddress(client, API_KEY, "701 5th Ave, Seattle, WA", NOW);
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
        .mockResolvedValueOnce(jsonResponse([makeSearchResult()]));

      const resultPromise = geocodeAddress(client, API_KEY, "701 5th Ave, Seattle, WA", NOW);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.matched).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("exhausts all retries on a sustained 429 and throws, without caching anything", async () => {
      const { client, upsertCalls } = makeMockClient({ existingRow: null });
      fetchMock.mockResolvedValue(jsonResponse({ error: "Rate Limited Second" }, { ok: false, status: 429, statusText: "Too Many Requests" }));

      const assertion = expect(geocodeAddress(client, API_KEY, "701 5th Ave, Seattle, WA", NOW)).rejects.toThrow(/429/);
      await vi.runAllTimersAsync();
      await assertion;

      // Initial attempt plus every retry, no more -- confirms the backoff
      // loop actually stops instead of retrying forever.
      expect(fetchMock).toHaveBeenCalledTimes(MAX_FETCH_ATTEMPTS);
      expect(upsertCalls).toHaveLength(0);
    });

    it("adds jitter on top of the exponential base delay, not just the bare doubling sequence", async () => {
      const { client } = makeMockClient({ existingRow: null });
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ error: "Rate Limited Second" }, { ok: false, status: 429, statusText: "Too Many Requests" }))
        .mockResolvedValueOnce(jsonResponse([makeSearchResult()]));

      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const resultPromise = geocodeAddress(client, API_KEY, "701 5th Ave, Seattle, WA", NOW);
      await vi.runAllTimersAsync();
      await resultPromise;

      const delayArg = setTimeoutSpy.mock.calls[0]?.[1] as number;
      // Base delay for the first retry is exactly 1000ms; with jitter added
      // it must be strictly more than that, and bounded by the documented
      // 250ms jitter ceiling.
      expect(delayArg).toBeGreaterThanOrEqual(1000);
      expect(delayArg).toBeLessThan(1000 + 250);
    });

    it("does not retry a non-retryable error (e.g. a bad API key), failing immediately", async () => {
      const { client, upsertCalls } = makeMockClient({ existingRow: null });
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Invalid key" }, { ok: false, status: 401, statusText: "Unauthorized" }));

      await expect(geocodeAddress(client, API_KEY, "701 5th Ave, Seattle, WA", NOW)).rejects.toThrow(/401/);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(upsertCalls).toHaveLength(0);
    });
  });
});
