import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSocrataRecords, SOCRATA_PAGE_LIMIT } from "./fetchSocrataRecords";

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number; statusText?: string }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "OK",
    json: () => Promise.resolve(body),
  } as Response;
}

function makeRecords(count: number): Record<string, number>[] {
  return Array.from({ length: count }, (_, i) => ({ id: i }));
}

const DATASET_URL = "https://data.seattle.gov/resource/rke9-rsvs.json";

describe("fetchSocrataRecords", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns all records from a single page when pagination isn't needed", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeRecords(3)));

    const result = await fetchSocrataRecords(DATASET_URL, "sourceelementkey='1029'");

    expect(result).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows pagination and combines records across pages", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(makeRecords(SOCRATA_PAGE_LIMIT)))
      .mockResolvedValueOnce(jsonResponse(makeRecords(3)));

    const result = await fetchSocrataRecords(DATASET_URL, "1=1");

    expect(result).toHaveLength(SOCRATA_PAGE_LIMIT + 3);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstCall = fetchMock.mock.calls[0];
    const secondCall = fetchMock.mock.calls[1];
    if (!firstCall || !secondCall) {
      throw new Error("expected fetch to have been called twice");
    }

    const firstCallUrl = new URL(firstCall[0] as string);
    const secondCallUrl = new URL(secondCall[0] as string);
    expect(firstCallUrl.searchParams.get("$offset")).toBe("0");
    // $offset must increment by the limit, not by the page's actual row
    // count, since Socrata paginates strictly by requested limit.
    expect(secondCallUrl.searchParams.get("$offset")).toBe(String(SOCRATA_PAGE_LIMIT));
  });

  it("makes one more request after a page that returns exactly the limit, instead of assuming it's the last page", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(makeRecords(SOCRATA_PAGE_LIMIT)))
      .mockResolvedValueOnce(jsonResponse([]));

    const result = await fetchSocrataRecords(DATASET_URL, "1=1");

    // The exact-limit-sized page's rows are all included, and the extra
    // request to confirm there's nothing after it doesn't add duplicates.
    expect(result).toHaveLength(SOCRATA_PAGE_LIMIT);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const secondCall = fetchMock.mock.calls[1];
    if (!secondCall) {
      throw new Error("expected fetch to have been called a second time");
    }
    const secondCallUrl = new URL(secondCall[0] as string);
    expect(secondCallUrl.searchParams.get("$offset")).toBe(String(SOCRATA_PAGE_LIMIT));
  });

  it("throws rather than returning partial data on a non-200 response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(makeRecords(SOCRATA_PAGE_LIMIT), { ok: false, status: 500, statusText: "Internal Server Error" }),
    );

    await expect(fetchSocrataRecords(DATASET_URL, "1=1")).rejects.toThrow(/500/);
    // Only the failing first page was attempted -- no silent fallback to a
    // second request pretending the first page succeeded.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws rather than swallowing a network failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(fetchSocrataRecords(DATASET_URL, "1=1")).rejects.toThrow("fetch failed");
  });

  it("returns an empty array when no records match", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));

    const result = await fetchSocrataRecords(DATASET_URL, "1=0");

    expect(result).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
