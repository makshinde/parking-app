import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleDestinationAutocompleteRequest, type HandleDestinationAutocompleteRequestDeps } from "./handleDestinationAutocompleteRequest.ts";

const API_KEY = "test-google-places-key";

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number; statusText?: string }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "OK",
    json: () => Promise.resolve(body),
  } as Response;
}

function makePlacePrediction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    placePrediction: {
      placeId: "ChIJy9ZRwbJqkFQRHJ8-Y18dRGA",
      text: { text: "Pike Place Market, Seattle, WA, USA" },
      structuredFormat: {
        mainText: { text: "Pike Place Market" },
        secondaryText: { text: "Seattle, WA, USA" },
      },
      ...overrides,
    },
  };
}

// Live-verified real shape: Google returns HTTP 200 with body `{}` for a
// genuine no-match.
const NO_MATCH_RESPONSE = jsonResponse({});

function makeDeps(): HandleDestinationAutocompleteRequestDeps {
  return { googlePlacesApiKey: API_KEY };
}

describe("handleDestinationAutocompleteRequest", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("request validation (malformed_body)", () => {
    it("rejects malformed JSON", async () => {
      const result = await handleDestinationAutocompleteRequest(makeDeps(), "{not json");
      expect(result.status).toBe(400);
      expect(result.response).toMatchObject({ status: "invalid_request", reason: "malformed_body" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a non-object body", async () => {
      const result = await handleDestinationAutocompleteRequest(makeDeps(), JSON.stringify("just a string"));
      expect(result.response).toMatchObject({ status: "invalid_request", reason: "malformed_body" });
    });

    it("rejects a missing query", async () => {
      const result = await handleDestinationAutocompleteRequest(makeDeps(), JSON.stringify({}));
      expect(result.response).toMatchObject({ status: "invalid_request", reason: "malformed_body" });
    });

    it("rejects a non-string query", async () => {
      const result = await handleDestinationAutocompleteRequest(makeDeps(), JSON.stringify({ query: 12345 }));
      expect(result.response).toMatchObject({ status: "invalid_request", reason: "malformed_body" });
    });
  });

  describe("request validation (query_too_short)", () => {
    it.each(["", " ", "p", " p "])("rejects a too-short query (%j after trimming)", async (query) => {
      const result = await handleDestinationAutocompleteRequest(makeDeps(), JSON.stringify({ query }));
      expect(result.status).toBe(400);
      expect(result.response).toMatchObject({ status: "invalid_request", reason: "query_too_short" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("accepts a 2-character query (the real minimum)", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ suggestions: [makePlacePrediction()] }));
      const result = await handleDestinationAutocompleteRequest(makeDeps(), JSON.stringify({ query: "pi" }));
      expect(result.response.status).toBe("ok");
    });

    it("trims the query before both validating length and calling Google", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ suggestions: [makePlacePrediction()] }));
      await handleDestinationAutocompleteRequest(makeDeps(), JSON.stringify({ query: "  pike pl  " }));
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.input).toBe("pike pl");
    });
  });

  describe("request validation (invalid_limit)", () => {
    it.each([0, -1, 1.5, 11])("rejects an invalid limit (%s)", async (limit) => {
      const result = await handleDestinationAutocompleteRequest(makeDeps(), JSON.stringify({ query: "pike pl", limit }));
      expect(result.response).toMatchObject({ status: "invalid_request", reason: "invalid_limit" });
    });

    it("defaults limit to 5 when omitted, applied by slicing (Google has no server-side limit param)", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          suggestions: [
            makePlacePrediction({ placeId: "a" }),
            makePlacePrediction({ placeId: "b" }),
            makePlacePrediction({ placeId: "c" }),
            makePlacePrediction({ placeId: "d" }),
            makePlacePrediction({ placeId: "e" }),
            makePlacePrediction({ placeId: "f" }),
          ],
        }),
      );
      const result = await handleDestinationAutocompleteRequest(makeDeps(), JSON.stringify({ query: "pike pl" }));
      expect(result.response.status).toBe("ok");
      if (result.response.status === "ok") {
        expect(result.response.results).toHaveLength(5);
      }
    });

    it("accepts limit: 10 (the real maximum)", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ suggestions: [makePlacePrediction()] }));
      const result = await handleDestinationAutocompleteRequest(makeDeps(), JSON.stringify({ query: "pike pl", limit: 10 }));
      expect(result.response.status).toBe("ok");
    });
  });

  describe("success path", () => {
    it("returns ok with results reshaped to the wire format, kind: general_place, no lat/lon", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ suggestions: [makePlacePrediction()] }));

      const result = await handleDestinationAutocompleteRequest(makeDeps(), JSON.stringify({ query: "pike pl" }));

      expect(result.status).toBe(200);
      expect(result.response).toEqual({
        status: "ok",
        results: [
          {
            kind: "general_place",
            placeId: "ChIJy9ZRwbJqkFQRHJ8-Y18dRGA",
            displayText: "Pike Place Market",
            displayAddress: "Seattle, WA, USA",
          },
        ],
      });
    });

    it("returns ok with an empty results list on a genuine no-match, not an error", async () => {
      fetchMock.mockResolvedValueOnce(NO_MATCH_RESPONSE);

      const result = await handleDestinationAutocompleteRequest(makeDeps(), JSON.stringify({ query: "zzzznonexistent" }));

      expect(result.status).toBe(200);
      expect(result.response).toEqual({ status: "ok", results: [] });
    });
  });

  describe("upstream failures", () => {
    it("returns geocoding_service_unavailable (502) when Google's retries are exhausted", async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValue(
        jsonResponse({ error: { code: 429, message: "rate limited", status: "RESOURCE_EXHAUSTED" } }, { ok: false, status: 429, statusText: "Too Many Requests" }),
      );

      const resultPromise = handleDestinationAutocompleteRequest(makeDeps(), JSON.stringify({ query: "pike pl" }));
      await vi.runAllTimersAsync();
      const result = await resultPromise;
      vi.useRealTimers();

      expect(result.status).toBe(502);
      expect(result.response).toMatchObject({ status: "geocoding_service_unavailable" });
      expect(JSON.stringify(result.response)).not.toMatch(/429|RESOURCE_EXHAUSTED/);
    });

    it("returns geocoding_service_unavailable (502) on a non-retryable failure (5xx exhausted differently is retryable -- use a real 403 instead)", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 403, statusText: "Forbidden" }));

      const result = await handleDestinationAutocompleteRequest(makeDeps(), JSON.stringify({ query: "pike pl" }));

      expect(result.status).toBe(502);
      expect(result.response).toMatchObject({ status: "geocoding_service_unavailable" });
    });

    it("returns internal_error (500), not geocoding_service_unavailable, if Google ever rejects a request that passed our own query_too_short validation (real 400 shape)", async () => {
      // Should be unreachable in practice (that's the whole point of this
      // handler's own 2-character minimum) -- but if it ever happens, it
      // signals a gap in OUR validation (or a misconfigured API key), not
      // Google's fault.
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 400, message: "input must be non-empty.\n", status: "INVALID_ARGUMENT" } },
          { ok: false, status: 400, statusText: "Bad Request" },
        ),
      );

      const result = await handleDestinationAutocompleteRequest(makeDeps(), JSON.stringify({ query: "pike pl" }));

      expect(result.status).toBe(500);
      expect(result.response).toMatchObject({ status: "internal_error" });
    });

    it("returns geocoding_service_unavailable (502) on an unexpected (non-object) response shape", async () => {
      // A plain Error (not GoogleApiRequestError) defaults to retryable in
      // autocompleteDestination.ts's own retry loop, so both attempts of
      // its 2-attempt budget need a mocked response -- same reasoning as
      // that module's own equivalent test.
      vi.useFakeTimers();
      fetchMock.mockResolvedValue(jsonResponse(["not", "an", "object"]));

      const resultPromise = handleDestinationAutocompleteRequest(makeDeps(), JSON.stringify({ query: "pike pl" }));
      await vi.runAllTimersAsync();
      const result = await resultPromise;
      vi.useRealTimers();

      expect(result.status).toBe(502);
      expect(result.response).toMatchObject({ status: "geocoding_service_unavailable" });
    });
  });
});
