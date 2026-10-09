import { describe, expect, it } from "vitest";
import {
  computeUpperBoundDate,
  enumerateDates,
  fetchLedgeredDates,
  recordLedgerEntry,
  type RollingWindowFoldLedgerSupabaseClient,
} from "./rollingWindowFoldLedger.ts";

function makeMockClient(rows: Record<string, unknown>[]) {
  const insertCalls: Record<string, unknown>[] = [];
  const client: RollingWindowFoldLedgerSupabaseClient = {
    from: () => ({
      select: () => {
        let filterWindow: string | undefined;
        const builder = {
          eq: (_c: string, value: string) => {
            filterWindow = value;
            return builder;
          },
          then: (onFulfilled?: (v: unknown) => unknown) =>
            Promise.resolve({ data: rows.filter((r) => r.logical_window === filterWindow), error: null }).then(onFulfilled),
        };
        return builder;
      },
      insert: async (values: Record<string, unknown>) => {
        insertCalls.push(values);
        return { data: null, error: null };
      },
    }),
  } as unknown as RollingWindowFoldLedgerSupabaseClient;
  return { client, insertCalls };
}

describe("fetchLedgeredDates", () => {
  it("returns every real date recorded for this logical window, keyed by date", async () => {
    const { client } = makeMockClient([
      { logical_window: "rolling-30-day", date: "2026-09-08", source_dataset_id: "xkas-9n43", row_count_at_fold: 500000, folded_at: "2026-10-11T00:00:00Z", status: "folded" },
      { logical_window: "rolling-30-day", date: "2026-09-02", source_dataset_id: null, row_count_at_fold: null, folded_at: "2026-10-11T00:00:00Z", status: "permanent_gap" },
      { logical_window: "other-window", date: "2026-09-08", source_dataset_id: "x", row_count_at_fold: 1, folded_at: "2026-10-11T00:00:00Z", status: "folded" },
    ]);

    const result = await fetchLedgeredDates(client, "rolling-30-day");

    expect(result.size).toBe(2);
    expect(result.get("2026-09-08")).toMatchObject({ status: "folded", sourceDatasetId: "xkas-9n43" });
    expect(result.get("2026-09-02")).toMatchObject({ status: "permanent_gap", sourceDatasetId: null });
  });

  it("returns an empty map for a logical window with no recorded history at all", async () => {
    const { client } = makeMockClient([]);
    const result = await fetchLedgeredDates(client, "rolling-30-day");
    expect(result.size).toBe(0);
  });
});

describe("recordLedgerEntry", () => {
  it("inserts a real, complete row for a folded day", async () => {
    const { client, insertCalls } = makeMockClient([]);
    await recordLedgerEntry(client, {
      logicalWindow: "rolling-30-day",
      date: "2026-09-10",
      sourceDatasetId: "xkas-9n43",
      rowCountAtFold: 987654,
      status: "folded",
      foldedAt: new Date("2026-10-11T12:00:00Z"),
    });
    expect(insertCalls[0]).toEqual({
      logical_window: "rolling-30-day",
      date: "2026-09-10",
      source_dataset_id: "xkas-9n43",
      row_count_at_fold: 987654,
      status: "folded",
      folded_at: "2026-10-11T12:00:00.000Z",
    });
  });

  it("inserts a permanent_gap row with a null source and null row count", async () => {
    const { client, insertCalls } = makeMockClient([]);
    await recordLedgerEntry(client, {
      logicalWindow: "rolling-30-day",
      date: "2026-09-03",
      sourceDatasetId: null,
      rowCountAtFold: null,
      status: "permanent_gap",
      foldedAt: new Date("2026-10-11T12:00:00Z"),
    });
    expect(insertCalls[0]).toMatchObject({ source_dataset_id: null, row_count_at_fold: null, status: "permanent_gap" });
  });
});

describe("enumerateDates", () => {
  it("enumerates every real calendar day in [start, end)", () => {
    expect(enumerateDates("2026-09-02", "2026-09-08")).toEqual(["2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07"]);
  });

  it("returns an empty array when start equals end", () => {
    expect(enumerateDates("2026-09-02", "2026-09-02")).toEqual([]);
  });

  it("handles a real month boundary correctly", () => {
    expect(enumerateDates("2026-08-30", "2026-09-02")).toEqual(["2026-08-30", "2026-08-31", "2026-09-01"]);
  });
});

describe("computeUpperBoundDate", () => {
  it("subtracts the real minimum age in whole days", () => {
    expect(computeUpperBoundDate(new Date("2026-10-11T15:00:00Z"), 3)).toBe("2026-10-08");
  });

  it("is pinned to a single, explicit `now` -- deterministic given the same input, not re-derived from the real clock", () => {
    const now = new Date("2026-01-05T00:00:00Z");
    expect(computeUpperBoundDate(now, 3)).toBe("2026-01-02");
  });
});
