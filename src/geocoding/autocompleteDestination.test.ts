import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autocompleteDestination, GoogleApiRequestError } from "./autocompleteDestination.ts";

const API_KEY = "test-api-key";

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number; statusText?: string }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "OK",
    json: () => Promise.resolve(body),
  } as Response;
}

// Live-captured real shape (this project's own Google Places Autocomplete
// (New) investigation, "pike pl" against the real API).
function makePlacePrediction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    placePrediction: {
      placeId: "ChIJy9ZRwbJqkFQRHJ8-Y18dRGA",
      text: { text: "Pike Place Market, Seattle, WA, USA" },
      structuredFormat: {
        mainText: { text: "Pike Place Market" },
        secondaryText: { text: "Seattle, WA, USA" },
      },
      types: ["political", "geocode", "neighborhood"],
      ...overrides,
    },
  };
}

// Live-verified real shape: Google returns HTTP 200 with body `{}` for a
// genuine no-match -- `suggestions` is entirely absent, not an empty array.
const NO_MATCH_RESPONSE = jsonResponse({});
// Live-verified real shape: empty/missing `input` both produce the same
// body.
const INVALID_ARGUMENT_RESPONSE = jsonResponse(
  { error: { code: 400, message: "input must be non-empty.\n", status: "INVALID_ARGUMENT" } },
  { ok: false, status: 400, statusText: "Bad Request" },
);

describe("autocompleteDestination", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed suggestions, preserving displayText/displayAddress", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ suggestions: [makePlacePrediction()] }));

    const results = await autocompleteDestination(API_KEY, "pike pl", 5);

    expect(results).toEqual([
      {
        placeId: "ChIJy9ZRwbJqkFQRHJ8-Y18dRGA",
        displayText: "Pike Place Market",
        displayAddress: "Seattle, WA, USA",
      },
    ]);
  });

  it("falls back to text.text when structuredFormat.mainText is missing", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        suggestions: [
          makePlacePrediction({
            structuredFormat: undefined,
          }),
        ],
      }),
    );

    const [result] = await autocompleteDestination(API_KEY, "pike pl", 5);

    expect(result).toMatchObject({ displayText: "Pike Place Market, Seattle, WA, USA", displayAddress: null });
  });

  it("returns an empty list on a genuine no-match (suggestions key absent), not an error", async () => {
    fetchMock.mockResolvedValueOnce(NO_MATCH_RESPONSE);

    const results = await autocompleteDestination(API_KEY, "zzzznonexistent", 5);

    expect(results).toEqual([]);
  });

  it("filters out a queryPrediction entry (no placePrediction) defensively", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        suggestions: [{ queryPrediction: { text: { text: "some query" } } }, makePlacePrediction()],
      }),
    );

    const results = await autocompleteDestination(API_KEY, "pike pl", 5);

    expect(results).toHaveLength(1);
    expect(results[0]?.placeId).toBe("ChIJy9ZRwbJqkFQRHJ8-Y18dRGA");
  });

  it("sends POST with X-Goog-Api-Key, the query as `input`, and the fixed Seattle locationRestriction", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ suggestions: [makePlacePrediction()] }));

    await autocompleteDestination(API_KEY, "pike pl", 5);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://places.googleapis.com/v1/places:autocomplete");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Goog-Api-Key"]).toBe(API_KEY);
    const body = JSON.parse(init.body as string);
    expect(body.input).toBe("pike pl");
    expect(body.locationRestriction.rectangle).toEqual({
      low: { latitude: 47.49, longitude: -122.46 },
      high: { latitude: 47.73, longitude: -122.22 },
    });
  });

  it("caps results at the given limit -- Google's Autocomplete (New) API has no server-side limit param", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        suggestions: [
          makePlacePrediction({ placeId: "a" }),
          makePlacePrediction({ placeId: "b" }),
          makePlacePrediction({ placeId: "c" }),
        ],
      }),
    );

    const results = await autocompleteDestination(API_KEY, "pike", 2);

    expect(results).toHaveLength(2);
  });

  it("throws a distinctly-classifiable, non-retryable error on Google's real INVALID_ARGUMENT (400) shape, without retrying", async () => {
    fetchMock.mockResolvedValueOnce(INVALID_ARGUMENT_RESPONSE);

    await expect(autocompleteDestination(API_KEY, "", 5)).rejects.toThrow(/rejected the request as invalid/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws GoogleApiRequestError on a 400", async () => {
    fetchMock.mockResolvedValueOnce(INVALID_ARGUMENT_RESPONSE);

    await expect(autocompleteDestination(API_KEY, "", 5)).rejects.toBeInstanceOf(GoogleApiRequestError);
  });

  it("throws on an unexpected (non-object) response shape rather than silently returning garbage", async () => {
    // A plain Error (not GoogleApiRequestError), so the retry loop's
    // "unrecognized failure defaults to retryable" rule applies -- both
    // attempts (this module's 2-attempt budget) get the same bad shape,
    // so this needs fake timers, same as the retry-path tests below, even
    // though it isn't really testing retry behavior itself.
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(["not", "an", "object"]));

    const assertion = expect(autocompleteDestination(API_KEY, "pike pl", 5)).rejects.toThrow(/unexpected Google Places response shape/);
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
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
        .mockResolvedValueOnce(jsonResponse({ error: { code: 429, message: "rate limited", status: "RESOURCE_EXHAUSTED" } }, { ok: false, status: 429, statusText: "Too Many Requests" }))
        .mockResolvedValueOnce(jsonResponse({ suggestions: [makePlacePrediction()] }));

      const resultPromise = autocompleteDestination(API_KEY, "pike pl", 5);
      await vi.runAllTimersAsync();
      const results = await resultPromise;

      expect(results).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("exhausts its 2-attempt budget on a sustained 429 and throws (not geocodeAddress.ts's 4)", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: { code: 429, message: "rate limited", status: "RESOURCE_EXHAUSTED" } }, { ok: false, status: 429, statusText: "Too Many Requests" }));

      const assertion = expect(autocompleteDestination(API_KEY, "pike pl", 5)).rejects.toThrow(/429/);
      await vi.runAllTimersAsync();
      await assertion;

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not retry a non-retryable error (e.g. a bad API key, real 400 shape), failing immediately", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: 400,
              message: "API key not valid. Please pass a valid API key.",
              status: "INVALID_ARGUMENT",
              details: [{ reason: "API_KEY_INVALID" }],
            },
          },
          { ok: false, status: 400, statusText: "Bad Request" },
        ),
      );

      await expect(autocompleteDestination(API_KEY, "pike pl", 5)).rejects.toThrow(/rejected the request as invalid/);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
