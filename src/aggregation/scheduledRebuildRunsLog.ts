import type { SupabaseQueryResult } from "../importers/upsertBlockface.ts";

// Durable read/write for scheduled_rebuild_runs (migrations/027) -- the
// same "log real state to Supabase, don't rely on external logs alone"
// convention as rollingWindowRefreshLog.ts and occupancy_stats_backfill_progress.

export type RebuildStep =
  | "streaming_archive"
  | "streaming_rolling_window"
  | "gap_check"
  | "integrity_check"
  | "promoting"
  | "reconciling"
  | "verifying"
  | "done"
  // A dry run's own distinct terminal step (migrations/029) -- stopped on
  // purpose right after the integrity check, with promotion never
  // attempted. Deliberately not reused with "done": "done" means a real
  // promotion genuinely happened, which must never be conflated with a
  // dry run that only checked.
  | "dry_run_complete";

export type RebuildStatus = "running" | "succeeded" | "failed";

export interface RebuildRun {
  id: string;
  startedAt: string;
  completedAt: string | null;
  stableIdentity: string;
  stagingIdentity: string;
  backupIdentity: string | null;
  step: RebuildStep;
  status: RebuildStatus;
  gapDetected: boolean | null;
  failureReason: string | null;
  dryRun: boolean;
}

interface RawRebuildRunRow {
  id: string;
  started_at: string;
  completed_at: string | null;
  stable_identity: string;
  staging_identity: string;
  backup_identity: string | null;
  step: RebuildStep;
  status: RebuildStatus;
  gap_detected: boolean | null;
  failure_reason: string | null;
  dry_run: boolean;
}

function fromRow(row: RawRebuildRunRow): RebuildRun {
  return {
    id: row.id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    stableIdentity: row.stable_identity,
    stagingIdentity: row.staging_identity,
    backupIdentity: row.backup_identity,
    step: row.step,
    status: row.status,
    gapDetected: row.gap_detected,
    failureReason: row.failure_reason,
    dryRun: row.dry_run,
  };
}

export interface ScheduledRebuildRunsQueryBuilder extends PromiseLike<SupabaseQueryResult<RawRebuildRunRow[]>> {
  eq(column: string, value: string): ScheduledRebuildRunsQueryBuilder;
  order(column: string, options: { ascending: boolean }): ScheduledRebuildRunsQueryBuilder;
  limit(count: number): PromiseLike<SupabaseQueryResult<RawRebuildRunRow[]>>;
}

export interface ScheduledRebuildRunsUpdateBuilder {
  eq(column: string, value: string): PromiseLike<SupabaseQueryResult>;
}

export interface ScheduledRebuildRunsSupabaseTableBuilder {
  select(columns: string): ScheduledRebuildRunsQueryBuilder;
  insert(values: Record<string, unknown>): {
    select(columns: string): { single(): PromiseLike<SupabaseQueryResult<RawRebuildRunRow>> };
  };
  update(values: Record<string, unknown>): ScheduledRebuildRunsUpdateBuilder;
}

export interface ScheduledRebuildRunsSupabaseClient {
  from(table: string): ScheduledRebuildRunsSupabaseTableBuilder;
}

// The most recently started run for this stable_identity, regardless of
// outcome -- the orchestrator's own resume logic (see scheduled-rebuild.ts)
// decides what to do with a "running" (crashed mid-run, never got a final
// status) or "failed" row; this function itself makes no such judgment.
export async function fetchLatestRebuildRun(client: ScheduledRebuildRunsSupabaseClient, stableIdentity: string): Promise<RebuildRun | null> {
  const { data, error } = await client
    .from("scheduled_rebuild_runs")
    .select("id, started_at, completed_at, stable_identity, staging_identity, backup_identity, step, status, gap_detected, failure_reason, dry_run")
    .eq("stable_identity", stableIdentity)
    .order("started_at", { ascending: false })
    .limit(1);

  if (error !== null) {
    throw new Error(`fetchLatestRebuildRun: reading scheduled_rebuild_runs failed: ${error.message}`);
  }
  const row = (data ?? [])[0];
  return row === undefined ? null : fromRow(row);
}

export async function startRebuildRun(
  client: ScheduledRebuildRunsSupabaseClient,
  params: {
    stableIdentity: string;
    stagingIdentity: string;
    startedAt: Date;
    // Defaults to the real beginning of the pipeline. A resumed run (see
    // decideResumeAction) starts its own, new, separately-auditable row
    // already at "reconciling" -- promotion already genuinely happened on
    // the earlier, failed run; this new row just picks up from there, it
    // never re-streams or re-promotes.
    startStep?: RebuildStep;
    backupIdentity?: string;
    // Defaults to false (a real, promotion-eligible attempt) -- a dry run
    // sets this true for the whole lifetime of the row, so the audit
    // trail never has to infer dry-run-ness from step alone.
    dryRun?: boolean;
  },
): Promise<string> {
  const { data, error } = await client
    .from("scheduled_rebuild_runs")
    .insert({
      started_at: params.startedAt.toISOString(),
      stable_identity: params.stableIdentity,
      staging_identity: params.stagingIdentity,
      backup_identity: params.backupIdentity ?? null,
      step: params.startStep ?? "streaming_archive",
      status: "running",
      dry_run: params.dryRun ?? false,
    })
    .select("id")
    .single();

  if (error !== null) {
    throw new Error(`startRebuildRun: inserting scheduled_rebuild_runs failed: ${error.message}`);
  }
  if (data === null) {
    throw new Error("startRebuildRun: insert succeeded but returned no row");
  }
  return data.id;
}

// Advances a run's step without changing its status -- called after each
// stage of the pipeline completes, so a crash immediately afterward still
// leaves an accurate record of how far the run actually got.
export async function advanceRebuildRunStep(
  client: ScheduledRebuildRunsSupabaseClient,
  runId: string,
  step: RebuildStep,
  extra: { backupIdentity?: string; gapDetected?: boolean } = {},
): Promise<void> {
  const values: Record<string, unknown> = { step };
  if (extra.backupIdentity !== undefined) values.backup_identity = extra.backupIdentity;
  if (extra.gapDetected !== undefined) values.gap_detected = extra.gapDetected;

  const { error } = await client.from("scheduled_rebuild_runs").update(values).eq("id", runId);
  if (error !== null) {
    throw new Error(`advanceRebuildRunStep: updating scheduled_rebuild_runs failed: ${error.message}`);
  }
}

export async function finishRebuildRun(
  client: ScheduledRebuildRunsSupabaseClient,
  runId: string,
  // step defaults to "done" for a real success -- pass "dry_run_complete"
  // explicitly for a dry run's own terminal state, so it's never confused
  // with a genuine promotion.
  outcome: { status: "succeeded"; step?: RebuildStep } | { status: "failed"; failureReason: string },
  completedAt: Date,
): Promise<void> {
  const values: Record<string, unknown> = {
    status: outcome.status,
    completed_at: completedAt.toISOString(),
  };
  if (outcome.status === "failed") {
    values.failure_reason = outcome.failureReason;
  }
  if (outcome.status === "succeeded") {
    values.step = outcome.step ?? "done";
  }

  const { error } = await client.from("scheduled_rebuild_runs").update(values).eq("id", runId);
  if (error !== null) {
    throw new Error(`finishRebuildRun: updating scheduled_rebuild_runs failed: ${error.message}`);
  }
}

// --- Pure resume decision ---------------------------------------------------

export type ResumeDecision =
  | { action: "start_fresh" }
  // stableIdentity here is the SAME name the live identity already has --
  // the prior run's promote step already renamed staging -> stable for
  // real, so resuming means reconciling against that name directly, never
  // re-streaming or re-promoting. backupIdentity is carried through purely
  // for the resumed run's own logging/traceability, not acted on.
  | { action: "resume_from_reconcile"; stableIdentity: string; backupIdentity: string };

// Whether the live identity was ever actually touched is the ENTIRE
// question here: step reaching "promoting" (or beyond) on the prior run
// means the rename already happened for real, so the next run must not
// start a fresh stream (which would require a second, redundant promote)
// -- it should instead pick up from reconcile against the now-current live
// identity. Anything earlier than "promoting" means the live identity is
// still exactly what it was before that run started, so starting over with
// a brand new staging identity is always safe.
const STEPS_AFTER_PROMOTION: readonly RebuildStep[] = ["promoting", "reconciling", "verifying", "done"];

export function decideResumeAction(previousRun: RebuildRun | null): ResumeDecision {
  if (previousRun === null || previousRun.status !== "failed") {
    return { action: "start_fresh" };
  }
  if (!STEPS_AFTER_PROMOTION.includes(previousRun.step)) {
    return { action: "start_fresh" };
  }
  if (previousRun.backupIdentity === null) {
    // Defensive: step says promotion happened, but no backup identity was
    // ever recorded -- a structurally inconsistent row (should be
    // impossible given advanceRebuildRunStep always sets backupIdentity
    // before moving to "promoting"), safer to start fresh than to guess.
    return { action: "start_fresh" };
  }
  return { action: "resume_from_reconcile", stableIdentity: previousRun.stableIdentity, backupIdentity: previousRun.backupIdentity };
}
