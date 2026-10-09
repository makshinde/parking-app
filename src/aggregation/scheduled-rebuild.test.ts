import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCliOptions, runScheduledRebuild, type ScheduledRebuildClients } from "./scheduled-rebuild.ts";
import type { SocrataRecord } from "../utils/fetchSocrataRecords.ts";

describe("parseCliOptions", () => {
  it("defaults to dry-run (allowPromotion: false) with no flags", () => {
    expect(parseCliOptions([])).toEqual({ allowPromotion: false });
  });

  it("enables promotion only when --allow-promotion is explicitly passed", () => {
    expect(parseCliOptions(["--allow-promotion"])).toEqual({ allowPromotion: true });
  });

  it("ignores unrelated flags", () => {
    expect(parseCliOptions(["--verbose"])).toEqual({ allowPromotion: false });
  });
});

// --- Fixtures ----------------------------------------------------------------

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number; statusText?: string }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "OK",
    json: () => Promise.resolve(body),
  } as Response;
}

function makeRawRecord(idSuffix: string, overrides: Partial<Record<string, unknown>> = {}): SocrataRecord {
  return {
    ":id": `row-${idSuffix}`,
    sourceelementkey: "9477",
    sideofstreet: "W",
    occupancydatetime: "2026-01-15T09:00:00.000",
    paidoccupancy: "1",
    parkingspacecount: "8",
    ...overrides,
  };
}

const COVERAGE_RESPONSE = [{ earliest: "2026-09-01T00:00:00.000", latest: "2026-09-30T00:00:00.000", row_count: "1000" }];

// Responds to the gap-check's coverage reads (identifiable by their
// $select=min(...) query) with a real coverage shape, and to every other
// request (the two archive-page fetches) with a short, 1-record page --
// short enough to signal "stream complete" after a single call, the same
// idiom stream-into-staging.test.ts's own fixtures use.
function installFetchMock(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string) => {
    if (url.includes("%24select=min")) {
      return Promise.resolve(jsonResponse(COVERAGE_RESPONSE));
    }
    return Promise.resolve(jsonResponse([makeRawRecord("1")]));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// A minimal, self-contained in-memory mock of every client
// runScheduledRebuild touches -- same style as stream-into-staging.test.ts's
// own makeMockClients, extended to cover every table this orchestrator
// reads/writes.
function makeMockClients(options: {
  existingBucketRows?: Record<string, unknown>[];
  existingRunRows?: Record<string, unknown>[];
  existingRefreshLogRows?: Record<string, unknown>[];
  promoteRpcError?: { message: string } | null;
} = {}) {
  const checkpointRows = new Map<string, Record<string, unknown>>();
  const bucketRows: Record<string, unknown>[] = [...(options.existingBucketRows ?? [])];
  const runRows: Record<string, unknown>[] = [...(options.existingRunRows ?? [])];
  const refreshLogRows: Record<string, unknown>[] = [...(options.existingRefreshLogRows ?? [])];
  const occupancyStatsRows: Record<string, unknown>[] = [];
  const promoteCalls: { p_stable_identity: string; p_staging_identity: string; p_backup_identity: string }[] = [];

  const checkpointClient = {
    from: () => ({
      select: () => {
        let filterId: string | undefined;
        const builder = {
          eq: (_c: string, value: string) => {
            filterId = value;
            return builder;
          },
          maybeSingle: async () => ({ data: filterId !== undefined ? (checkpointRows.get(filterId) ?? null) : null, error: null }),
        };
        return builder;
      },
      upsert: async (row: Record<string, unknown>) => {
        const id = row.archive_dataset_id as string;
        checkpointRows.set(id, { ...checkpointRows.get(id), ...row });
        return { data: null, error: null };
      },
      update: (values: Record<string, unknown>) => ({
        eq: (_c: string, id: string) => ({
          select: async () => {
            const existing = checkpointRows.get(id);
            if (existing === undefined) return { data: [], error: null };
            checkpointRows.set(id, { ...existing, ...values });
            return { data: [checkpointRows.get(id)], error: null };
          },
        }),
      }),
      delete: () => ({
        eq: async (_c: string, id: string) => {
          checkpointRows.delete(id);
          return { data: [], error: null };
        },
      }),
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
          range: async (from: number, to: number) => {
            const filtered = bucketRows.filter((r) => r.archive_dataset_id === filterId);
            return { data: filtered.slice(from, to + 1), error: null };
          },
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

  const refreshLogClient = {
    from: () => ({
      select: () => {
        let filterId: string | undefined;
        const builder = {
          eq: (_c: string, value: string) => {
            filterId = value;
            return builder;
          },
          order: () => builder,
          limit: async (count: number) => {
            const filtered = refreshLogRows.filter((r) => r.archive_dataset_id === filterId).sort((a, b) => (b.checked_at as string).localeCompare(a.checked_at as string));
            return { data: filtered.slice(0, count), error: null };
          },
        };
        return builder;
      },
      insert: async (row: Record<string, unknown>) => {
        refreshLogRows.push(row);
        return { data: null, error: null };
      },
    }),
  };

  let nextOccupancyStatsId = 1;
  const occupancyStatsClient = {
    from: () => ({
      upsert: (rows: Record<string, unknown>[]) => ({
        select: async () => {
          const stored = rows.map((row) => ({ id: `stat-${nextOccupancyStatsId++}`, ...row }));
          occupancyStatsRows.push(...stored);
          return { data: stored, error: null };
        },
      }),
      // The independent follow-up read upsertOccupancyStatsBatch's own
      // verifyBatchPersisted does, keyed by the ids just returned above.
      select: () => ({
        in: async (_col: string, ids: string[]) => ({ data: occupancyStatsRows.filter((r) => ids.includes(r.id as string)), error: null }),
      }),
    }),
  };

  const occupancyStatsBulkReadClient = {
    from: () => ({
      select: () => ({
        range: async (from: number, to: number) => ({ data: occupancyStatsRows.slice(from, to + 1), error: null }),
      }),
    }),
  };

  const failuresClient = {
    from: () => ({
      // Supports both call shapes this project's real code uses: a bare
      // `.select(cols)` awaited directly (runRetryPass, reading every
      // failure row) and `.select(cols).eq().eq().eq().maybeSingle()`
      // (logBucketFailure, checking for one specific existing row) -- made
      // thenable itself so the bare-await path resolves without a
      // `.maybeSingle()`/terminal call.
      select: () => ({
        eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
        then: (onFulfilled?: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(onFulfilled),
      }),
      upsert: async () => ({ data: null, error: null }),
      delete: () => ({ eq: async () => ({ data: null, error: null }) }),
    }),
  };

  const runsLogClient = {
    from: () => ({
      select: () => {
        let filterId: string | undefined;
        const builder = {
          eq: (_c: string, value: string) => {
            filterId = value;
            return builder;
          },
          order: () => builder,
          limit: async (count: number) => {
            const filtered = runRows.filter((r) => r.stable_identity === filterId).sort((a, b) => (b.started_at as string).localeCompare(a.started_at as string));
            return { data: filtered.slice(0, count), error: null };
          },
        };
        return builder;
      },
      insert: (values: Record<string, unknown>) => {
        const row = { id: `run-${runRows.length + 1}`, ...values };
        runRows.push(row);
        return { select: () => ({ single: async () => ({ data: row, error: null }) }) };
      },
      update: (values: Record<string, unknown>) => ({
        eq: async (_c: string, id: string) => {
          const idx = runRows.findIndex((r) => r.id === id);
          if (idx >= 0) runRows[idx] = { ...runRows[idx], ...values };
          return { data: null, error: null };
        },
      }),
    }),
  };

  const promoteRpcClient = {
    rpc: async (_fn: string, args: { p_stable_identity: string; p_staging_identity: string; p_backup_identity: string }) => {
      promoteCalls.push(args);
      return { data: null, error: options.promoteRpcError ?? null };
    },
  };

  const blockfaceLookupClient = {
    from: () => ({
      select: () => ({
        range: async (from: number) => (from === 0 ? { data: [{ id: "blockface-1", source_element_key: 9477, side_of_street: "W" }], error: null } : { data: [], error: null }),
      }),
    }),
  };

  const clients = {
    blockfaceLookupClient,
    checkpointClient,
    bucketsClient,
    refreshLogClient,
    occupancyStatsClient,
    occupancyStatsBulkReadClient,
    failuresClient,
    runsLogClient,
    promoteRpcClient,
  } as unknown as ScheduledRebuildClients;

  return { clients, bucketRows: () => bucketRows, runRows: () => runRows, promoteCalls, occupancyStatsRows: () => occupancyStatsRows };
}

const NOW = new Date("2026-10-08T09:00:00Z");

describe("runScheduledRebuild", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = installFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the real happy path (--allow-promotion): streams both sources, passes gap check and integrity check, promotes, reconciles, verifies, and succeeds", async () => {
    const { clients, runRows, promoteCalls, occupancyStatsRows } = makeMockClients();

    const result = await runScheduledRebuild(clients, NOW, { allowPromotion: true });

    expect(result.outcome).toBe("succeeded");
    expect(result.dryRun).toBe(false);
    expect(result.promoted).toBe(true);
    expect(promoteCalls).toHaveLength(1);
    expect(promoteCalls[0]?.p_stable_identity).toBe("7c2e-uany");
    expect(promoteCalls[0]?.p_staging_identity).toMatch(/^7c2e-uany-staging-/);
    expect(promoteCalls[0]?.p_backup_identity).toMatch(/^7c2e-uany-backup-/);

    const finishedRun = runRows().find((r) => r.id === result.runId);
    expect(finishedRun).toMatchObject({ status: "succeeded", step: "done" });

    // Both the archive fold and the rolling-window fold happened (2 page
    // fetches), plus 5 coverage reads for the gap check.
    expect(fetchMock).toHaveBeenCalledTimes(7);

    // Only 2 real readings ever got folded into this bucket (one per
    // source) -- well under MIN_READINGS_PER_BUCKET (30), so reconcile
    // correctly writes nothing for it rather than persisting a mean/stdDev
    // backed by too little data. Zero written, zero stale, run still
    // succeeds -- exactly the intended behavior for a too-thin bucket.
    expect(occupancyStatsRows()).toHaveLength(0);
  });

  it("aborts BEFORE promoting when a real gap is detected -- the live identity is never touched", async () => {
    const { clients, promoteCalls, runRows } = makeMockClients({
      existingRefreshLogRows: [
        // latest_covered is deliberately BEFORE the mocked coverage
        // response's own earliest ("2026-09-01...") -- a real gap, by
        // detectCoverageGap's own definition (current.earliest > previous.latest).
        { archive_dataset_id: "rke9-rsvs", checked_at: "2026-08-01T00:00:00Z", earliest_covered: "2026-07-30T00:00:00.000", latest_covered: "2026-08-01T00:00:00.000", row_count: 500, gap_detected: false, gap_detail: null },
      ],
    });

    const result = await runScheduledRebuild(clients, NOW);

    expect(result.outcome).toBe("failed");
    expect(result.promoted).toBe(false);
    expect(promoteCalls).toHaveLength(0);
    const finishedRun = runRows().find((r) => r.id === result.runId);
    expect(finishedRun).toMatchObject({ status: "failed", step: "gap_check" });
    expect(result.failureReason).toMatch(/gap/i);
  });

  it("aborts BEFORE promoting when the integrity check fails (staging bucket count collapsed vs. the current live identity)", async () => {
    const liveRows = Array.from({ length: 100 }, (_, i) => ({
      archive_dataset_id: "7c2e-uany",
      blockface_id: `other-bf-${i}`,
      iso_day: 2,
      hour: 14,
      count: 100,
      total_weight: 80,
      mean: 0.4,
      sum_squared_diff: 2,
    }));
    const { clients, promoteCalls, runRows } = makeMockClients({ existingBucketRows: liveRows });

    const result = await runScheduledRebuild(clients, NOW);

    expect(result.outcome).toBe("failed");
    expect(result.promoted).toBe(false);
    expect(promoteCalls).toHaveLength(0);
    const finishedRun = runRows().find((r) => r.id === result.runId);
    expect(finishedRun).toMatchObject({ status: "failed", step: "integrity_check" });
  });

  it("propagates a real promote RPC failure as a failed run, with promoted still reported false (the rename itself never completed)", async () => {
    const { clients, runRows } = makeMockClients({ promoteRpcError: { message: "deadlock detected" } });

    const result = await runScheduledRebuild(clients, NOW, { allowPromotion: true });

    expect(result.outcome).toBe("failed");
    expect(result.promoted).toBe(false);
    expect(result.failureReason).toMatch(/deadlock detected/);
    const finishedRun = runRows().find((r) => r.id === result.runId);
    expect(finishedRun?.status).toBe("failed");
  });

  it("resumes from reconcile (no re-streaming, no re-promoting) when the previous run already promoted but failed afterward", async () => {
    const { clients, promoteCalls, runRows } = makeMockClients({
      existingRunRows: [
        {
          id: "old-run",
          started_at: "2026-10-01T00:00:00Z",
          completed_at: "2026-10-01T01:00:00Z",
          stable_identity: "7c2e-uany",
          staging_identity: "7c2e-uany-staging-OLD",
          backup_identity: "7c2e-uany-backup-OLD",
          step: "verifying",
          status: "failed",
          gap_detected: false,
          failure_reason: "some stale rows found",
        },
      ],
      // The promoted live identity already has real accumulator data from
      // the earlier (failed-at-verify) run -- reconcile should read THIS,
      // not stream anything new.
      existingBucketRows: [
        { archive_dataset_id: "7c2e-uany", blockface_id: "blockface-1", iso_day: 2, hour: 14, count: 100, total_weight: 80, mean: 0.4, sum_squared_diff: 2 },
      ],
    });

    const result = await runScheduledRebuild(clients, NOW);

    expect(result.outcome).toBe("succeeded");
    expect(result.promoted).toBe(true);
    expect(promoteCalls).toHaveLength(0); // never re-promoted
    expect(fetchMock).not.toHaveBeenCalled(); // never re-streamed, never re-checked coverage

    const newRun = runRows().find((r) => r.id === result.runId);
    expect(newRun).toMatchObject({ status: "succeeded", backup_identity: "7c2e-uany-backup-OLD" });
  });

  it("reports a real failure (but promoted: true) when stale rows remain after reconcile+verify", async () => {
    // A live bucket with NO corresponding occupancy_stats row written by
    // this test's own mock reconcile path would never trigger staleness
    // (compareOccupancyStatsToAccumulator only flags rows that exist in
    // occupancy_stats) -- so to force a real stale mismatch, seed
    // occupancy_stats directly with a row that disagrees with the real
    // accumulator bucket it'll be reconciled from.
    const { clients, occupancyStatsRows } = makeMockClients({
      existingRunRows: [
        {
          id: "old-run",
          started_at: "2026-10-01T00:00:00Z",
          completed_at: "2026-10-01T01:00:00Z",
          stable_identity: "7c2e-uany",
          staging_identity: "7c2e-uany-staging-OLD",
          backup_identity: "7c2e-uany-backup-OLD",
          step: "reconciling",
          status: "failed",
          gap_detected: false,
          failure_reason: "crashed before verifying",
        },
      ],
      existingBucketRows: [
        { archive_dataset_id: "7c2e-uany", blockface_id: "blockface-1", iso_day: 2, hour: 14, count: 100, total_weight: 80, mean: 0.4, sum_squared_diff: 2 },
      ],
    });
    // Seed a pre-existing, now-stale occupancy_stats row for a DIFFERENT
    // bucket the reconcile pass won't touch or overwrite.
    occupancyStatsRows().push({ id: "stale-1", blockface_id: "orphan-blockface", day_of_week: 3, hour_of_day: 8, mean_occupancy: 0.9, std_dev: 0.1, sample_count: 50 });

    const result = await runScheduledRebuild(clients, NOW);

    expect(result.outcome).toBe("failed");
    expect(result.promoted).toBe(true);
    expect(result.failureReason).toMatch(/stale occupancy_stats row/);
  });

  describe("the dry-run gate", () => {
    it("defaults to dry-run when no options are passed at all -- the safe behavior needs no flag", async () => {
      const { clients, promoteCalls, runRows } = makeMockClients();

      const result = await runScheduledRebuild(clients, NOW);

      expect(result.outcome).toBe("succeeded");
      expect(result.dryRun).toBe(true);
      expect(result.promoted).toBe(false);
      expect(promoteCalls).toHaveLength(0);
      const finishedRun = runRows().find((r) => r.id === result.runId);
      expect(finishedRun).toMatchObject({ status: "succeeded", step: "dry_run_complete", dry_run: true });
    });

    it("stops after every real check passes, never calling promote, when allowPromotion is explicitly false", async () => {
      const { clients, promoteCalls } = makeMockClients();

      const result = await runScheduledRebuild(clients, NOW, { allowPromotion: false });

      expect(result.dryRun).toBe(true);
      expect(result.outcome).toBe("succeeded");
      expect(promoteCalls).toHaveLength(0);
    });

    it("still fails loudly on a dry run if the gap check itself fails -- a dry run checks for real, it doesn't fake success", async () => {
      const { clients, promoteCalls, runRows } = makeMockClients({
        existingRefreshLogRows: [
          { archive_dataset_id: "rke9-rsvs", checked_at: "2026-08-01T00:00:00Z", earliest_covered: "2026-07-30T00:00:00.000", latest_covered: "2026-08-01T00:00:00.000", row_count: 500, gap_detected: false, gap_detail: null },
        ],
      });

      const result = await runScheduledRebuild(clients, NOW);

      expect(result.outcome).toBe("failed");
      expect(result.dryRun).toBe(true);
      expect(promoteCalls).toHaveLength(0);
      const finishedRun = runRows().find((r) => r.id === result.runId);
      expect(finishedRun).toMatchObject({ status: "failed", step: "gap_check" });
    });

    it("a resumed run (promotion already happened on an earlier run) is never itself a dry run, even with allowPromotion omitted", async () => {
      const { clients, promoteCalls, runRows } = makeMockClients({
        existingRunRows: [
          {
            id: "old-run",
            started_at: "2026-10-01T00:00:00Z",
            completed_at: "2026-10-01T01:00:00Z",
            stable_identity: "7c2e-uany",
            staging_identity: "7c2e-uany-staging-OLD",
            backup_identity: "7c2e-uany-backup-OLD",
            step: "verifying",
            status: "failed",
            gap_detected: false,
            failure_reason: "some stale rows found",
          },
        ],
        existingBucketRows: [
          { archive_dataset_id: "7c2e-uany", blockface_id: "blockface-1", iso_day: 2, hour: 14, count: 100, total_weight: 80, mean: 0.4, sum_squared_diff: 2 },
        ],
      });

      const result = await runScheduledRebuild(clients, NOW);

      expect(result.dryRun).toBe(false);
      expect(result.outcome).toBe("succeeded");
      expect(promoteCalls).toHaveLength(0);
      const newRun = runRows().find((r) => r.id === result.runId);
      expect(newRun).toMatchObject({ dry_run: false });
    });
  });
});
