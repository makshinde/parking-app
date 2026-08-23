import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSocrataRecords, fetchSocrataRecordsPaginated, MAX_FETCH_ATTEMPTS, SOCRATA_PAGE_LIMIT } from "./fetchSocrataRecords";

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

  it("throws rather than returning partial data on a non-200, non-retryable response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(makeRecords(SOCRATA_PAGE_LIMIT), { ok: false, status: 404, statusText: "Not Found" }),
    );

    await expect(fetchSocrataRecords(DATASET_URL, "1=1")).rejects.toThrow(/404/);
    // Only the failing first page was attempted -- no silent fallback to a
    // second request pretending the first page succeeded, and no retry
    // either, since a 4xx will fail identically every time.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns an empty array when no records match", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));

    const result = await fetchSocrataRecords(DATASET_URL, "1=0");

    expect(result).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe("SOCRATA_APP_TOKEN", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("sends the X-App-Token header when SOCRATA_APP_TOKEN is set", async () => {
      vi.stubEnv("SOCRATA_APP_TOKEN", "test-token-123");
      fetchMock.mockResolvedValueOnce(jsonResponse(makeRecords(1)));

      await fetchSocrataRecords(DATASET_URL, "1=1");

      const call = fetchMock.mock.calls[0];
      if (!call) {
        throw new Error("expected fetch to have been called");
      }
      const [, init] = call as [string, RequestInit];
      expect(init.headers).toEqual({ "X-App-Token": "test-token-123" });
    });

    it("still succeeds without a token, sending no X-App-Token header (just at Socrata's lower shared rate limit)", async () => {
      vi.stubEnv("SOCRATA_APP_TOKEN", "");
      fetchMock.mockResolvedValueOnce(jsonResponse(makeRecords(2)));

      const result = await fetchSocrataRecords(DATASET_URL, "1=1");

      expect(result).toHaveLength(2);
      const call = fetchMock.mock.calls[0];
      if (!call) {
        throw new Error("expected fetch to have been called");
      }
      const [, init] = call as [string, RequestInit];
      expect(init.headers).toEqual({});
    });
  });

  describe("retry-with-backoff on transient failures", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("retries a transient 502 and succeeds once the next attempt goes through", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse([], { ok: false, status: 502, statusText: "Bad Gateway" }))
        .mockResolvedValueOnce(jsonResponse(makeRecords(2)));

      const resultPromise = fetchSocrataRecords(DATASET_URL, "1=1");
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toHaveLength(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("retries a network failure (rejected fetch) and succeeds once the next attempt goes through", async () => {
      fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(jsonResponse(makeRecords(1)));

      const resultPromise = fetchSocrataRecords(DATASET_URL, "1=1");
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("surfaces a clear final error after exhausting all retries on a sustained 502 outage", async () => {
      fetchMock.mockResolvedValue(jsonResponse([], { ok: false, status: 502, statusText: "Bad Gateway" }));

      const assertion = expect(fetchSocrataRecords(DATASET_URL, "1=1")).rejects.toThrow(/502/);
      await vi.runAllTimersAsync();
      await assertion;

      // Initial attempt plus every retry, no more -- confirms the backoff
      // loop actually stops instead of retrying forever.
      expect(fetchMock).toHaveBeenCalledTimes(MAX_FETCH_ATTEMPTS);
    });

    it("does not retry a 4xx client error, since retrying it would never succeed", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([], { ok: false, status: 404, statusText: "Not Found" }));

      await expect(fetchSocrataRecords(DATASET_URL, "1=1")).rejects.toThrow(/404/);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("waits with increasing delay between retries rather than a fixed interval", async () => {
      fetchMock.mockResolvedValue(jsonResponse([], { ok: false, status: 503, statusText: "Service Unavailable" }));

      const assertion = expect(fetchSocrataRecords(DATASET_URL, "1=1")).rejects.toThrow(/503/);

      // Nothing retried yet immediately after the first failure.
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // First backoff (1s) elapses -> second attempt fires.
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // A second 1s wait alone should NOT be enough to trigger the third
      // attempt -- the delay after attempt 2 is 2s, not 1s.
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // The remaining 1s of the 2s backoff elapses -> third attempt fires.
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      await vi.runAllTimersAsync();
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(MAX_FETCH_ATTEMPTS);
    });
  });
});

describe("fetchSocrataRecordsPaginated", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hands a single page to onPage when pagination isn't needed", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeRecords(3)));
    const pages: unknown[][] = [];

    await fetchSocrataRecordsPaginated(DATASET_URL, "sourceelementkey='1029'", (page) => {
      pages.push(page);
    });

    expect(pages).toHaveLength(1);
    expect(pages[0]).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("calls onPage separately for each page, never combining them into one array", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(makeRecords(SOCRATA_PAGE_LIMIT)))
      .mockResolvedValueOnce(jsonResponse(makeRecords(3)));
    const pageSizes: number[] = [];

    await fetchSocrataRecordsPaginated(DATASET_URL, "1=1", (page) => {
      pageSizes.push(page.length);
    });

    expect(pageSizes).toEqual([SOCRATA_PAGE_LIMIT, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("awaits onPage before fetching the next page", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(makeRecords(SOCRATA_PAGE_LIMIT)))
      .mockResolvedValueOnce(jsonResponse(makeRecords(1)));
    const callOrder: string[] = [];

    await fetchSocrataRecordsPaginated(DATASET_URL, "1=1", async (page) => {
      callOrder.push(`onPage-start-${page.length}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      callOrder.push(`onPage-end-${page.length}`);
    });

    expect(callOrder).toEqual([
      `onPage-start-${SOCRATA_PAGE_LIMIT}`,
      `onPage-end-${SOCRATA_PAGE_LIMIT}`,
      "onPage-start-1",
      "onPage-end-1",
    ]);
  });

  it("makes one more request after a page that returns exactly the limit, instead of assuming it's the last page", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeRecords(SOCRATA_PAGE_LIMIT))).mockResolvedValueOnce(jsonResponse([]));
    const pages: unknown[][] = [];

    await fetchSocrataRecordsPaginated(DATASET_URL, "1=1", (page) => {
      pages.push(page);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pages).toHaveLength(2);
    expect(pages[1]).toHaveLength(0);
  });

  it("calls onPage once with an empty array when no records match", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const pages: unknown[][] = [];

    await fetchSocrataRecordsPaginated(DATASET_URL, "1=0", (page) => {
      pages.push(page);
    });

    expect(pages).toEqual([[]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws rather than continuing on a non-200, non-retryable response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(makeRecords(SOCRATA_PAGE_LIMIT), { ok: false, status: 404, statusText: "Not Found" }),
    );

    await expect(fetchSocrataRecordsPaginated(DATASET_URL, "1=1", () => {})).rejects.toThrow(/404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transient 502 mid-stream, same as fetchSocrataRecords", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse([], { ok: false, status: 502, statusText: "Bad Gateway" }))
      .mockResolvedValueOnce(jsonResponse(makeRecords(2)));
    const pages: unknown[][] = [];

    const donePromise = fetchSocrataRecordsPaginated(DATASET_URL, "1=1", (page) => {
      pages.push(page);
    });
    await vi.runAllTimersAsync();
    await donePromise;

    expect(pages).toEqual([makeRecords(2)]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("surfaces a clear final error after exhausting retries on a sustained network failure", async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    const assertion = expect(fetchSocrataRecordsPaginated(DATASET_URL, "1=1", () => {})).rejects.toThrow(
      "fetch failed",
    );
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(MAX_FETCH_ATTEMPTS);
    vi.useRealTimers();
  });
});
