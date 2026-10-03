import { describe, expect, it } from "vitest";
import {
  advanceRebuildRunStep,
  decideResumeAction,
  fetchLatestRebuildRun,
  finishRebuildRun,
  startRebuildRun,
  type RebuildRun,
  type ScheduledRebuildRunsSupabaseClient,
} from "./scheduledRebuildRunsLog.ts";

function makeMockClient(rows: Record<string, unknown>[]) {
  const updateCalls: { values: Record<string, unknown>; id: string }[] = [];
  const insertCalls: Record<string, unknown>[] = [];

  const client: ScheduledRebuildRunsSupabaseClient = {
    from: () => ({
      select: () => {
        let filterStableIdentity: string | undefined;
        const builder = {
          eq: (_column: string, value: string) => {
            filterStableIdentity = value;
            return builder;
          },
          order: () => builder,
          limit: async (count: number) => {
            const filtered = rows.filter((r) => r.stable_identity === filterStableIdentity).sort((a, b) => (b.started_at as string).localeCompare(a.started_at as string));
            return { data: filtered.slice(0, count), error: null };
          },
        };
        return builder;
      },
      insert: (values: Record<string, unknown>) => {
        insertCalls.push(values);
        return {
          select: () => ({
            single: async () => ({ data: { id: "new-run-id" }, error: null }),
          }),
        };
      },
      update: (values: Record<string, unknown>) => ({
        eq: async (_column: string, id: string) => {
          updateCalls.push({ values, id });
          return { data: null, error: null };
        },
      }),
    }),
  } as unknown as ScheduledRebuildRunsSupabaseClient;

  return { client, updateCalls, insertCalls };
}

describe("fetchLatestRebuildRun", () => {
  it("returns null when no run has ever been recorded for this stable identity", async () => {
    const { client } = makeMockClient([]);
    expect(await fetchLatestRebuildRun(client, "7c2e-uany")).toBeNull();
  });

  it("returns the most recently started real run for this stable identity", async () => {
    const { client } = makeMockClient([
      { id: "run-1", started_at: "2026-10-01T00:00:00Z", completed_at: "2026-10-01T01:00:00Z", stable_identity: "7c2e-uany", staging_identity: "s1", backup_identity: null, step: "done", status: "succeeded", gap_detected: false, failure_reason: null },
      { id: "run-2", started_at: "2026-10-08T00:00:00Z", completed_at: null, stable_identity: "7c2e-uany", staging_identity: "s2", backup_identity: null, step: "streaming_rolling_window", status: "running", gap_detected: null, failure_reason: null },
      { id: "run-other", started_at: "2026-10-09T00:00:00Z", completed_at: null, stable_identity: "other-identity", staging_identity: "s3", backup_identity: null, step: "streaming_archive", status: "running", gap_detected: null, failure_reason: null },
    ]);

    const result = await fetchLatestRebuildRun(client, "7c2e-uany");

    expect(result?.id).toBe("run-2");
  });
});

describe("startRebuildRun / advanceRebuildRunStep / finishRebuildRun", () => {
  it("inserts a real, running row at step streaming_archive", async () => {
    const { client, insertCalls } = makeMockClient([]);
    const id = await startRebuildRun(client, { stableIdentity: "7c2e-uany", stagingIdentity: "7c2e-uany-staging-123", startedAt: new Date("2026-10-08T00:00:00Z") });

    expect(id).toBe("new-run-id");
    expect(insertCalls[0]).toMatchObject({ stable_identity: "7c2e-uany", staging_identity: "7c2e-uany-staging-123", step: "streaming_archive", status: "running" });
  });

  it("supports starting a resumed run directly at 'reconciling' with its backupIdentity recorded", async () => {
    const { client, insertCalls } = makeMockClient([]);
    await startRebuildRun(client, {
      stableIdentity: "7c2e-uany",
      stagingIdentity: "7c2e-uany-staging-OLD",
      startedAt: new Date("2026-10-08T00:00:00Z"),
      startStep: "reconciling",
      backupIdentity: "7c2e-uany-backup-OLD",
    });
    expect(insertCalls[0]).toMatchObject({ step: "reconciling", backup_identity: "7c2e-uany-backup-OLD" });
  });

  it("advanceRebuildRunStep updates only the step by default", async () => {
    const { client, updateCalls } = makeMockClient([]);
    await advanceRebuildRunStep(client, "run-1", "gap_check");
    expect(updateCalls[0]).toEqual({ values: { step: "gap_check" }, id: "run-1" });
  });

  it("advanceRebuildRunStep records backupIdentity/gapDetected when provided", async () => {
    const { client, updateCalls } = makeMockClient([]);
    await advanceRebuildRunStep(client, "run-1", "promoting", { backupIdentity: "7c2e-uany-backup-123", gapDetected: false });
    expect(updateCalls[0]).toEqual({ values: { step: "promoting", backup_identity: "7c2e-uany-backup-123", gap_detected: false }, id: "run-1" });
  });

  it("finishRebuildRun records a real success with step=done", async () => {
    const { client, updateCalls } = makeMockClient([]);
    await finishRebuildRun(client, "run-1", { status: "succeeded" }, new Date("2026-10-08T02:00:00Z"));
    expect(updateCalls[0]).toEqual({ values: { status: "succeeded", completed_at: "2026-10-08T02:00:00.000Z", step: "done" }, id: "run-1" });
  });

  it("finishRebuildRun records a real failure reason, without forcing step to done", async () => {
    const { client, updateCalls } = makeMockClient([]);
    await finishRebuildRun(client, "run-1", { status: "failed", failureReason: "gap detected" }, new Date("2026-10-08T02:00:00Z"));
    expect(updateCalls[0]).toEqual({ values: { status: "failed", completed_at: "2026-10-08T02:00:00.000Z", failure_reason: "gap detected" }, id: "run-1" });
  });
});

function run(overrides: Partial<RebuildRun>): RebuildRun {
  return {
    id: "run-1",
    startedAt: "2026-10-01T00:00:00Z",
    completedAt: "2026-10-01T01:00:00Z",
    stableIdentity: "7c2e-uany",
    stagingIdentity: "7c2e-uany-staging-1",
    backupIdentity: null,
    step: "done",
    status: "succeeded",
    gapDetected: false,
    failureReason: null,
    ...overrides,
  };
}

describe("decideResumeAction", () => {
  it("starts fresh when there is no previous run at all", () => {
    expect(decideResumeAction(null)).toEqual({ action: "start_fresh" });
  });

  it("starts fresh when the previous run succeeded", () => {
    expect(decideResumeAction(run({ status: "succeeded" }))).toEqual({ action: "start_fresh" });
  });

  it("starts fresh when the previous run failed BEFORE promotion ever happened -- the live identity was never touched", () => {
    for (const step of ["streaming_archive", "streaming_rolling_window", "gap_check", "integrity_check"] as const) {
      expect(decideResumeAction(run({ status: "failed", step, backupIdentity: null }))).toEqual({ action: "start_fresh" });
    }
  });

  it("resumes from reconcile when the previous run failed AFTER promotion actually happened", () => {
    const result = decideResumeAction(run({ status: "failed", step: "reconciling", backupIdentity: "7c2e-uany-backup-1" }));
    expect(result).toEqual({ action: "resume_from_reconcile", stableIdentity: "7c2e-uany", backupIdentity: "7c2e-uany-backup-1" });
  });

  it("resumes from reconcile when the previous run failed at the verifying step", () => {
    const result = decideResumeAction(run({ status: "failed", step: "verifying", backupIdentity: "7c2e-uany-backup-1" }));
    expect(result).toEqual({ action: "resume_from_reconcile", stableIdentity: "7c2e-uany", backupIdentity: "7c2e-uany-backup-1" });
  });

  it("falls back to start_fresh for a structurally inconsistent row (promoted step, but no backupIdentity recorded)", () => {
    expect(decideResumeAction(run({ status: "failed", step: "reconciling", backupIdentity: null }))).toEqual({ action: "start_fresh" });
  });
});
