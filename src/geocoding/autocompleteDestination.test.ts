import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autocompleteDestination } from "./autocompleteDestination";

const API_KEY = "test-api-key";

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number; statusText?: string }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "OK",
    json: () => Promise.resolve(body),
  } as Response;
}

// Live-captured real shape (this project's own autocomplete investigation,
// "pike pl" against the real API).
function makeAutocompleteResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    place_id: "323319931923",
    osm_id: "363400641",
    osm_type: "way",
    licence: "https://locationiq.com/attribution",
    lat: "47.60939675",
    lon: "-122.34141018",
    display_name: "Pike Place Market, 2nd Avenue Cycletrack, Central Business District, Belltown, Seattle, King County, Washington, 98101, USA",
    display_place: "Pike Place Market",
    display_address: "2nd Avenue Cycletrack, Central Business District, Belltown, Seattle, King County, Washington, 98101, USA",
    ...overrides,
  };
}

const NO_MATCH_RESPONSE = jsonResponse({ error: "Unable to geocode" }, { ok: false, status: 404, statusText: "Not Found" });
const INVALID_REQUEST_RESPONSE = jsonResponse({ error: "Invalid Request" }, { ok: false, status: 400, statusText: "Bad Request" });

describe("autocompleteDestination", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed suggestions, preserving display_place/display_address", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([makeAutocompleteResult()]));

    const results = await autocompleteDestination(API_KEY, "pike pl", 5);

    expect(results).toEqual([
      {
        placeId: "323319931923",
        displayName: "Pike Place Market, 2nd Avenue Cycletrack, Central Business District, Belltown, Seattle, King County, Washington, 98101, USA",
        displayPlace: "Pike Place Market",
        displayAddress: "2nd Avenue Cycletrack, Central Business District, Belltown, Seattle, King County, Washington, 98101, USA",
        lat: 47.60939675,
        lon: -122.34141018,
      },
    ]);
  });

  it("falls back to display_name when display_place is missing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([makeAutocompleteResult({ display_place: undefined, display_address: undefined })]));

    const [result] = await autocompleteDestination(API_KEY, "pike pl", 5);

    expect(result).toMatchObject({ displayPlace: result?.displayName, displayAddress: null });
  });

  it("returns an empty list on a genuine no-match, not an error", async () => {
    fetchMock.mockResolvedValueOnce(NO_MATCH_RESPONSE);

    const results = await autocompleteDestination(API_KEY, "zzzznonexistent", 5);

    expect(results).toEqual([]);
  });

  it("always requests format=json, bounded=1, and the fixed Seattle viewbox", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([makeAutocompleteResult()]));

    await autocompleteDestination(API_KEY, "pike pl", 5);

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.origin + requestedUrl.pathname).toBe("https://us1.locationiq.com/v1/autocomplete");
    expect(requestedUrl.searchParams.get("key")).toBe(API_KEY);
    expect(requestedUrl.searchParams.get("q")).toBe("pike pl");
    expect(requestedUrl.searchParams.get("format")).toBe("json");
    expect(requestedUrl.searchParams.get("limit")).toBe("5");
    expect(requestedUrl.searchParams.get("viewbox")).toBe("-122.46,47.49,-122.22,47.73");
    expect(requestedUrl.searchParams.get("bounded")).toBe("1");
  });

  it("throws a distinctly-classifiable error on LocationIQ's real 'Invalid Request' shape, without retrying", async () => {
    fetchMock.mockResolvedValueOnce(INVALID_REQUEST_RESPONSE);

    await expect(autocompleteDestination(API_KEY, "", 5)).rejects.toThrow(/rejected the request as invalid/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on an unexpected (non-array) response shape rather than silently returning garbage", async () => {
    // A plain Error (not LocationIQRequestError), so the retry loop's
    // "unrecognized failure defaults to retryable" rule applies -- both
    // attempts (this module's 2-attempt budget) get the same bad shape,
    // so this needs fake timers, same as the retry-path tests below, even
    // though it isn't really testing retry behavior itself.
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse({ not: "an array" }));

    const assertion = expect(autocompleteDestination(API_KEY, "pike pl", 5)).rejects.toThrow(/unexpected LocationIQ response shape/);
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("throws on a structurally-invalid (non-numeric) coordinate", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([makeAutocompleteResult({ lat: "not-a-number" })]));

    await expect(autocompleteDestination(API_KEY, "pike pl", 5)).rejects.toThrow(RangeError);
  });

  describe("shortened retry budget (2 attempts, not geocodeAddress.ts's 4)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("retries a real 429 exactly once and succeeds if the retry goes through", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ error: "Rate Limited Second" }, { ok: false, status: 429, statusText: "Too Many Requests" }))
        .mockResolvedValueOnce(jsonResponse([makeAutocompleteResult()]));

      const resultPromise = autocompleteDestination(API_KEY, "pike pl", 5);
      await vi.runAllTimersAsync();
      const results = await resultPromise;

      expect(results).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("exhausts its 2-attempt budget on a sustained 429 and throws (not geocodeAddress.ts's 4)", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: "Rate Limited Second" }, { ok: false, status: 429, statusText: "Too Many Requests" }));

      const assertion = expect(autocompleteDestination(API_KEY, "pike pl", 5)).rejects.toThrow(/429/);
      await vi.runAllTimersAsync();
      await assertion;

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not retry a non-retryable error (e.g. a bad API key), failing immediately", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Invalid key" }, { ok: false, status: 401, statusText: "Unauthorized" }));

      await expect(autocompleteDestination(API_KEY, "pike pl", 5)).rejects.toThrow(/401/);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
