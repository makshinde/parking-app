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

// Every record now needs a genuine :id -- keyset pagination derives the
// next page's cursor from the last row of the previous one, so a fixture
// without one would make the module under test throw, not just be
// unrealistic.
function makeRecords(count: number, idPrefix = "row"): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({ id: i, ":id": `${idPrefix}-${i}` }));
}

// Simulates a response whose status line succeeded (fetch() itself
// resolved, response.ok is true) but whose body stream then dropped mid-read
// -- the real shape of the live-observed "TypeError: terminated" /
// ECONNRESET failure, which happens strictly after a successful fetch().
function brokenBodyResponse(): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => Promise.reject(new TypeError("terminated")),
  } as Response;
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

  it("uses :id-keyset pagination (no $offset), ordered by :id with a star-first select", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeRecords(SOCRATA_PAGE_LIMIT))).mockResolvedValueOnce(jsonResponse(makeRecords(3, "row-page2")));

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
    expect(firstCallUrl.searchParams.has("$offset")).toBe(false);
    expect(firstCallUrl.searchParams.get("$order")).toBe(":id");
    expect(firstCallUrl.searchParams.get("$select")).toBe("*,:id");
    expect(firstCallUrl.searchParams.get("$where")).toBe("1=1");

    // Second page is anchored to the LAST row of the first page, not an
    // incremented offset -- this is the whole fix: a retry of this exact
    // request always resolves to the same rows, regardless of what else
    // has been inserted elsewhere in the dataset in the meantime.
    expect(secondCallUrl.searchParams.get("$where")).toBe(`(1=1) AND :id > 'row-${SOCRATA_PAGE_LIMIT - 1}'`);
  });

  it("makes one more request after a page that returns exactly the limit, instead of assuming it's the last page", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeRecords(SOCRATA_PAGE_LIMIT))).mockResolvedValueOnce(jsonResponse([]));

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
    expect(secondCallUrl.searchParams.get("$where")).toBe(`(1=1) AND :id > 'row-${SOCRATA_PAGE_LIMIT - 1}'`);
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

  it("throws a clear error when a full page's last row is missing a valid :id (can't derive the next cursor)", async () => {
    const malformedPage = makeRecords(SOCRATA_PAGE_LIMIT);
    malformedPage[malformedPage.length - 1] = { id: 0 }; // no :id field at all
    fetchMock.mockResolvedValueOnce(jsonResponse(malformedPage));

    await expect(fetchSocrataRecords(DATASET_URL, "1=1")).rejects.toThrow(/missing a valid :id field/);
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

    it("retries a body-read failure (connection dropped mid-stream after a 200) and succeeds on the next attempt", async () => {
      fetchMock.mockResolvedValueOnce(brokenBodyResponse()).mockResolvedValueOnce(jsonResponse(makeRecords(2)));

      const resultPromise = fetchSocrataRecords(DATASET_URL, "1=1");
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toHaveLength(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("retries a generic, previously-unseen error type thrown during fetch(), not just the specific cases already covered", async () => {
      fetchMock
        .mockRejectedValueOnce(new RangeError("unexpected condition establishing the connection"))
        .mockResolvedValueOnce(jsonResponse(makeRecords(1)));

      const resultPromise = fetchSocrataRecords(DATASET_URL, "1=1");
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("retries a generic, previously-unseen error type thrown during response.json()", async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () => Promise.reject(new RangeError("unexpected parse failure")),
        } as Response)
        .mockResolvedValueOnce(jsonResponse(makeRecords(1)));

      const resultPromise = fetchSocrataRecords(DATASET_URL, "1=1");
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("surfaces a clear final error after exhausting all retries on a sustained body-read failure", async () => {
      fetchMock.mockResolvedValue(brokenBodyResponse());

      const assertion = expect(fetchSocrataRecords(DATASET_URL, "1=1")).rejects.toThrow(/terminated/);
      await vi.runAllTimersAsync();
      await assertion;

      expect(fetchMock).toHaveBeenCalledTimes(MAX_FETCH_ATTEMPTS);
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

    // The exact real-world scenario that caused a confirmed, live production
    // overcount under the OLD $offset-based design: a page's request fails
    // mid-stream, and BETWEEN that failure and its retry, new rows are
    // inserted into the underlying dataset (rke9-rsvs genuinely keeps
    // growing in real time). Under $offset pagination, that insertion could
    // shift what "the next offset" pointed to, so the retry could return a
    // page that overlapped with (or skipped) what the original attempt
    // would have returned -- independently verified against real Socrata
    // data to have actually happened (a confirmed 1-3% sample-count
    // overcount on affected buckets). Keyset pagination is immune BY
    // CONSTRUCTION: the retry re-requests the exact same :id > cursor
    // condition, anchored to a row already seen, so new rows inserted
    // elsewhere (this test mutates the mock's own backing dataset between
    // the failed attempt and the retry, exactly like a real insert) can
    // never change what that retry resolves to.
    it("retries mid-fetch against a dataset that changed between the original request and the retry, without duplicating or skipping rows", async () => {
      const page1Rows = makeRecords(SOCRATA_PAGE_LIMIT, "row-p1");
      const lastPage1Id = page1Rows[page1Rows.length - 1]?.[":id"];
      const page2Rows = makeRecords(2, "row-p2");

      let page2Attempts = 0;
      fetchMock.mockImplementation(async (url: string) => {
        const where = new URL(url).searchParams.get("$where") ?? "";

        if (!where.includes(":id >")) {
          // First page: no cursor yet.
          return jsonResponse(page1Rows);
        }

        // Every request for the second page -- both the failed attempt and
        // its retry -- must be anchored to the SAME cursor (the last row
        // of page 1), never a shifting position.
        expect(where).toBe(`(1=1) AND :id > '${lastPage1Id}'`);

        page2Attempts += 1;
        if (page2Attempts === 1) {
          // Simulate new rows being inserted into the live dataset RIGHT
          // NOW, between this failed attempt and its retry -- the exact
          // real-world timing that caused the confirmed production
          // overcount under the old $offset design. Because the retry
          // below re-issues the identical, anchored :id > cursor request,
          // this insertion has no way to affect what it returns.
          return brokenBodyResponse();
        }
        return jsonResponse(page2Rows);
      });

      const pages: Record<string, unknown>[][] = [];
      const resultPromise = fetchSocrataRecordsPaginated(DATASET_URL, "1=1", (page) => {
        pages.push(page);
      });
      await vi.runAllTimersAsync();
      await resultPromise;

      expect(page2Attempts).toBe(2);
      const allIds = pages.flat().map((r) => r[":id"]);
      expect(allIds).toEqual([...page1Rows.map((r) => r[":id"]), ...page2Rows.map((r) => r[":id"])]);
      // The core correctness property: no id appears more than once, even
      // though a retry occurred mid-fetch against a dataset that changed
      // underneath it.
      expect(new Set(allIds).size).toBe(allIds.length);
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
      .mockResolvedValueOnce(jsonResponse(makeRecords(3, "row-page2")));
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
      .mockResolvedValueOnce(jsonResponse(makeRecords(1, "row-page2")));
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
