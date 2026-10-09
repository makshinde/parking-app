import type { SupabaseQueryResult } from "../importers/upsertBlockface.ts";

// Durable read/write for rolling_window_fold_ledger (migrations/030) --
// the real record of which calendar days have already been decided about
// for a given logical rolling window, so a catch-up or weekly fold never
// re-folds a day twice and a confirmed-permanent gap is recorded
// explicitly rather than silently absent.

export type FoldLedgerStatus = "folded" | "permanent_gap" | "low_volume";

export interface FoldLedgerEntry {
  date: string; // "YYYY-MM-DD"
  sourceDatasetId: string | null;
  rowCountAtFold: number | null;
  foldedAt: string;
  status: FoldLedgerStatus;
}

interface RawFoldLedgerRow {
  date: string;
  source_dataset_id: string | null;
  row_count_at_fold: number | null;
  folded_at: string;
  status: FoldLedgerStatus;
}

export interface RollingWindowFoldLedgerQueryBuilder extends PromiseLike<SupabaseQueryResult<RawFoldLedgerRow[]>> {
  eq(column: string, value: string): RollingWindowFoldLedgerQueryBuilder;
}

export interface RollingWindowFoldLedgerSupabaseTableBuilder {
  select(columns: string): RollingWindowFoldLedgerQueryBuilder;
  insert(values: Record<string, unknown>): PromiseLike<SupabaseQueryResult>;
}

export interface RollingWindowFoldLedgerSupabaseClient {
  from(table: string): RollingWindowFoldLedgerSupabaseTableBuilder;
}

// Every real date this logical window has EVER recorded a decision for,
// regardless of status -- 'folded', 'permanent_gap', and 'low_volume' are
// all terminal, never-retried outcomes (see migrations/030's own comment:
// a low_volume day was still genuinely folded, just flagged; retrying it
// later wouldn't change what the source actually held that day).
export async function fetchLedgeredDates(client: RollingWindowFoldLedgerSupabaseClient, logicalWindow: string): Promise<Map<string, FoldLedgerEntry>> {
  const { data, error } = await client
    .from("rolling_window_fold_ledger")
    .select("date, source_dataset_id, row_count_at_fold, folded_at, status")
    .eq("logical_window", logicalWindow);

  if (error !== null) {
    throw new Error(`fetchLedgeredDates: reading rolling_window_fold_ledger failed: ${error.message}`);
  }

  const entries = new Map<string, FoldLedgerEntry>();
  for (const row of data ?? []) {
    entries.set(row.date, {
      date: row.date,
      sourceDatasetId: row.source_dataset_id,
      rowCountAtFold: row.row_count_at_fold,
      foldedAt: row.folded_at,
      status: row.status,
    });
  }
  return entries;
}

export async function recordLedgerEntry(
  client: RollingWindowFoldLedgerSupabaseClient,
  params: { logicalWindow: string; date: string; sourceDatasetId: string | null; rowCountAtFold: number | null; status: FoldLedgerStatus; foldedAt: Date },
): Promise<void> {
  const { error } = await client.from("rolling_window_fold_ledger").insert({
    logical_window: params.logicalWindow,
    date: params.date,
    source_dataset_id: params.sourceDatasetId,
    row_count_at_fold: params.rowCountAtFold,
    status: params.status,
    folded_at: params.foldedAt.toISOString(),
  });
  if (error !== null) {
    throw new Error(`recordLedgerEntry: writing rolling_window_fold_ledger failed for date=${params.date}: ${error.message}`);
  }
}

// --- Pure date-range helpers -------------------------------------------

// ISO "YYYY-MM-DD" strings throughout -- calendar days, not instants, same
// reasoning as rolling_window_refresh_log's own naive-string comparisons.
export function enumerateDates(startIsoDate: string, endIsoDateExclusive: string): string[] {
  const dates: string[] = [];
  let cursor = new Date(`${startIsoDate}T00:00:00Z`);
  const end = new Date(`${endIsoDateExclusive}T00:00:00Z`);
  while (cursor < end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return dates;
}

// The pinned upper bound for a run: the most recent calendar day that is
// at least minAgeDays old as of `now`. Pinned ONCE at run start and never
// re-evaluated mid-run, so a long-running catch-up's notion of "old
// enough" can't creep forward while it's still working through earlier
// days.
export function computeUpperBoundDate(now: Date, minAgeDays: number): string {
  const cutoff = new Date(now.getTime() - minAgeDays * 24 * 60 * 60 * 1000);
  return cutoff.toISOString().slice(0, 10);
}
