import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDestinationCoordinates } from "./resolveDestinationCoordinates.ts";
import { GoogleApiRequestError } from "./autocompleteDestination.ts";

const API_KEY = "test-google-places-key";
const PLACE_ID = "ChIJkaHOMclqkFQRSMxIEFOHp_k"; // real Pigott Building place ID, from this project's own live investigation

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number; statusText?: string }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "OK",
    json: () => Promise.resolve(body),
  } as Response;
}

function makeOkResponse(overrides: Record<string, unknown> = {}) {
  return jsonResponse({
    status: "OK",
    results: [
      {
        formatted_address: "Pigott Building, 12th Avenue, Seattle, WA, USA",
        geometry: { location: { lat: 47.6106993, lng: -122.3186791 } },
        ...overrides,
      },
    ],
  });
}

// Live-verified real shape: an invalid/unauthorized API key returns HTTP
// 200 with this exact body, not a 401/403.
const REQUEST_DENIED_RESPONSE = jsonResponse({
  error_message: "This API key is not authorized to use this service or API. Please check the API restrictions settings of your API key in the Google Cloud Console to ensure that all of the APIs and services you need to use are correctly specified in the list of enabled APIs.",
  results: [],
  status: "REQUEST_DENIED",
});

describe("resolveDestinationCoordinates", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns matched: true with real coordinates and formatted address on OK", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse());

    const result = await resolveDestinationCoordinates(API_KEY, PLACE_ID);

    expect(result).toEqual({
      matched: true,
      displayName: "Pigott Building, 12th Avenue, Seattle, WA, USA",
      lat: 47.6106993,
      lon: -122.3186791,
    });
  });

  it("sends a GET request with place_id and key as query params", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse());

    await resolveDestinationCoordinates(API_KEY, PLACE_ID);

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.origin + requestedUrl.pathname).toBe("https://maps.googleapis.com/maps/api/geocode/json");
    expect(requestedUrl.searchParams.get("place_id")).toBe(PLACE_ID);
    expect(requestedUrl.searchParams.get("key")).toBe(API_KEY);
  });

  it("returns matched: false on a genuine ZERO_RESULTS, not an error", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "ZERO_RESULTS", results: [] }));

    const result = await resolveDestinationCoordinates(API_KEY, PLACE_ID);

    expect(result).toEqual({ matched: false });
  });

  it("throws a non-retryable GoogleApiRequestError on the real, live-verified REQUEST_DENIED shape (HTTP 200)", async () => {
    fetchMock.mockResolvedValueOnce(REQUEST_DENIED_RESPONSE);

    const err = await resolveDestinationCoordinates(API_KEY, PLACE_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleApiRequestError);
    expect((err as GoogleApiRequestError).retryable).toBe(false);
    expect((err as Error).message).toMatch(/misconfigured or unauthorized API key/);
  });

  it("throws a non-retryable error on INVALID_REQUEST", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "INVALID_REQUEST", results: [] }));

    await expect(resolveDestinationCoordinates(API_KEY, PLACE_ID)).rejects.toThrow(/rejected the request as invalid/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws RangeError on a non-finite coordinate in an otherwise-OK response", async () => {
    // A plain RangeError (not GoogleApiRequestError) defaults to
    // retryable in the retry loop -- same established behavior the
    // LocationIQ-backed modules already had for their own equivalent
    // non-numeric-coordinate case -- so all 4 attempts need a mocked
    // response.
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(makeOkResponse({ geometry: { location: { lat: Number.NaN, lng: -122.3186791 } } }));

    const assertion = expect(resolveDestinationCoordinates(API_KEY, PLACE_ID)).rejects.toThrow(RangeError);
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();
  });

  it("throws on OK status with an empty results array", async () => {
    // Same defaults-to-retryable reasoning as the RangeError case above.
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse({ status: "OK", results: [] }));

    const assertion = expect(resolveDestinationCoordinates(API_KEY, PLACE_ID)).rejects.toThrow(/empty results array/);
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();
  });

  describe("retry budget (4 attempts, matching geocodeAddress.ts's own convention)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("retries OVER_QUERY_LIMIT and succeeds if a later attempt goes through", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ status: "OVER_QUERY_LIMIT", results: [] }))
        .mockResolvedValueOnce(makeOkResponse());

      const resultPromise = resolveDestinationCoordinates(API_KEY, PLACE_ID);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toMatchObject({ matched: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("exhausts its 4-attempt budget on a sustained OVER_QUERY_LIMIT and throws", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ status: "OVER_QUERY_LIMIT", results: [] }));

      const assertion = expect(resolveDestinationCoordinates(API_KEY, PLACE_ID)).rejects.toThrow(/OVER_QUERY_LIMIT/);
      await vi.runAllTimersAsync();
      await assertion;

      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("retries UNKNOWN_ERROR (documented as transient)", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ status: "UNKNOWN_ERROR", results: [] })).mockResolvedValueOnce(makeOkResponse());

      const resultPromise = resolveDestinationCoordinates(API_KEY, PLACE_ID);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toMatchObject({ matched: true });
    });

    it("retries a real transport-level 5xx", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 503, statusText: "Service Unavailable" }))
        .mockResolvedValueOnce(makeOkResponse());

      const resultPromise = resolveDestinationCoordinates(API_KEY, PLACE_ID);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toMatchObject({ matched: true });
    });

    it("does not retry a non-retryable REQUEST_DENIED, failing immediately", async () => {
      fetchMock.mockResolvedValueOnce(REQUEST_DENIED_RESPONSE);

      await expect(resolveDestinationCoordinates(API_KEY, PLACE_ID)).rejects.toBeInstanceOf(GoogleApiRequestError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
