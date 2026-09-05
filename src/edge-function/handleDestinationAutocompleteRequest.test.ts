import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleDestinationAutocompleteRequest, type HandleDestinationAutocompleteRequestDeps } from "./handleDestinationAutocompleteRequest";

const API_KEY = "test-locationiq-key";

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number; statusText?: string }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "OK",
    json: () => Promise.resolve(body),
  } as Response;
}

function makeAutocompleteResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    place_id: "323319931923",
    lat: "47.60939675",
    lon: "-122.34141018",
    display_name: "Pike Place Market, 2nd Avenue Cycletrack, Central Business District, Belltown, Seattle, King County, Washington, 98101, USA",
    display_place: "Pike Place Market",
    display_address: "2nd Avenue Cycletrack, Central Business District, Belltown, Seattle, King County, Washington, 98101, USA",
    ...overrides,
  };
}

const NO_MATCH_RESPONSE = jsonResponse({ error: "Unable to geocode" }, { ok: false, status: 404, statusText: "Not Found" });

function makeDeps(): HandleDestinationAutocompleteRequestDeps {
  return { locationIqApiKey: API_KEY };
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
      fetchMock.mockResolvedValueOnce(jsonResponse([makeAutocompleteResult()]));
      const result = await handleDestinationAutocompleteRequest(makeDeps(), JSON.stringify({ query: "pi" }));
      expect(result.response.status).toBe("ok");
    });

    it("trims the query before both validating length and calling LocationIQ", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([makeAutocompleteResult()]));
      await handleDestinationAutocompleteRequest(makeDeps(), JSON.stringify({ query: "  pike pl  " }));
      const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
      expect(requestedUrl.searchParams.get("q")).toBe("pike pl");
    });
  });

  describe("request validation (invalid_limit)", () => {
    it.each([0, -1, 1.5, 11])("rejects an invalid limit (%s)", async (limit) => {
      const result = await handleDestinationAutocompleteRequest(makeDeps(), JSON.stringify({ query: "pike pl", limit }));
      expect(result.response).toMatchObject({ status: "invalid_request", reason: "invalid_limit" });
    });

    it("defaults limit to 5 when omitted", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([makeAutocompleteResult()]));
      await handleDestinationAutocompleteRequest(makeDeps(), JSON.stringify({ query: "pike pl" }));
      const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
      expect(requestedUrl.searchParams.get("limit")).toBe("5");
    });

    it("accepts limit: 10 (the real maximum)", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([makeAutocompleteResult()]));
      const result = await handleDestinationAutocompleteRequest(makeDeps(), JSON.stringify({ query: "pike pl", limit: 10 }));
      expect(result.response.status).toBe("ok");
    });
  });

  describe("success path", () => {
    it("returns ok with results reshaped to the wire format, kind: general_place", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([makeAutocompleteResult()]));

      const result = await handleDestinationAutocompleteRequest(makeDeps(), JSON.stringify({ query: "pike pl" }));

      expect(result.status).toBe(200);
      expect(result.response).toEqual({
        status: "ok",
        results: [
          {
            kind: "general_place",
            placeId: "323319931923",
            displayText: "Pike Place Market",
            displayAddress: "2nd Avenue Cycletrack, Central Business District, Belltown, Seattle, King County, Washington, 98101, USA",
            lat: 47.60939675,
            lon: -122.34141018,
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
    it("returns geocoding_service_unavailable (502) when LocationIQ's retries are exhausted", async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValue(jsonResponse({ error: "Rate Limited Second" }, { ok: false, status: 429, statusText: "Too Many Requests" }));

      const resultPromise = handleDestinationAutocompleteRequest(makeDeps(), JSON.stringify({ query: "pike pl" }));
      await vi.runAllTimersAsync();
      const result = await resultPromise;
      vi.useRealTimers();

      expect(result.status).toBe(502);
      expect(result.response).toMatchObject({ status: "geocoding_service_unavailable" });
      expect(JSON.stringify(result.response)).not.toMatch(/429|Rate Limited/);
    });

    it("returns geocoding_service_unavailable (502) on a non-retryable failure (bad API key)", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Invalid key" }, { ok: false, status: 401, statusText: "Unauthorized" }));

      const result = await handleDestinationAutocompleteRequest(makeDeps(), JSON.stringify({ query: "pike pl" }));

      expect(result.status).toBe(502);
      expect(result.response).toMatchObject({ status: "geocoding_service_unavailable" });
    });

    it("returns internal_error (500), not geocoding_service_unavailable, if LocationIQ ever rejects a request that passed our own query_too_short validation", async () => {
      // Should be unreachable in practice (that's the whole point of this
      // handler's own 2-character minimum) -- but if it ever happens, it
      // signals a gap in OUR validation, not LocationIQ's fault.
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Invalid Request" }, { ok: false, status: 400, statusText: "Bad Request" }));

      const result = await handleDestinationAutocompleteRequest(makeDeps(), JSON.stringify({ query: "pike pl" }));

      expect(result.status).toBe(500);
      expect(result.response).toMatchObject({ status: "internal_error" });
    });

    it("returns geocoding_service_unavailable (502) on a structurally-invalid coordinate in LocationIQ's response", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([makeAutocompleteResult({ lat: "not-a-number" })]));

      const result = await handleDestinationAutocompleteRequest(makeDeps(), JSON.stringify({ query: "pike pl" }));

      expect(result.status).toBe(502);
      expect(result.response).toMatchObject({ status: "geocoding_service_unavailable" });
    });
  });
});
