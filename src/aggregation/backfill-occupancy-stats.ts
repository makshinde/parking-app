import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import { fetchSocrataRecords, type SocrataRecord } from "../utils/fetchSocrataRecords.ts";
import type { SupabaseQueryResult } from "../importers/upsertBlockface.ts";
import { resolveYearlyArchiveDatasetId, getPriorYear } from "./resolveYearlyArchive.ts";
import { isoDayToSocrataDow } from "./isoDayToSocrataDow.ts";
import {
  buildBlockfaceLookup,
  extractIsoDayAndHour,
  type RawReading,
  type BlockfaceLookupSupabaseClient,
} from "./blockfaceLookup.ts";
import { groupReadingsByBlockface } from "./groupReadingsByBlockface.ts";
import { decideBucketStats, type BucketStats } from "./decideBucketStats.ts";
import { upsertOccupancyStats, type OccupancyStatsSupabaseClient } from "./upsertOccupancyStats.ts";

// The current, not-yet-archived Paid Parking Occupancy dataset (see
// CLAUDE.md's Architecture section) -- unlike wtpb-jp8d/7c2e-uany (full,
// closed calendar years), this one keeps growing, so for the full run it's
// fetched in a single bulk pull rather than one per-bucket query per
// combination (see partitionByBucket's comment for why). A --combo test
// run instead fetches only that one bucket's slice (see
// buildRollingBucketsForCombo).
const ROLLING_WINDOW_DATASET_ID = "rke9-rsvs";
const SOCRATA_BASE_URL = "https://data.seattle.gov/resource";

function buildSocrataDatasetUrl(datasetId: string): string {
  return `${SOCRATA_BASE_URL}/${datasetId}.json`;
}

export interface BucketCombo {
  isoDay: number;
  hour: number;
}

export function bucketComboKey(combo: BucketCombo): string {
  return `${combo.isoDay}:${combo.hour}`;
}

export interface OperatingHourRange {
  startHour: number;
  endHour: number;
}

export function buildAllBucketCombos(hourRange: OperatingHourRange): BucketCombo[] {
  const combos: BucketCombo[] = [];
  for (let isoDay = 1; isoDay <= 7; isoDay++) {
    for (let hour = hourRange.startHour; hour <= hourRange.endHour; hour++) {
      combos.push({ isoDay, hour });
    }
  }
  return combos;
}

// --- Operating hour range (derived from blockfaces, not hardcoded) --------

// blockfaces rows created for UNPAID_CONFIRMED/DATA_GAP elements with no
// genuine posted schedule default to this exact pair (schema.sql), not a
// real observed start/end -- excluded via De Morgan's law (NOT(start=00:00
// AND end=23:59) == start<>00:00 OR end<>23:59), since this Supabase
// project has aggregate functions disabled (PGRST123 on MIN()/MAX()), so
// .or() combined with .neq() is what's actually available server-side.
const EXCLUDE_PLACEHOLDER_HOURS_FILTER = "operating_hours_start.neq.00:00,operating_hours_end.neq.23:59";

function parseHourComponent(time: string): number {
  const match = /^(\d{2}):/.exec(time);
  if (match === null || match[1] === undefined) {
    throw new Error(`parseHourComponent: unexpected time format "${time}"`);
  }
  return Number(match[1]);
}

export interface OperatingHoursSupabaseTableBuilder {
  select(columns: string): {
    or(filter: string): {
      order(column: string, options: { ascending: boolean }): {
        limit(count: number): PromiseLike<SupabaseQueryResult<Record<string, string>[]>>;
      };
    };
  };
}

export interface OperatingHoursSupabaseClient {
  from(table: string): OperatingHoursSupabaseTableBuilder;
}

// Derives the real operating-hour envelope from blockfaces' own posted
// schedules, live-verified against the real database (2792 rows total,
// 1251 carrying the placeholder pair, 1541 with a genuine schedule): every
// genuine row starts at exactly 08:00, but the latest genuine end time is
// 21:59 -- later than an earlier hardcoded assumption (8am-9pm) based only
// on where historical readings happened to cluster, not on blockfaces' own
// posted hours. Queried with order+limit=1 rather than MIN()/MAX() since
// aggregate functions are disabled on this Supabase project.
export async function fetchOperatingHourRange(client: OperatingHoursSupabaseClient): Promise<OperatingHourRange> {
  const { data: minStartRows, error: minStartError } = await client
    .from("blockfaces")
    .select("operating_hours_start")
    .or(EXCLUDE_PLACEHOLDER_HOURS_FILTER)
    .order("operating_hours_start", { ascending: true })
    .limit(1);

  if (minStartError !== null) {
    throw new Error(`backfill-occupancy-stats: reading blockfaces' minimum operating_hours_start failed: ${minStartError.message}`);
  }

  const { data: maxEndRows, error: maxEndError } = await client
    .from("blockfaces")
    .select("operating_hours_end")
    .or(EXCLUDE_PLACEHOLDER_HOURS_FILTER)
    .order("operating_hours_end", { ascending: false })
    .limit(1);

  if (maxEndError !== null) {
    throw new Error(`backfill-occupancy-stats: reading blockfaces' maximum operating_hours_end failed: ${maxEndError.message}`);
  }

  const minStart = minStartRows?.[0]?.operating_hours_start;
  const maxEnd = maxEndRows?.[0]?.operating_hours_end;
  if (minStart === undefined || maxEnd === undefined) {
    // No meaningful envelope to derive without at least one genuine
    // (non-placeholder) schedule -- there's no sensible default to fall
    // back to here (a hardcoded guess is exactly what this function exists
    // to replace), so this throws rather than silently picking one.
    throw new Error(
      "backfill-occupancy-stats: no blockfaces rows have a genuine (non-placeholder) operating-hours schedule -- cannot derive an operating-hour range",
    );
  }

  return { startHour: parseHourComponent(minStart), endHour: parseHourComponent(maxEnd) };
}

// --- CLI options --------------------------------------------------------

export interface CliOptions {
  combo: BucketCombo | null;
}

// --combo is a discrete, categorical value (a specific bucket, not an
// estimate), so a malformed or out-of-range value throws rather than being
// clamped or silently ignored, same reasoning jsDayToIsoDay/isoDayToSocrataDow
// use for day-of-week.
export function parseCliOptions(argv: string[]): CliOptions {
  for (const arg of argv) {
    if (!arg.startsWith("--combo=")) {
      continue;
    }
    const rawValue = arg.slice("--combo=".length);
    const match = /^(-?\d+):(-?\d+)$/.exec(rawValue);
    if (match === null) {
      throw new Error(`backfill-occupancy-stats: --combo must be in the form <isoDay>:<hour>, got "${rawValue}"`);
    }
    const [, rawIsoDay, rawHour] = match;
    const isoDay = Number(rawIsoDay);
    const hour = Number(rawHour);
    if (!Number.isInteger(isoDay) || isoDay < 1 || isoDay > 7) {
      throw new Error(`backfill-occupancy-stats: --combo's day must be an integer 1-7 (ISO day-of-week), got "${rawIsoDay}"`);
    }
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw new Error(`backfill-occupancy-stats: --combo's hour must be an integer 0-23, got "${rawHour}"`);
    }
    return { combo: { isoDay, hour } };
  }

  return { combo: null };
}

// --- Archive query construction -----------------------------------------

// Socrata's date_extract_dow/date_extract_hh server-side filtering,
// live-verified to work correctly (see CLAUDE.md's Architecture section) --
// isoDayToSocrataDow converts this project's ISO day-of-week into Socrata's
// own 0=Sunday..6=Saturday convention before building the filter.
export function buildBucketWhereClause(combo: BucketCombo): string {
  const socrataDow = isoDayToSocrataDow(combo.isoDay);
  return `date_extract_dow(occupancydatetime)=${socrataDow} AND date_extract_hh(occupancydatetime)=${combo.hour}`;
}

// --- Raw record parsing ---------------------------------------------------

function getRequiredStringField(record: SocrataRecord, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`parseRawReading: missing or non-string "${field}" field, got ${JSON.stringify(value)}`);
  }
  return value;
}

// paidoccupancy, parkingspacecount, and sourceelementkey all arrive from
// Socrata as strings, not numbers (live-verified, see CLAUDE.md's Known
// open questions) -- these must be explicitly parsed before use.
function getRequiredNumericStringField(record: SocrataRecord, field: string): number {
  const raw = getRequiredStringField(record, field);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`parseRawReading: "${field}" is not a valid number, got "${raw}"`);
  }
  return parsed;
}

export function parseRawReading(record: SocrataRecord): RawReading {
  return {
    sourceElementKey: getRequiredNumericStringField(record, "sourceelementkey"),
    sideOfStreet: getRequiredStringField(record, "sideofstreet"),
    occupancyDateTime: getRequiredStringField(record, "occupancydatetime"),
    paidOccupancy: getRequiredNumericStringField(record, "paidoccupancy"),
    parkingSpaceCount: getRequiredNumericStringField(record, "parkingspacecount"),
  };
}

export interface ParseRawReadingsResult {
  readings: RawReading[];
  parseFailures: number;
}

// A single malformed record (a missing or non-numeric field) shouldn't abort
// processing of the millions of likely-well-formed rows around it -- same
// reasoning import-off-street-facilities.ts's processFeature uses to record
// a mapping failure as a skip rather than crash the whole run. Failures are
// counted, not silently dropped, so the caller can report a real total.
export function parseRawReadings(records: SocrataRecord[]): ParseRawReadingsResult {
  const readings: RawReading[] = [];
  let parseFailures = 0;

  for (const record of records) {
    try {
      readings.push(parseRawReading(record));
    } catch {
      parseFailures += 1;
    }
  }

  return { readings, parseFailures };
}

// --- Rolling window partitioning ------------------------------------------

export interface PartitionByBucketResult {
  buckets: Map<string, RawReading[]>;
  parseFailures: number;
}

// For the full run, the rolling window is fetched once in full (tens of
// millions of rows) and sorted into its buckets up front here, so each
// combination's main-loop iteration does an instant Map lookup rather than
// re-scanning the entire rolling window once per combo.
export function partitionByBucket(readings: RawReading[]): PartitionByBucketResult {
  const buckets = new Map<string, RawReading[]>();
  let parseFailures = 0;

  for (const reading of readings) {
    let bucket: { isoDay: number; hour: number };
    try {
      bucket = extractIsoDayAndHour(reading.occupancyDateTime);
    } catch {
      // Same reasoning as parseRawReadings above: one reading with an
      // unparseable occupancyDateTime shouldn't abort partitioning the rest
      // of the rolling window.
      parseFailures += 1;
      continue;
    }

    const key = bucketComboKey(bucket);
    const existing = buckets.get(key);
    if (existing === undefined) {
      buckets.set(key, [reading]);
    } else {
      existing.push(reading);
    }
  }

  return { buckets, parseFailures };
}

// For a --combo test run, fetching and partitioning the entire rolling
// window just to use one bucket out of it would be wasteful -- this
// applies the same server-side day/hour filtering used for the archive
// (buildBucketWhereClause) to the rolling window too, so a --combo test
// only pulls the one small, relevant slice from both sources. Returns the
// same shape as partitionByBucket so main() can treat both paths uniformly.
export async function buildRollingBucketsForCombo(
  combo: BucketCombo,
  fetchRollingRecords: (whereClause: string) => Promise<SocrataRecord[]>,
): Promise<PartitionByBucketResult> {
  const whereClause = buildBucketWhereClause(combo);
  const rawRecords = await fetchRollingRecords(whereClause);
  const { readings, parseFailures } = parseRawReadings(rawRecords);
  return { buckets: new Map([[bucketComboKey(combo), readings]]), parseFailures };
}

// --- Progress bookkeeping (occupancy_stats_backfill_progress) -------------

export type BackfillProgressStatus = "pending" | "in_progress" | "complete" | "failed";

export interface BackfillProgressStatusRow {
  iso_day: number;
  hour: number;
  status: string;
}

export interface BackfillProgressSupabaseTableBuilder {
  select(columns: string): PromiseLike<SupabaseQueryResult<BackfillProgressStatusRow[]>>;
  upsert(values: Record<string, unknown>, options: { onConflict: string }): PromiseLike<SupabaseQueryResult>;
}

export interface BackfillProgressSupabaseClient {
  from(table: string): BackfillProgressSupabaseTableBuilder;
}

export async function fetchProgressStatuses(client: BackfillProgressSupabaseClient): Promise<Map<string, string>> {
  const { data, error } = await client.from("occupancy_stats_backfill_progress").select("iso_day, hour, status");

  if (error !== null) {
    throw new Error(`backfill-occupancy-stats: reading occupancy_stats_backfill_progress failed: ${error.message}`);
  }

  const statuses = new Map<string, string>();
  for (const row of data ?? []) {
    statuses.set(bucketComboKey({ isoDay: row.iso_day, hour: row.hour }), row.status);
  }
  return statuses;
}

// 'complete' buckets already have a trustworthy row and are skipped.
// 'pending' (never attempted), 'in_progress' (interrupted mid-run -- see
// occupancy_stats_backfill_progress's own schema.sql comment), and 'failed'
// are all retried, not skipped, since none of them represent a finished,
// trustworthy result.
export function selectCombosToRun(allCombos: BucketCombo[], statuses: Map<string, string>): BucketCombo[] {
  return allCombos.filter((combo) => statuses.get(bucketComboKey(combo)) !== "complete");
}

export async function markComboStatus(
  client: BackfillProgressSupabaseClient,
  combo: BucketCombo,
  status: BackfillProgressStatus,
  errorMessage: string | null,
): Promise<void> {
  const row: Record<string, unknown> = {
    iso_day: combo.isoDay,
    hour: combo.hour,
    status,
    error_message: errorMessage,
  };
  if (status === "in_progress") {
    row.started_at = new Date().toISOString();
    row.completed_at = null;
  } else {
    row.completed_at = new Date().toISOString();
  }

  const { error } = await client.from("occupancy_stats_backfill_progress").upsert(row, { onConflict: "iso_day,hour" });
  if (error !== null) {
    // Progress bookkeeping is itself best-effort: the bucket's real work
    // already succeeded or failed independently of this write, so a
    // bookkeeping failure shouldn't abort the run -- just surface loudly
    // rather than fail silently.
    console.error(
      `backfill-occupancy-stats: failed to update occupancy_stats_backfill_progress for iso_day=${combo.isoDay}, hour=${combo.hour}: ${error.message}`,
    );
  }
}

// --- Failure bookkeeping (occupancy_stats_backfill_failures) --------------

export interface BackfillFailuresRow {
  id: string;
  blockface_id: string;
  iso_day: number;
  hour: number;
  mean_occupancy: number | null;
  std_dev: number | null;
  sample_count: number | null;
  error_message: string;
  retry_count: number;
}

export interface BackfillFailuresQueryBuilder extends PromiseLike<SupabaseQueryResult<BackfillFailuresRow[]>> {
  eq(column: string, value: unknown): BackfillFailuresQueryBuilder;
  maybeSingle(): PromiseLike<SupabaseQueryResult<BackfillFailuresRow>>;
}

export interface BackfillFailuresSupabaseTableBuilder {
  select(columns: string): BackfillFailuresQueryBuilder;
  upsert(values: Record<string, unknown>, options: { onConflict: string }): PromiseLike<SupabaseQueryResult>;
  delete(): { eq(column: string, value: unknown): PromiseLike<SupabaseQueryResult> };
}

export interface BackfillFailuresSupabaseClient {
  from(table: string): BackfillFailuresSupabaseTableBuilder;
}

export interface BlockfaceFailureContext {
  blockfaceId: string;
  isoDay: number;
  hour: number;
  stats: BucketStats | null;
  errorMessage: string;
}

// Logs one blockface/bucket's occupancy_stats write failure durably,
// upserting on (blockface_id, iso_day, hour) and incrementing retry_count
// when a row for this bucket already exists (e.g. a prior run already
// logged this same failure) rather than accumulating duplicates.
export async function logBucketFailure(client: BackfillFailuresSupabaseClient, context: BlockfaceFailureContext): Promise<void> {
  const { data: existing, error: selectError } = await client
    .from("occupancy_stats_backfill_failures")
    .select("id, retry_count")
    .eq("blockface_id", context.blockfaceId)
    .eq("iso_day", context.isoDay)
    .eq("hour", context.hour)
    .maybeSingle();

  if (selectError !== null) {
    // Logging the failure is itself best-effort -- if even this read fails,
    // fall back to a plain console.error so the original failure isn't lost
    // entirely, rather than throwing and aborting the rest of the combo
    // over a bookkeeping problem.
    console.error(
      `backfill-occupancy-stats: failed to check for an existing occupancy_stats_backfill_failures row for blockface_id=${context.blockfaceId}, iso_day=${context.isoDay}, hour=${context.hour}: ${selectError.message}. Original failure: ${context.errorMessage}`,
    );
    return;
  }

  const retryCount = existing !== null ? existing.retry_count + 1 : 0;

  const { error: upsertError } = await client.from("occupancy_stats_backfill_failures").upsert(
    {
      blockface_id: context.blockfaceId,
      iso_day: context.isoDay,
      hour: context.hour,
      mean_occupancy: context.stats?.mean ?? null,
      std_dev: context.stats?.stdDev ?? null,
      sample_count: context.stats?.sampleCount ?? null,
      error_message: context.errorMessage,
      retry_count: retryCount,
    },
    { onConflict: "blockface_id,iso_day,hour" },
  );

  if (upsertError !== null) {
    console.error(
      `backfill-occupancy-stats: failed to log failure for blockface_id=${context.blockfaceId}, iso_day=${context.isoDay}, hour=${context.hour}: ${upsertError.message}. Original failure: ${context.errorMessage}`,
    );
  }
}

// --- Per-combo processing --------------------------------------------------

export interface ComboSummary {
  written: number;
  skippedInsufficientData: number;
  unmatched: number;
  blockfaceFailures: number;
  parseFailures: number;
}

export function createEmptyComboSummary(): ComboSummary {
  return { written: 0, skippedInsufficientData: 0, unmatched: 0, blockfaceFailures: 0, parseFailures: 0 };
}

export function accumulateComboSummary(total: ComboSummary, combo: ComboSummary): void {
  total.written += combo.written;
  total.skippedInsufficientData += combo.skippedInsufficientData;
  total.unmatched += combo.unmatched;
  total.blockfaceFailures += combo.blockfaceFailures;
  total.parseFailures += combo.parseFailures;
}

export interface ProcessComboDeps {
  occupancyStatsClient: OccupancyStatsSupabaseClient;
  failuresClient: BackfillFailuresSupabaseClient;
  fetchArchiveRecords: (whereClause: string) => Promise<SocrataRecord[]>;
  lookup: Map<string, string>;
  rollingReadings: RawReading[];
  now: Date;
}

export interface ClampedOccupancySummary {
  count: number;
  minRatio: number;
  maxRatio: number;
}

// Detects readings whose raw occupancy ratio (paidOccupancy /
// parkingSpaceCount) exceeds 1.0 -- the same condition
// calculateOccupancyRatio.ts clamps to 1.0. Computed independently here
// from each raw reading, not by having calculateOccupancyRatio report
// back, so this stays a self-contained diagnostic pass with no coupling to
// that function's internals (see its own comment for why it no longer
// warns per call). Returns null when nothing was clamped, rather than a
// zeroed-out summary with no meaningful range -- same "explicit absence
// over a value that could be mistaken for a real one" reasoning
// decideBucketStats uses for its own null return.
export function analyzeClampedOccupancy(readings: RawReading[]): ClampedOccupancySummary | null {
  let count = 0;
  let minRatio = Infinity;
  let maxRatio = -Infinity;

  for (const reading of readings) {
    // parkingSpaceCount <= 0 is a structural error calculateOccupancyRatio
    // itself throws on (a separate, unrelated failure mode) -- excluded
    // here rather than misclassified as "not clamped". A negative
    // paidOccupancy is clamped to 0 by a different branch entirely (never
    // this one), and is naturally excluded by paidOccupancy <=
    // parkingSpaceCount below without needing its own check.
    if (reading.parkingSpaceCount <= 0 || reading.paidOccupancy <= reading.parkingSpaceCount) {
      continue;
    }
    const rawRatio = reading.paidOccupancy / reading.parkingSpaceCount;
    count += 1;
    minRatio = Math.min(minRatio, rawRatio);
    maxRatio = Math.max(maxRatio, rawRatio);
  }

  return count === 0 ? null : { count, minRatio, maxRatio };
}

function formatRatioAsPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function logClampedOccupancySummary(combo: BucketCombo, summary: ClampedOccupancySummary | null): void {
  if (summary === null) {
    return;
  }
  console.warn(
    `backfill-occupancy-stats: iso_day=${combo.isoDay}, hour=${combo.hour}: ${summary.count} readings had occupancy exceeding capacity (clamped to 1.0), raw ratios ranged from ${formatRatioAsPercent(summary.minRatio)} to ${formatRatioAsPercent(summary.maxRatio)}`,
  );
}

// Processes one blockface/day/hour bucket combination: fetches the
// archive's matching rows (server-side filtered), combines them with the
// bucket's already-partitioned rolling-window rows, groups by blockface,
// and attempts to write each blockface's stats. A single blockface's write
// failure is logged to occupancy_stats_backfill_failures and does not stop
// the rest of this combination's blockfaces from being processed -- only a
// failure in the archive fetch itself (thrown, not caught here) aborts the
// whole combo, since that's a real "we don't have this bucket's data at
// all" failure rather than one bad write among many good ones.
export async function processCombo(combo: BucketCombo, deps: ProcessComboDeps): Promise<ComboSummary> {
  const summary = createEmptyComboSummary();

  const whereClause = buildBucketWhereClause(combo);
  const rawArchiveRecords = await deps.fetchArchiveRecords(whereClause);
  const { readings: archiveReadings, parseFailures } = parseRawReadings(rawArchiveRecords);
  summary.parseFailures += parseFailures;

  const allReadings = [...archiveReadings, ...deps.rollingReadings];
  logClampedOccupancySummary(combo, analyzeClampedOccupancy(allReadings));

  const { grouped, unmatchedCount } = groupReadingsByBlockface(allReadings, deps.lookup, deps.now);
  summary.unmatched = unmatchedCount;

  for (const [blockfaceId, weightedReadings] of grouped) {
    const stats = decideBucketStats(weightedReadings);
    if (stats === null) {
      summary.skippedInsufficientData += 1;
      continue;
    }

    try {
      await upsertOccupancyStats(deps.occupancyStatsClient, blockfaceId, combo.isoDay, combo.hour, stats);
      summary.written += 1;
    } catch (error) {
      summary.blockfaceFailures += 1;
      await logBucketFailure(deps.failuresClient, {
        blockfaceId,
        isoDay: combo.isoDay,
        hour: combo.hour,
        stats,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summary;
}

function logComboSummary(combo: BucketCombo, summary: ComboSummary): void {
  console.log(
    `  iso_day=${combo.isoDay}, hour=${combo.hour}: written=${summary.written}, skipped(insufficient data)=${summary.skippedInsufficientData}, unmatched=${summary.unmatched}, blockfaceFailures=${summary.blockfaceFailures}, parseFailures=${summary.parseFailures}`,
  );
}

// --- Main pass over all remaining combinations -----------------------------

export interface RunMainPassDeps {
  occupancyStatsClient: OccupancyStatsSupabaseClient;
  progressClient: BackfillProgressSupabaseClient;
  failuresClient: BackfillFailuresSupabaseClient;
  archiveDatasetId: string;
  rollingBuckets: Map<string, RawReading[]>;
  lookup: Map<string, string>;
  now: Date;
  // Injectable for testing runMainPass's own orchestration (progress
  // transitions, aggregation) in isolation from processCombo's full
  // fetch-and-write pipeline, which has its own separate test coverage.
  processComboFn?: typeof processCombo;
}

export async function runMainPass(combos: BucketCombo[], deps: RunMainPassDeps): Promise<ComboSummary> {
  const processComboFn = deps.processComboFn ?? processCombo;
  const overallSummary = createEmptyComboSummary();

  for (const combo of combos) {
    console.log(`Processing iso_day=${combo.isoDay}, hour=${combo.hour}...`);
    await markComboStatus(deps.progressClient, combo, "in_progress", null);

    let comboSummary: ComboSummary;
    try {
      comboSummary = await processComboFn(combo, {
        occupancyStatsClient: deps.occupancyStatsClient,
        failuresClient: deps.failuresClient,
        fetchArchiveRecords: (whereClause) => fetchSocrataRecords(buildSocrataDatasetUrl(deps.archiveDatasetId), whereClause),
        lookup: deps.lookup,
        rollingReadings: deps.rollingBuckets.get(bucketComboKey(combo)) ?? [],
        now: deps.now,
      });
    } catch (error) {
      // The fetch/query itself broke (not an individual blockface write --
      // those are caught inside processCombo and tracked separately) -- we
      // genuinely have no data for this bucket from this attempt, so it's
      // marked 'failed', not 'complete'.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  iso_day=${combo.isoDay}, hour=${combo.hour} failed: ${message}`);
      await markComboStatus(deps.progressClient, combo, "failed", message);
      continue;
    }

    logComboSummary(combo, comboSummary);
    accumulateComboSummary(overallSummary, comboSummary);
    // The fetch succeeded, so this combo is 'complete' regardless of any
    // individual blockface write failures within it -- those are tracked
    // durably in occupancy_stats_backfill_failures and handled by the
    // retry pass, not by re-running this whole combo.
    await markComboStatus(deps.progressClient, combo, "complete", null);
  }

  return overallSummary;
}

// --- Final retry pass over occupancy_stats_backfill_failures ---------------

// A row that has already failed this many times is far more likely a
// persistent problem (a bad blockface_id, a schema mismatch) than a
// transient one (a dropped connection) -- retrying it indefinitely every
// run would just spend requests re-confirming the same failure. Left in
// occupancy_stats_backfill_failures untouched once past this limit, so a
// human can find and investigate it rather than it silently retrying
// forever.
export const MAX_RETRY_COUNT = 10;

export interface RetryPassSummary {
  retriedSuccessfully: number;
  // Failed again this pass (or had no stats to retry with), but still
  // under MAX_RETRY_COUNT -- eligible to be retried again next run.
  remainingFailures: number;
  // Not attempted this pass at all, because retry_count was already >=
  // MAX_RETRY_COUNT -- a persistent failure that needs manual investigation,
  // tracked separately so it doesn't read as just another transient one.
  exceededRetryLimit: number;
}

export interface RetryPassClients {
  occupancyStatsClient: OccupancyStatsSupabaseClient;
  failuresClient: BackfillFailuresSupabaseClient;
}

// Retries every row currently in occupancy_stats_backfill_failures using
// its already-stored statistics -- no re-fetching from Socrata or
// re-aggregating. A successful retry deletes the row (resolved, nothing
// left to track); a repeat failure updates error_message and increments
// retry_count in place rather than accumulating duplicates. A row already
// at or past MAX_RETRY_COUNT is skipped entirely (not attempted, not
// updated) rather than retried indefinitely.
export async function runRetryPass(clients: RetryPassClients): Promise<RetryPassSummary> {
  const { data: rows, error } = await clients.failuresClient
    .from("occupancy_stats_backfill_failures")
    .select("id, blockface_id, iso_day, hour, mean_occupancy, std_dev, sample_count, error_message, retry_count");

  if (error !== null) {
    throw new Error(`backfill-occupancy-stats: reading occupancy_stats_backfill_failures for the retry pass failed: ${error.message}`);
  }

  let retriedSuccessfully = 0;
  let remainingFailures = 0;
  let exceededRetryLimit = 0;

  for (const row of rows ?? []) {
    if (row.retry_count >= MAX_RETRY_COUNT) {
      exceededRetryLimit += 1;
      continue;
    }

    // The schema allows null stats for a failure logged before aggregation
    // ever completed (schema.sql's own column comment); this orchestration
    // script never actually produces one (logBucketFailure is only called
    // after decideBucketStats has already returned real stats), but the
    // retry pass still has to handle it defensively -- there's nothing to
    // re-upsert without stats, so it's left as a remaining failure rather
    // than silently dropped.
    if (row.mean_occupancy === null || row.std_dev === null || row.sample_count === null) {
      remainingFailures += 1;
      continue;
    }

    const stats: BucketStats = { mean: row.mean_occupancy, stdDev: row.std_dev, sampleCount: row.sample_count };

    try {
      await upsertOccupancyStats(clients.occupancyStatsClient, row.blockface_id, row.iso_day, row.hour, stats);
      const { error: deleteError } = await clients.failuresClient.from("occupancy_stats_backfill_failures").delete().eq("id", row.id);
      if (deleteError !== null) {
        console.error(
          `backfill-occupancy-stats: retry succeeded for id=${row.id} but deleting its occupancy_stats_backfill_failures row failed: ${deleteError.message}`,
        );
      }
      retriedSuccessfully += 1;
    } catch (retryError) {
      remainingFailures += 1;
      const message = retryError instanceof Error ? retryError.message : String(retryError);
      const { error: updateError } = await clients.failuresClient.from("occupancy_stats_backfill_failures").upsert(
        {
          blockface_id: row.blockface_id,
          iso_day: row.iso_day,
          hour: row.hour,
          mean_occupancy: row.mean_occupancy,
          std_dev: row.std_dev,
          sample_count: row.sample_count,
          error_message: message,
          retry_count: row.retry_count + 1,
        },
        { onConflict: "blockface_id,iso_day,hour" },
      );
      if (updateError !== null) {
        console.error(
          `backfill-occupancy-stats: retry failed for id=${row.id} and updating its failure row also failed: ${updateError.message}. Original retry error: ${message}`,
        );
      }
    }
  }

  return { retriedSuccessfully, remainingFailures, exceededRetryLimit };
}

// --- Overall summary --------------------------------------------------------

export interface OverallSummary {
  combosProcessed: number;
  written: number;
  skippedInsufficientData: number;
  unmatched: number;
  remainingFailures: number;
  exceededRetryLimit: number;
}

function logOverallSummary(summary: OverallSummary): void {
  console.log("\n=== backfill-occupancy-stats overall summary ===");
  console.log(`Combinations processed:            ${summary.combosProcessed}`);
  console.log(`Blocks written:                    ${summary.written}`);
  console.log(`Skipped (insufficient data):       ${summary.skippedInsufficientData}`);
  console.log(`Unmatched readings:                ${summary.unmatched}`);
  console.log(`Failures still eligible for retry: ${summary.remainingFailures}`);
  console.log(`Failures needing manual investigation (>= ${MAX_RETRY_COUNT} retries): ${summary.exceededRetryLimit}`);
  console.log("==================================================\n");
}

// --- Orchestration ------------------------------------------------------

function getRequiredEnvVar(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`backfill-occupancy-stats: missing required environment variable ${name} (see .env.example)`);
  }
  return value;
}

function createSupabaseClient(url: string, serviceRoleKey: string) {
  return createClient(url, serviceRoleKey);
}

export async function main(): Promise<void> {
  const { combo: singleCombo } = parseCliOptions(process.argv.slice(2));
  console.log(singleCombo === null ? "Running the full backfill." : `Running a single combo for testing: iso_day=${singleCombo.isoDay}, hour=${singleCombo.hour}.`);

  const supabaseUrl = getRequiredEnvVar("SUPABASE_URL");
  const supabaseServiceRoleKey = getRequiredEnvVar("SUPABASE_SERVICE_ROLE_KEY");
  // Not used directly here -- fetchSocrataRecords reads it from
  // process.env itself -- but validated up front so a missing token fails
  // fast at startup rather than partway through a run this long. Required
  // here (unlike fetchSocrataRecords' own generic optional treatment)
  // because this job's real request volume genuinely needs it (see
  // CLAUDE.md's Architecture section).
  getRequiredEnvVar("SOCRATA_APP_TOKEN");

  // Same unavoidable TS2589 cast as the import scripts (see
  // import-off-street-facilities.ts's comment) -- not a real structural
  // mismatch, just the real client's generic types recursing too deep for
  // these narrow, purpose-specific interfaces to satisfy directly.
  const rawSupabaseClient = createSupabaseClient(supabaseUrl, supabaseServiceRoleKey);
  const blockfaceLookupClient = rawSupabaseClient as unknown as BlockfaceLookupSupabaseClient;
  const occupancyStatsClient = rawSupabaseClient as unknown as OccupancyStatsSupabaseClient;
  const progressClient = rawSupabaseClient as unknown as BackfillProgressSupabaseClient;
  const failuresClient = rawSupabaseClient as unknown as BackfillFailuresSupabaseClient;
  const operatingHoursClient = rawSupabaseClient as unknown as OperatingHoursSupabaseClient;

  const now = new Date();
  const priorYear = getPriorYear(now);
  const archiveDatasetId = resolveYearlyArchiveDatasetId(priorYear);
  console.log(`Using archive dataset ${archiveDatasetId} for year ${priorYear}.`);

  // For a --combo test, only that one bucket's slice is needed from the
  // rolling window -- fetched with the same server-side day/hour filtering
  // as the archive, not the full unfiltered window. The full window is
  // only fetched (and partitioned into every bucket up front) for the
  // complete run, where every bucket needs it.
  let rollingBuckets: Map<string, RawReading[]>;
  let rollingParseFailures: number;
  if (singleCombo !== null) {
    console.log(`Fetching only the rolling-window slice for iso_day=${singleCombo.isoDay}, hour=${singleCombo.hour}...`);
    const result = await buildRollingBucketsForCombo(singleCombo, (whereClause) =>
      fetchSocrataRecords(buildSocrataDatasetUrl(ROLLING_WINDOW_DATASET_ID), whereClause),
    );
    rollingBuckets = result.buckets;
    rollingParseFailures = result.parseFailures;
    console.log(`Fetched ${rollingBuckets.get(bucketComboKey(singleCombo))?.length ?? 0} rolling-window records for this combo (${rollingParseFailures} unparseable records skipped).`);
  } else {
    console.log("Fetching the entire rolling window (this may take a while)...");
    const rawRollingRecords = await fetchSocrataRecords(buildSocrataDatasetUrl(ROLLING_WINDOW_DATASET_ID), "1=1");
    console.log(`Fetched ${rawRollingRecords.length} rolling-window records.`);
    const { readings: rollingReadings, parseFailures: rollingRecordParseFailures } = parseRawReadings(rawRollingRecords);
    const { buckets, parseFailures: rollingPartitionParseFailures } = partitionByBucket(rollingReadings);
    rollingBuckets = buckets;
    rollingParseFailures = rollingRecordParseFailures + rollingPartitionParseFailures;
    console.log(`Partitioned the rolling window into ${rollingBuckets.size} buckets (${rollingParseFailures} unparseable records skipped).`);
  }

  console.log("Building blockface lookup...");
  const lookup = await buildBlockfaceLookup(blockfaceLookupClient);
  console.log(`Loaded ${lookup.size} blockfaces.`);

  let combosToRun: BucketCombo[];
  if (singleCombo !== null) {
    combosToRun = [singleCombo];
  } else {
    console.log("Deriving the real operating-hour range from blockfaces...");
    const hourRange = await fetchOperatingHourRange(operatingHoursClient);
    console.log(`Operating hours span ${hourRange.startHour}:00-${hourRange.endHour}:59, ${7 * (hourRange.endHour - hourRange.startHour + 1)} combos.`);
    const allCombos = buildAllBucketCombos(hourRange);

    console.log("Checking occupancy_stats_backfill_progress for already-complete combos...");
    const statuses = await fetchProgressStatuses(progressClient);
    combosToRun = selectCombosToRun(allCombos, statuses);
    console.log(`${combosToRun.length} of ${allCombos.length} combos remain (skipping already-'complete' ones).`);
  }

  const mainPassSummary = await runMainPass(combosToRun, {
    occupancyStatsClient,
    progressClient,
    failuresClient,
    archiveDatasetId,
    rollingBuckets,
    lookup,
    now,
  });

  console.log("\nRunning final retry pass over occupancy_stats_backfill_failures...");
  const retryPassSummary = await runRetryPass({ occupancyStatsClient, failuresClient });
  console.log(
    `Retry pass: ${retryPassSummary.retriedSuccessfully} succeeded, ${retryPassSummary.remainingFailures} still eligible for retry, ${retryPassSummary.exceededRetryLimit} exceeded the retry limit (>= ${MAX_RETRY_COUNT}) and need manual investigation.`,
  );

  logOverallSummary({
    combosProcessed: combosToRun.length,
    written: mainPassSummary.written + retryPassSummary.retriedSuccessfully,
    skippedInsufficientData: mainPassSummary.skippedInsufficientData,
    unmatched: mainPassSummary.unmatched,
    remainingFailures: retryPassSummary.remainingFailures,
    exceededRetryLimit: retryPassSummary.exceededRetryLimit,
  });
}

// Same pathToFileURL-based direct-execution guard as the import scripts --
// see import-blockfaces.ts's comment for why a naive `file://${path}`
// template string doesn't work (this repo's own path contains a space).
const isRunDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isRunDirectly) {
  main().catch((error: unknown) => {
    console.error("backfill-occupancy-stats: fatal error:", error);
    process.exitCode = 1;
  });
}
