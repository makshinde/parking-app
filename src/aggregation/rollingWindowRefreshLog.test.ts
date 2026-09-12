import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkAndRecordCoverage,
  detectCoverageGap,
  fetchCurrentCoverage,
  fetchLatestRefreshLogEntry,
  recordRefreshLogEntry,
  type RollingWindowCoverage,
  type RollingWindowRefreshLogSupabaseClient,
} from "./rollingWindowRefreshLog.ts";

// --- detectCoverageGap (pure, synthetic data) ------------------------------

function coverage(earliest: string, latest: string, rowCount = 1000): RollingWindowCoverage {
  return { earliestCovered: earliest, latestCovered: latest, rowCount };
}

describe("detectCoverageGap", () => {
  it("is never a gap on the first refresh (no previous entry)", () => {
    const result = detectCoverageGap(null, coverage("2026-07-31T11:05:00.000", "2026-09-01T21:59:00.000"));
    expect(result).toEqual({ gapDetected: false, gapDetail: null });
  });

  it("is NOT a gap when the new run's earliest is before the previous run's latest (windows overlap)", () => {
    const previous = coverage("2026-07-27T00:00:00.000", "2026-08-01T00:00:00.000");
    const current = coverage("2026-07-30T00:00:00.000", "2026-08-05T00:00:00.000");
    expect(detectCoverageGap(previous, current)).toEqual({ gapDetected: false, gapDetail: null });
  });

  it("is NOT a gap when the new run's earliest exactly equals the previous run's latest (windows touch)", () => {
    const previous = coverage("2026-07-27T00:00:00.000", "2026-08-01T00:00:00.000");
    const current = coverage("2026-08-01T00:00:00.000", "2026-08-05T00:00:00.000");
    expect(detectCoverageGap(previous, current)).toEqual({ gapDetected: false, gapDetail: null });
  });

  it("IS a gap when the new run's earliest is strictly after the previous run's latest", () => {
    const previous = coverage("2026-07-27T00:00:00.000", "2026-08-01T00:00:00.000");
    const current = coverage("2026-08-02T00:00:00.000", "2026-08-05T00:00:00.000");
    const result = detectCoverageGap(previous, current);
    expect(result.gapDetected).toBe(true);
    expect(result.gapDetail).toMatch(/2026-08-01T00:00:00\.000/);
    expect(result.gapDetail).toMatch(/2026-08-02T00:00:00\.000/);
  });

  it("catches a real, live-observed-shaped case: a several-day gap after a stalled refresh", () => {
    // Modeled directly on this project's own live investigation: an
    // earlier refresh's window ended (latest) well before a later
    // refresh's window begins (earliest), consistent with an eviction
    // that outran a missed or delayed refresh cycle.
    const previous = coverage("2026-07-20T00:00:00.000", "2026-07-25T00:00:00.000");
    const current = coverage("2026-07-29T00:00:00.000", "2026-08-30T00:00:00.000");
    expect(detectCoverageGap(previous, current).gapDetected).toBe(true);
  });
});

// --- fetchCurrentCoverage (real fetch shape, mocked) -----------------------

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number; statusText?: string }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "OK",
    json: () => Promise.resolve(body),
  } as Response;
}

describe("fetchCurrentCoverage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses a real, live-observed response shape (all re-reads agree)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([{ earliest: "2026-07-31T11:05:00.000", latest: "2026-09-01T21:59:00.000", row_count: "28111190" }]),
    );

    const result = await fetchCurrentCoverage("https://data.seattle.gov/resource/rke9-rsvs.json");

    expect(result).toEqual({
      earliestCovered: "2026-07-31T11:05:00.000",
      latestCovered: "2026-09-01T21:59:00.000",
      rowCount: 28111190,
    });
    // Takes several rapid re-reads, not just one -- see fetchCurrentCoverage's
    // own comment for why.
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("requests the correct min/max/count aggregate query on every re-read", async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ earliest: "a", latest: "b", row_count: "1" }]));

    await fetchCurrentCoverage("https://data.seattle.gov/resource/rke9-rsvs.json");

    for (const call of fetchMock.mock.calls) {
      const requestedUrl = new URL(call[0] as string);
      expect(requestedUrl.searchParams.get("$select")).toBe("min(occupancydatetime) as earliest, max(occupancydatetime) as latest, count(*) as row_count");
    }
  });

  it("takes the most-evicted (largest earliestCovered) reading across re-reads, keeping its fields together", async () => {
    // Modeled directly on the real, live-observed flip-flop between two
    // distinct answers found immediately before the first real rke9-rsvs
    // ingestion (see fetchCurrentCoverage's own comment) -- the
    // less-evicted reading (earlier earliest, higher row_count) must lose
    // to the more-evicted one (later earliest, lower row_count),
    // regardless of the order they arrive in.
    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ earliest: "2026-07-31T11:05:00.000", latest: "2026-09-01T21:59:00.000", row_count: "28111190" }]))
      .mockResolvedValueOnce(jsonResponse([{ earliest: "2026-07-31T12:03:00.000", latest: "2026-09-01T21:59:00.000", row_count: "28026190" }]))
      .mockResolvedValueOnce(jsonResponse([{ earliest: "2026-07-31T11:05:00.000", latest: "2026-09-01T21:59:00.000", row_count: "28111190" }]))
      .mockResolvedValueOnce(jsonResponse([{ earliest: "2026-07-31T12:03:00.000", latest: "2026-09-01T21:59:00.000", row_count: "28026190" }]))
      .mockResolvedValueOnce(jsonResponse([{ earliest: "2026-07-31T11:05:00.000", latest: "2026-09-01T21:59:00.000", row_count: "28111190" }]));

    const result = await fetchCurrentCoverage("https://data.seattle.gov/resource/rke9-rsvs.json");

    expect(result).toEqual({
      earliestCovered: "2026-07-31T12:03:00.000",
      latestCovered: "2026-09-01T21:59:00.000",
      rowCount: 28026190,
    });
  });

  it("throws on a non-ok response", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { ok: false, status: 503, statusText: "Service Unavailable" }));
    await expect(fetchCurrentCoverage("https://data.seattle.gov/resource/rke9-rsvs.json")).rejects.toThrow(/status 503/);
  });

  it("throws on an empty array response", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await expect(fetchCurrentCoverage("https://data.seattle.gov/resource/rke9-rsvs.json")).rejects.toThrow(/unexpected response shape/);
  });

  it("throws on a row missing the expected fields", async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ earliest: "a" }]));
    await expect(fetchCurrentCoverage("https://data.seattle.gov/resource/rke9-rsvs.json")).rejects.toThrow(/unexpected row shape/);
  });

  it("throws on a non-numeric row_count", async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ earliest: "a", latest: "b", row_count: "not-a-number" }]));
    await expect(fetchCurrentCoverage("https://data.seattle.gov/resource/rke9-rsvs.json")).rejects.toThrow(/not a valid number/);
  });
});

// --- DB read/write (fake DI client) -----------------------------------

function makeFakeClient(existingRows: Record<string, unknown>[] = []) {
  const inserted: Record<string, unknown>[] = [];
  const rows = [...existingRows];

  const client: RollingWindowRefreshLogSupabaseClient = {
    from: () => ({
      select: () => {
        const builder = {
          eq: (_col: string, value: string) => {
            const filtered = rows.filter((r) => r.archive_dataset_id === value);
            return {
              order: () => ({
                limit: async (n: number) => ({
                  data: [...filtered].sort((a, b) => String(b.checked_at).localeCompare(String(a.checked_at))).slice(0, n),
                  error: null,
                }),
              }),
              eq: builder.eq,
            };
          },
        } as any;
        return builder;
      },
      insert: async (values: Record<string, unknown>) => {
        inserted.push(values);
        rows.push(values);
        return { data: null, error: null };
      },
    }),
  };

  return { client, inserted };
}

describe("fetchLatestRefreshLogEntry", () => {
  it("returns null when no prior entry exists for this archive_dataset_id", async () => {
    const { client } = makeFakeClient([]);
    const result = await fetchLatestRefreshLogEntry(client, "rke9-rsvs");
    expect(result).toBeNull();
  });

  it("returns the most recent entry for the given archive_dataset_id", async () => {
    const { client } = makeFakeClient([
      { archive_dataset_id: "rke9-rsvs", checked_at: "2026-09-10T00:00:00.000Z", earliest_covered: "2026-07-20T00:00:00.000", latest_covered: "2026-08-25T00:00:00.000", row_count: 100 },
      { archive_dataset_id: "rke9-rsvs", checked_at: "2026-09-12T00:00:00.000Z", earliest_covered: "2026-07-31T00:00:00.000", latest_covered: "2026-09-01T00:00:00.000", row_count: 200 },
      { archive_dataset_id: "some-other-dataset", checked_at: "2026-09-13T00:00:00.000Z", earliest_covered: "9999", latest_covered: "9999", row_count: 999 },
    ]);
    const result = await fetchLatestRefreshLogEntry(client, "rke9-rsvs");
    expect(result).toEqual({ earliestCovered: "2026-07-31T00:00:00.000", latestCovered: "2026-09-01T00:00:00.000", rowCount: 200 });
  });
});

describe("recordRefreshLogEntry", () => {
  it("inserts exactly the given coverage and gap result", async () => {
    const { client, inserted } = makeFakeClient([]);
    const now = new Date("2026-09-12T00:35:00.000Z");

    await recordRefreshLogEntry(
      client,
      "rke9-rsvs",
      { earliestCovered: "2026-07-31T11:05:00.000", latestCovered: "2026-09-01T21:59:00.000", rowCount: 28111190 },
      { gapDetected: false, gapDetail: null },
      now,
    );

    expect(inserted).toEqual([
      {
        archive_dataset_id: "rke9-rsvs",
        checked_at: "2026-09-12T00:35:00.000Z",
        earliest_covered: "2026-07-31T11:05:00.000",
        latest_covered: "2026-09-01T21:59:00.000",
        row_count: 28111190,
        gap_detected: false,
        gap_detail: null,
      },
    ]);
  });
});

describe("checkAndRecordCoverage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches real coverage, checks it against the last recorded entry, and records the outcome", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([{ earliest: "2026-08-02T00:00:00.000", latest: "2026-08-05T00:00:00.000", row_count: "500" }]),
    );
    const { client, inserted } = makeFakeClient([
      { archive_dataset_id: "rke9-rsvs", checked_at: "2026-09-10T00:00:00.000Z", earliest_covered: "2026-07-27T00:00:00.000", latest_covered: "2026-08-01T00:00:00.000", row_count: 100 },
    ]);

    const result = await checkAndRecordCoverage(client, "https://data.seattle.gov/resource/rke9-rsvs.json", "rke9-rsvs", new Date("2026-09-12T00:00:00.000Z"));

    expect(result.gapResult.gapDetected).toBe(true); // 2026-08-02 > 2026-08-01
    expect(result.coverage.rowCount).toBe(500);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ gap_detected: true });
  });

  it("records a clean (no-gap) outcome on the very first check for a dataset id", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([{ earliest: "2026-07-31T11:05:00.000", latest: "2026-09-01T21:59:00.000", row_count: "28111190" }]),
    );
    const { client, inserted } = makeFakeClient([]);

    const result = await checkAndRecordCoverage(client, "https://data.seattle.gov/resource/rke9-rsvs.json", "rke9-rsvs", new Date("2026-09-12T00:36:00.000Z"));

    expect(result.gapResult).toEqual({ gapDetected: false, gapDetail: null });
    expect(inserted[0]).toMatchObject({ gap_detected: false, gap_detail: null });
  });
});
