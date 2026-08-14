import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchArcGisFeatures } from "./fetchArcGisFeatures";

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number; statusText?: string }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "OK",
    json: () => Promise.resolve(body),
  } as Response;
}

const FEATURE_SERVER_URL = "https://example.com/arcgis/rest/services/Test/FeatureServer";

describe("fetchArcGisFeatures", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns all features from a single page when pagination isn't needed", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        features: [{ attributes: { OBJECTID: 1 } }, { attributes: { OBJECTID: 2 } }],
        exceededTransferLimit: false,
      }),
    );

    const result = await fetchArcGisFeatures(FEATURE_SERVER_URL, 0, "1=1", "*");

    expect(result).toEqual([{ attributes: { OBJECTID: 1 } }, { attributes: { OBJECTID: 2 } }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows pagination and combines features across pages", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          features: [{ attributes: { OBJECTID: 1 } }, { attributes: { OBJECTID: 2 } }],
          exceededTransferLimit: true,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          features: [{ attributes: { OBJECTID: 3 } }],
          exceededTransferLimit: false,
        }),
      );

    const result = await fetchArcGisFeatures(FEATURE_SERVER_URL, 0, "1=1", "*");

    expect(result).toEqual([
      { attributes: { OBJECTID: 1 } },
      { attributes: { OBJECTID: 2 } },
      { attributes: { OBJECTID: 3 } },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Second page's resultOffset must reflect the first page's feature
    // count, not just increment by a fixed page size, or a real server
    // could return duplicate or skipped records.
    const secondCall = fetchMock.mock.calls[1];
    if (!secondCall) {
      throw new Error("expected fetch to have been called a second time");
    }
    const secondCallUrl = new URL(secondCall[0] as string);
    expect(secondCallUrl.searchParams.get("resultOffset")).toBe("2");
  });

  it("throws rather than returning partial data on a non-200 response", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          { features: [{ attributes: { OBJECTID: 1 } }], exceededTransferLimit: true },
          { ok: false, status: 500, statusText: "Internal Server Error" },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ features: [], exceededTransferLimit: false }));

    await expect(fetchArcGisFeatures(FEATURE_SERVER_URL, 0, "1=1", "*")).rejects.toThrow(/500/);
    // Only the failing first page was attempted -- no silent fallback to a
    // second request pretending the first page succeeded.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws rather than swallowing a network failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(fetchArcGisFeatures(FEATURE_SERVER_URL, 0, "1=1", "*")).rejects.toThrow("fetch failed");
  });

  it("throws a RangeError for a negative layerId", () => {
    expect(fetchArcGisFeatures(FEATURE_SERVER_URL, -1, "1=1", "*")).rejects.toThrow(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a RangeError for a non-integer layerId", () => {
    expect(fetchArcGisFeatures(FEATURE_SERVER_URL, 1.5, "1=1", "*")).rejects.toThrow(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns an empty array when the layer has no matching features", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ features: [], exceededTransferLimit: false }));

    const result = await fetchArcGisFeatures(FEATURE_SERVER_URL, 0, "1=0", "*");

    expect(result).toEqual([]);
  });
});
