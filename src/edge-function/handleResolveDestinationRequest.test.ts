import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleResolveDestinationRequest, type HandleResolveDestinationRequestDeps } from "./handleResolveDestinationRequest.ts";

const API_KEY = "test-google-places-key";
const PLACE_ID = "ChIJkaHOMclqkFQRSMxIEFOHp_k";

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number; statusText?: string }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "OK",
    json: () => Promise.resolve(body),
  } as Response;
}

function makeOkResponse(): Response {
  return jsonResponse({
    status: "OK",
    results: [
      {
        formatted_address: "Pigott Building, 12th Avenue, Seattle, WA, USA",
        geometry: { location: { lat: 47.6106993, lng: -122.3186791 } },
      },
    ],
  });
}

function makeDeps(): HandleResolveDestinationRequestDeps {
  return { googlePlacesApiKey: API_KEY };
}

describe("handleResolveDestinationRequest", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("request validation", () => {
    it("rejects malformed JSON", async () => {
      const result = await handleResolveDestinationRequest(makeDeps(), "{not json");
      expect(result.status).toBe(400);
      expect(result.response).toMatchObject({ status: "invalid_request", reason: "malformed_body" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a non-object body", async () => {
      const result = await handleResolveDestinationRequest(makeDeps(), JSON.stringify("just a string"));
      expect(result.response).toMatchObject({ status: "invalid_request", reason: "malformed_body" });
    });

    it("rejects a missing placeId", async () => {
      const result = await handleResolveDestinationRequest(makeDeps(), JSON.stringify({}));
      expect(result.response).toMatchObject({ status: "invalid_request", reason: "malformed_body" });
    });

    it("rejects a non-string placeId", async () => {
      const result = await handleResolveDestinationRequest(makeDeps(), JSON.stringify({ placeId: 12345 }));
      expect(result.response).toMatchObject({ status: "invalid_request", reason: "malformed_body" });
    });

    it("rejects an empty/whitespace-only placeId", async () => {
      const result = await handleResolveDestinationRequest(makeDeps(), JSON.stringify({ placeId: "   " }));
      expect(result.response).toMatchObject({ status: "invalid_request", reason: "malformed_body" });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("success path", () => {
    it("returns ok with the real resolved address/coordinates", async () => {
      fetchMock.mockResolvedValueOnce(makeOkResponse());

      const result = await handleResolveDestinationRequest(makeDeps(), JSON.stringify({ placeId: PLACE_ID }));

      expect(result.status).toBe(200);
      expect(result.response).toEqual({
        status: "ok",
        resolvedAddress: {
          displayName: "Pigott Building, 12th Avenue, Seattle, WA, USA",
          lat: 47.6106993,
          lon: -122.3186791,
        },
      });
    });

    it("sends the exact placeId through to the Geocoding request", async () => {
      fetchMock.mockResolvedValueOnce(makeOkResponse());

      await handleResolveDestinationRequest(makeDeps(), JSON.stringify({ placeId: PLACE_ID }));

      const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
      expect(requestedUrl.searchParams.get("place_id")).toBe(PLACE_ID);
    });
  });

  describe("no-match path", () => {
    it("returns no_match (200) on a genuine ZERO_RESULTS, not an error", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ status: "ZERO_RESULTS", results: [] }));

      const result = await handleResolveDestinationRequest(makeDeps(), JSON.stringify({ placeId: PLACE_ID }));

      expect(result.status).toBe(200);
      expect(result.response).toMatchObject({ status: "no_match" });
    });
  });

  describe("upstream failures", () => {
    it("returns geocoding_service_unavailable (502) on the real, live-verified REQUEST_DENIED shape", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          error_message: "This API key is not authorized to use this service or API.",
          results: [],
          status: "REQUEST_DENIED",
        }),
      );

      const result = await handleResolveDestinationRequest(makeDeps(), JSON.stringify({ placeId: PLACE_ID }));

      expect(result.status).toBe(502);
      expect(result.response).toMatchObject({ status: "geocoding_service_unavailable" });
      expect(JSON.stringify(result.response)).not.toMatch(/not authorized/);
    });

    it("returns geocoding_service_unavailable (502) when retries are exhausted on a sustained OVER_QUERY_LIMIT", async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValue(jsonResponse({ status: "OVER_QUERY_LIMIT", results: [] }));

      const resultPromise = handleResolveDestinationRequest(makeDeps(), JSON.stringify({ placeId: PLACE_ID }));
      await vi.runAllTimersAsync();
      const result = await resultPromise;
      vi.useRealTimers();

      expect(result.status).toBe(502);
      expect(result.response).toMatchObject({ status: "geocoding_service_unavailable" });
    });

    it("returns internal_error (500), not geocoding_service_unavailable, if Google ever rejects a request that passed our own validation (real, live-verified INVALID_REQUEST shape, HTTP 400)", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          { error_message: "Invalid request. Invalid 'place_id' parameter.", results: [], status: "INVALID_REQUEST" },
          { ok: false, status: 400, statusText: "Bad Request" },
        ),
      );

      const result = await handleResolveDestinationRequest(makeDeps(), JSON.stringify({ placeId: PLACE_ID }));

      expect(result.status).toBe(500);
      expect(result.response).toMatchObject({ status: "internal_error" });
    });

    it("returns geocoding_service_unavailable (502) on a structurally-invalid coordinate", async () => {
      // A plain RangeError defaults to retryable in resolveDestinationCoordinates.ts's
      // own retry loop (same established behavior as the LocationIQ-backed
      // modules' equivalent case), so all 4 attempts need a mocked response.
      vi.useFakeTimers();
      fetchMock.mockResolvedValue(
        jsonResponse({
          status: "OK",
          results: [{ formatted_address: "Somewhere", geometry: { location: { lat: Number.NaN, lng: -122.3 } } }],
        }),
      );

      const resultPromise = handleResolveDestinationRequest(makeDeps(), JSON.stringify({ placeId: PLACE_ID }));
      await vi.runAllTimersAsync();
      const result = await resultPromise;
      vi.useRealTimers();

      expect(result.status).toBe(502);
      expect(result.response).toMatchObject({ status: "geocoding_service_unavailable" });
    });
  });
});
