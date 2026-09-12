import { buildRequestHeaders } from "../utils/fetchSocrataRecords.ts";
import type { SupabaseQueryResult } from "../importers/upsertBlockface.ts";

// Detects and durably records a real, live-confirmed failure mode:
// rke9-rsvs (Seattle's current-year Paid Parking Occupancy dataset) is a
// genuine EVICTING rolling window, not merely an append-only growing one
// -- live-verified directly (2026-09-12): its own earliest available row
// moved forward ~51 minutes over just ~62 real minutes between two
// checks, with real row count dropping in that same short window even
// while its latest edge stayed frozen. See migrations/023's own header
// comment for the full investigation.
//
// The core insight this module encodes: each refresh does a full,
// unfiltered pull of the ENTIRE current window (never an incremental
// delta -- see stream-into-staging.ts), so one run's own
// [earliestCovered, latestCovered] represents everything that existed in
// the real source at that exact moment. A reading can only be
// permanently missed across two runs if there's a genuine GAP in time
// between what an earlier run covered and what a later run covers --
// i.e. the later run's earliest is strictly AFTER the earlier run's
// latest. If the later run's earliest is at or before the earlier run's
// latest, the two windows overlap or touch, and every possible timestamp
// in between was covered by at least one of them.

export interface RollingWindowCoverage {
  // Raw, naive "YYYY-MM-DDTHH:mm:ss[.sss]" strings, exactly as Socrata's
  // occupancydatetime field returns them -- see migrations/023's own
  // comment for why these are compared as plain text, not parsed into
  // Date/timestamptz.
  earliestCovered: string;
  latestCovered: string;
  rowCount: number;
}

export interface GapCheckResult {
  gapDetected: boolean;
  gapDetail: string | null;
}

// Pure, no I/O -- the one function this whole module exists to get right,
// so it's isolated and directly testable against synthetic coverage
// values, independent of any real Socrata/Supabase call.
//
// previous === null (no prior refresh recorded for this archive_dataset_id
// yet) is never a gap -- there's nothing to compare against; the current
// run simply establishes the first baseline.
export function detectCoverageGap(previous: RollingWindowCoverage | null, current: RollingWindowCoverage): GapCheckResult {
  if (previous === null) {
    return { gapDetected: false, gapDetail: null };
  }
  if (current.earliestCovered > previous.latestCovered) {
    return {
      gapDetected: true,
      gapDetail: `Rolling window gap detected: the previous refresh's coverage ended at "${previous.latestCovered}", but this refresh's coverage only starts at "${current.earliestCovered}" -- readings with occupancydatetime strictly between those two values may have been evicted before either refresh captured them.`,
    };
  }
  return { gapDetected: false, gapDetail: null };
}

// --- Fetching real, current coverage from Socrata --------------------------

interface RawCoverageRow {
  earliest?: string;
  latest?: string;
  row_count?: string;
}

// Queries a Socrata dataset's own real, current min/max(occupancydatetime)
// and row count -- the same aggregate query used throughout this
// project's own live investigations, promoted here to a real, reusable,
// tested function rather than an ad hoc one-off.
export async function fetchCurrentCoverage(datasetUrl: string): Promise<RollingWindowCoverage> {
  const url = new URL(datasetUrl);
  url.searchParams.set("$select", "min(occupancydatetime) as earliest, max(occupancydatetime) as latest, count(*) as row_count");

  const response = await fetch(url.toString(), { headers: buildRequestHeaders() });
  if (!response.ok) {
    throw new Error(`fetchCurrentCoverage: request to ${url.toString()} failed with status ${response.status} ${response.statusText}`);
  }

  const body: unknown = await response.json();
  if (!Array.isArray(body) || body.length === 0) {
    throw new Error(`fetchCurrentCoverage: unexpected response shape (expected a non-empty JSON array), got ${JSON.stringify(body)}`);
  }
  const row = body[0] as RawCoverageRow;
  if (typeof row.earliest !== "string" || typeof row.latest !== "string" || typeof row.row_count !== "string") {
    throw new Error(`fetchCurrentCoverage: unexpected row shape, got ${JSON.stringify(row)}`);
  }
  const rowCount = Number(row.row_count);
  if (!Number.isFinite(rowCount)) {
    throw new Error(`fetchCurrentCoverage: row_count is not a valid number, got "${row.row_count}"`);
  }

  return { earliestCovered: row.earliest, latestCovered: row.latest, rowCount };
}

// --- rolling_window_refresh_log read/write ----------------------------

interface RollingWindowRefreshLogRow {
  earliest_covered: string;
  latest_covered: string;
  row_count: number;
}

export interface RollingWindowRefreshLogQueryBuilder extends PromiseLike<SupabaseQueryResult<RollingWindowRefreshLogRow[]>> {
  eq(column: string, value: string): RollingWindowRefreshLogQueryBuilder;
  order(column: string, options: { ascending: boolean }): RollingWindowRefreshLogQueryBuilder;
  limit(count: number): PromiseLike<SupabaseQueryResult<RollingWindowRefreshLogRow[]>>;
}

export interface RollingWindowRefreshLogSupabaseTableBuilder {
  select(columns: string): RollingWindowRefreshLogQueryBuilder;
  insert(values: Record<string, unknown>): PromiseLike<SupabaseQueryResult>;
}

export interface RollingWindowRefreshLogSupabaseClient {
  from(table: string): RollingWindowRefreshLogSupabaseTableBuilder;
}

// Fetches the most recently recorded refresh's coverage for a given
// archive_dataset_id -- the "previous" input detectCoverageGap compares
// against. null when this is genuinely the first refresh ever recorded
// for this dataset id (see detectCoverageGap's own comment on why that's
// not a gap).
export async function fetchLatestRefreshLogEntry(
  client: RollingWindowRefreshLogSupabaseClient,
  archiveDatasetId: string,
): Promise<RollingWindowCoverage | null> {
  const { data, error } = await client
    .from("rolling_window_refresh_log")
    .select("earliest_covered, latest_covered, row_count")
    .eq("archive_dataset_id", archiveDatasetId)
    .order("checked_at", { ascending: false })
    .limit(1);

  if (error !== null) {
    throw new Error(`fetchLatestRefreshLogEntry: reading rolling_window_refresh_log failed: ${error.message}`);
  }
  const row = (data ?? [])[0];
  if (row === undefined) {
    return null;
  }
  return { earliestCovered: row.earliest_covered, latestCovered: row.latest_covered, rowCount: row.row_count };
}

// Durably records one refresh's real observed coverage and gap-check
// result -- append-only (see migrations/023's own comment), never
// upserted, so this table stays a genuine audit trail.
export async function recordRefreshLogEntry(
  client: RollingWindowRefreshLogSupabaseClient,
  archiveDatasetId: string,
  coverage: RollingWindowCoverage,
  gapResult: GapCheckResult,
  now: Date,
): Promise<void> {
  const { error } = await client.from("rolling_window_refresh_log").insert({
    archive_dataset_id: archiveDatasetId,
    checked_at: now.toISOString(),
    earliest_covered: coverage.earliestCovered,
    latest_covered: coverage.latestCovered,
    row_count: coverage.rowCount,
    gap_detected: gapResult.gapDetected,
    gap_detail: gapResult.gapDetail,
  });
  if (error !== null) {
    throw new Error(`recordRefreshLogEntry: writing rolling_window_refresh_log failed: ${error.message}`);
  }
}

// --- Orchestration: check, then record ------------------------------------

export interface CheckAndRecordResult {
  coverage: RollingWindowCoverage;
  gapResult: GapCheckResult;
}

// The real entry point a refresh script calls: fetch this run's real
// current coverage, compare it against the last recorded run, record the
// outcome either way (so the audit trail is complete regardless of
// whether a gap was found), and return both pieces so the caller can
// decide how to react (e.g. abort before promoting, on a real gap).
export async function checkAndRecordCoverage(
  client: RollingWindowRefreshLogSupabaseClient,
  datasetUrl: string,
  archiveDatasetId: string,
  now: Date,
): Promise<CheckAndRecordResult> {
  const [coverage, previous] = await Promise.all([
    fetchCurrentCoverage(datasetUrl),
    fetchLatestRefreshLogEntry(client, archiveDatasetId),
  ]);

  const gapResult = detectCoverageGap(previous, coverage);
  await recordRefreshLogEntry(client, archiveDatasetId, coverage, gapResult, now);

  return { coverage, gapResult };
}
