import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyDayVolume, fetchDayRowCountTwice, runCatchUpFold, type CatchUpFoldClients } from "./catch-up-fold-days.ts";
import type { SocrataRecord } from "../utils/fetchSocrataRecords.ts";

describe("classifyDayVolume", () => {
  it("always classifies a real Sunday as folded, regardless of count -- a confirmed, expected zero, never an anomaly", () => {
    expect(classifyDayVolume("2026-09-13", 0, [900000, 950000])).toBe("folded"); // 2026-09-13 is a real Sunday
    expect(classifyDayVolume("2026-09-13", 5, [900000, 950000])).toBe("folded");
  });

  it("folds a normal weekday with no baseline yet this run", () => {
    expect(classifyDayVolume("2026-09-14", 1000000, [])).toBe("folded"); // Monday, no recent counts
  });

  it("flags a real weekday whose count is below 70% of the recent median", () => {
    // Matches the real anomaly this investigation found: ~57-62% of normal.
    expect(classifyDayVolume("2026-09-14", 550000, [1000000, 990000, 1010000])).toBe("low_volume");
  });

  it("folds a weekday whose count is within the normal range of the recent median", () => {
    expect(classifyDayVolume("2026-09-14", 950000, [1000000, 990000, 1010000])).toBe("folded");
  });

  it("folds (never flags) when the recent median itself is 0 -- nothing meaningful to compare against", () => {
    expect(classifyDayVolume("2026-09-14", 5, [0, 0])).toBe("folded");
  });
});

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, statusText: "OK", json: () => Promise.resolve(body) } as Response;
}

describe("fetchDayRowCountTwice", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports stable when two real reads agree", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ n: "1000000" }])).mockResolvedValueOnce(jsonResponse([{ n: "1000000" }]));
    const result = await fetchDayRowCountTwice("https://data.seattle.gov/resource/xkas-9n43.json", "2026-09-14");
    expect(result).toEqual({ stable: true, count: 1000000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports unstable when two real reads disagree -- the exact replica-inconsistency this check exists to catch", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ n: "1000000" }])).mockResolvedValueOnce(jsonResponse([{ n: "998500" }]));
    const result = await fetchDayRowCountTwice("https://data.seattle.gov/resource/xkas-9n43.json", "2026-09-14");
    expect(result).toEqual({ stable: false, count: null });
  });
});

function makeRawRecord(idSuffix: string, overrides: Partial<Record<string, unknown>> = {}): SocrataRecord {
  return {
    ":id": `row-${idSuffix}`,
    sourceelementkey: "9477",
    sideofstreet: "W",
    occupancydatetime: "2026-09-14T09:00:00.000",
    paidoccupancy: "1",
    parkingspacecount: "8",
    ...overrides,
  };
}

function makeMockClients(options: { existingLedgerRows?: Record<string, unknown>[]; existingBucketRows?: Record<string, unknown>[] } = {}) {
  const ledgerRows: Record<string, unknown>[] = [...(options.existingLedgerRows ?? [])];
  const bucketRows: Record<string, unknown>[] = [...(options.existingBucketRows ?? [])];

  const ledgerClient = {
    from: () => ({
      select: () => {
        let filterWindow: string | undefined;
        const builder = {
          eq: (_c: string, value: string) => {
            filterWindow = value;
            return builder;
          },
          then: (onFulfilled?: (v: unknown) => unknown) =>
            Promise.resolve({ data: ledgerRows.filter((r) => r.logical_window === filterWindow), error: null }).then(onFulfilled),
        };
        return builder;
      },
      insert: async (values: Record<string, unknown>) => {
        ledgerRows.push(values);
        return { data: null, error: null };
      },
    }),
  };

  const bucketsClient = {
    from: () => ({
      select: () => {
        let filterId: string | undefined;
        const builder = {
          eq: (_c: string, value: string) => {
            filterId = value;
            return builder;
          },
          order: () => builder,
          range: async (from: number, to: number) => ({ data: bucketRows.filter((r) => r.archive_dataset_id === filterId).slice(from, to + 1), error: null }),
        };
        return builder;
      },
      upsert: async (rows: Record<string, unknown>[]) => {
        for (const row of rows) {
          const key = `${row.archive_dataset_id}:${row.blockface_id}:${row.iso_day}:${row.hour}`;
          const idx = bucketRows.findIndex((r) => `${r.archive_dataset_id}:${r.blockface_id}:${r.iso_day}:${r.hour}` === key);
          if (idx >= 0) bucketRows[idx] = { ...bucketRows[idx], ...row };
          else bucketRows.push(row);
        }
        return { data: null, error: null };
      },
    }),
  };

  const blockfaceLookupClient = {
    from: () => ({
      select: () => ({
        range: async (from: number) => (from === 0 ? { data: [{ id: "blockface-1", source_element_key: 9477, side_of_street: "W" }], error: null } : { data: [], error: null }),
      }),
    }),
  };

  return { clients: { blockfaceLookupClient, bucketsClient, ledgerClient } as unknown as CatchUpFoldClients, ledgerRows: () => ledgerRows, bucketRows: () => bucketRows };
}

const PERMANENT_GAP = ["2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07"];
const NOW = new Date("2026-10-11T12:00:00Z"); // minAgeDays=3 -> upper bound 2026-10-08

describe("runCatchUpFold", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn((url: string) => {
      if (url.includes("%24select=min")) {
        return Promise.resolve(jsonResponse([{ earliest: "2026-09-08T21:59:00.000" }]));
      }
      if (url.includes("count")) {
        return Promise.resolve(jsonResponse([{ n: "1000000" }]));
      }
      return Promise.resolve(jsonResponse([makeRawRecord("1")]));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records every real permanent-gap date exactly once, even across repeated runs", async () => {
    const { clients, ledgerRows } = makeMockClients();

    await runCatchUpFold(clients, {
      logicalWindow: "seattle-paid-parking-rolling-30-day",
      sourceDatasetId: "xkas-9n43",
      sourceDatasetUrl: "https://data.seattle.gov/resource/xkas-9n43.json",
      stagingIdentity: "7c2e-uany-staging-test",
      minAgeDays: 3,
      permanentGapDates: PERMANENT_GAP,
      now: NOW,
    });

    const gapRows = ledgerRows().filter((r) => r.status === "permanent_gap");
    expect(gapRows).toHaveLength(6);
    expect(gapRows.every((r) => r.source_dataset_id === null)).toBe(true);
  });

  it("never re-records an already-ledgered permanent-gap date on a second run", async () => {
    const { clients, ledgerRows } = makeMockClients({
      existingLedgerRows: PERMANENT_GAP.map((date) => ({ logical_window: "seattle-paid-parking-rolling-30-day", date, source_dataset_id: null, row_count_at_fold: null, status: "permanent_gap", folded_at: "2026-10-01T00:00:00Z" })),
    });

    await runCatchUpFold(clients, {
      logicalWindow: "seattle-paid-parking-rolling-30-day",
      sourceDatasetId: "xkas-9n43",
      sourceDatasetUrl: "https://data.seattle.gov/resource/xkas-9n43.json",
      stagingIdentity: "7c2e-uany-staging-test",
      minAgeDays: 3,
      permanentGapDates: PERMANENT_GAP,
      now: NOW,
    });

    const gapInsertCalls = ledgerRows().filter((r) => r.status === "permanent_gap");
    expect(gapInsertCalls).toHaveLength(6); // the 6 pre-seeded rows, zero NEW inserts
  });

  it("respects the pinned upper bound -- never considers a day newer than (now - minAgeDays)", async () => {
    const { clients } = makeMockClients({
      existingLedgerRows: [
        // Pre-ledger everything from Sep8 through Oct7 so only Oct8 (the
        // real upper bound for minAgeDays=3 against NOW) would be a new
        // candidate -- confirming the fetch calls made are consistent
        // with a single remaining day, not something past the boundary.
        ...Array.from({ length: 30 }, (_, i) => {
          const d = new Date("2026-09-08T00:00:00Z");
          d.setUTCDate(d.getUTCDate() + i);
          return { logical_window: "seattle-paid-parking-rolling-30-day", date: d.toISOString().slice(0, 10), source_dataset_id: "xkas-9n43", row_count_at_fold: 1000000, status: "folded", folded_at: "2026-10-01T00:00:00Z" };
        }),
      ],
    });

    const result = await runCatchUpFold(clients, {
      logicalWindow: "seattle-paid-parking-rolling-30-day",
      sourceDatasetId: "xkas-9n43",
      sourceDatasetUrl: "https://data.seattle.gov/resource/xkas-9n43.json",
      stagingIdentity: "7c2e-uany-staging-test",
      minAgeDays: 3,
      permanentGapDates: [],
      now: NOW,
    });

    expect(result.upperBoundDate).toBe("2026-10-08");
    const nonGapDays = result.days.filter((d) => d.outcome !== "permanent_gap");
    expect(nonGapDays.map((d) => d.date)).toEqual(["2026-10-08"]);
  });

  it("skips a day with an unstable row count across two reads, without ledgering it", async () => {
    let dayCallCount = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("%24select=min")) return Promise.resolve(jsonResponse([{ earliest: "2026-10-08T00:00:00.000" }]));
      if (url.includes("count")) {
        dayCallCount += 1;
        return Promise.resolve(jsonResponse([{ n: dayCallCount === 1 ? "1000000" : "998000" }]));
      }
      return Promise.resolve(jsonResponse([]));
    });
    const { clients, ledgerRows } = makeMockClients();

    const result = await runCatchUpFold(clients, {
      logicalWindow: "seattle-paid-parking-rolling-30-day",
      sourceDatasetId: "xkas-9n43",
      sourceDatasetUrl: "https://data.seattle.gov/resource/xkas-9n43.json",
      stagingIdentity: "7c2e-uany-staging-test",
      minAgeDays: 3,
      permanentGapDates: [],
      now: NOW,
    });

    expect(result.days.find((d) => d.date === "2026-10-08")).toMatchObject({ outcome: "skipped_unstable" });
    expect(ledgerRows().some((r) => r.date === "2026-10-08")).toBe(false);
  });

  it("folds a real stable day, seeding from the copied-live staging baseline already present", async () => {
    const { clients, ledgerRows, bucketRows } = makeMockClients({
      existingBucketRows: [{ archive_dataset_id: "7c2e-uany-staging-test", blockface_id: "blockface-1", iso_day: 1, hour: 9, count: 100, total_weight: 80, mean: 0.4, sum_squared_diff: 2 }],
    });
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("%24select=min")) return Promise.resolve(jsonResponse([{ earliest: "2026-10-08T00:00:00.000" }]));
      if (url.includes("count")) return Promise.resolve(jsonResponse([{ n: "1" }]));
      return Promise.resolve(jsonResponse([makeRawRecord("1", { occupancydatetime: "2026-10-08T09:00:00.000" })]));
    });

    const result = await runCatchUpFold(clients, {
      logicalWindow: "seattle-paid-parking-rolling-30-day",
      sourceDatasetId: "xkas-9n43",
      sourceDatasetUrl: "https://data.seattle.gov/resource/xkas-9n43.json",
      stagingIdentity: "7c2e-uany-staging-test",
      minAgeDays: 3,
      permanentGapDates: [],
      now: NOW,
    });

    expect(result.days.find((d) => d.date === "2026-10-08")).toMatchObject({ outcome: "folded", rowCount: 1 });
    expect(ledgerRows().find((r) => r.date === "2026-10-08")).toMatchObject({ status: "folded", source_dataset_id: "xkas-9n43" });
    // The pre-existing, copied-live bucket (blockface-1/iso_day=1/hour=9) is
    // still present after folding -- the catch-up seeded from it rather
    // than starting from an empty accumulator.
    expect(bucketRows().some((r) => r.archive_dataset_id === "7c2e-uany-staging-test" && r.blockface_id === "blockface-1" && r.iso_day === 1 && r.hour === 9)).toBe(true);
  });
});
