import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import { fetchSocrataRecordsPaginated, type SocrataRecord } from "../utils/fetchSocrataRecords.ts";
import type { SupabaseQueryResult } from "../importers/upsertBlockface.ts";
import { resolveYearlyArchiveDatasetId, getPriorYear } from "./resolveYearlyArchive.ts";
import {
  buildBlockfaceLookup,
  normalizeReading,
  type RawReading,
  type BlockfaceLookupSupabaseClient,
} from "./blockfaceLookup.ts";
import { decideBucketStatsFromAccumulator, type BucketStats } from "./decideBucketStats.ts";
import {
  upsertOccupancyStats,
  upsertOccupancyStatsBatch,
  type OccupancyStatsSupabaseClient,
  type OccupancyStatsWriteRequest,
} from "./upsertOccupancyStats.ts";
import { calculateRecencyWeight } from "../scoring/recencyWeight.ts";
import { addReading, createEmptyAccumulator, type WeightedStatsAccumulator } from "./incrementalWeightedStats.ts";
import {
  fetchArchiveStreamCheckpoint,
  streamArchiveWithResume,
  type ArchiveStreamCheckpointSupabaseClient,
} from "./streamArchiveWithResume.ts";

// The current, not-yet-archived Paid Parking Occupancy dataset (see
// CLAUDE.md's Architecture section) -- unlike wtpb-jp8d/7c2e-uany (full,
// closed calendar years), this one keeps growing, so it's always fetched in
// a single bulk pull rather than through streamArchiveWithResume's
// resumable :id-keyset pagination, which is only for the closed yearly
// archive. It's only ever fetched once per archive (see main()'s fresh-vs-
// resume handling below), not once per chunk.
const ROLLING_WINDOW_DATASET_ID = "rke9-rsvs";
const SOCRATA_BASE_URL = "https://data.seattle.gov/resource";

function buildSocrataDatasetUrl(datasetId: string): string {
  return `${SOCRATA_BASE_URL}/${datasetId}.json`;
}

// --- CLI options --------------------------------------------------------

export interface CliOptions {
  maxChunks: number | null;
}

// --max-chunks is a testing convenience -- stop streaming after N archive
// chunks instead of the full archive, the same spirit as
// import-blockfaces.ts's --limit flag. Like --limit (and unlike a data
// value such as a reading's occupancy ratio), a CLI flag has no meaningful
// "nearest valid" fallback for a malformed value, so this throws rather
// than clamping or silently ignoring it.
export function parseCliOptions(argv: string[]): CliOptions {
  for (const arg of argv) {
    const match = /^--max-chunks=(.+)$/.exec(arg);
    if (match === null) {
      continue;
    }
    const [, rawValue] = match;
    if (rawValue === undefined) {
      throw new Error("backfill-occupancy-stats: unreachable -- --max-chunks regex matched without a capture group");
    }
    const maxChunks = Number(rawValue);
    if (!Number.isInteger(maxChunks) || maxChunks <= 0) {
      throw new Error(`backfill-occupancy-stats: --max-chunks must be a positive integer, got "${rawValue}"`);
    }
    return { maxChunks };
  }

  return { maxChunks: null };
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

// --- Streaming aggregation: bucket keys and folding -----------------------

// blockfaceId is a uuid (schema.sql's blockfaces.id), which never contains
// a colon, so joining with ':' and splitting back apart (below) is
// unambiguous. Unlike the old per-combo design (where isoDay/hour were
// constant for an entire archive query and only blockfaceId varied), a
// single streamed chunk can contain readings spanning every bucket at
// once -- :id keyset pagination has no correlation with time (see
// CLAUDE.md's Architecture section) -- so the accumulator Map needs the
// full (blockfaceId, isoDay, hour) triple as its key, not blockfaceId alone.
export function buildAccumulatorBucketKey(blockfaceId: string, isoDay: number, hour: number): string {
  return `${blockfaceId}:${isoDay}:${hour}`;
}

export interface AccumulatorBucketKeyComponents {
  blockfaceId: string;
  isoDay: number;
  hour: number;
}

const ACCUMULATOR_BUCKET_KEY_PATTERN = /^(.+):(\d+):(\d+)$/;

// Inverse of buildAccumulatorBucketKey, used when iterating the final
// accumulator Map to write occupancy_stats rows. A bucket key is a fixed,
// structural format this module itself produces, not external input, so a
// malformed key signals a real bug -- same discrete/categorical-input
// reasoning isoDayToSocrataDow uses for an out-of-range day -- and throws
// rather than guessing at a best-effort parse.
export function parseAccumulatorBucketKey(key: string): AccumulatorBucketKeyComponents {
  const match = ACCUMULATOR_BUCKET_KEY_PATTERN.exec(key);
  if (match === null) {
    throw new Error(`parseAccumulatorBucketKey: malformed bucket key "${key}"`);
  }
  const [, blockfaceId, isoDay, hour] = match;
  return { blockfaceId: blockfaceId as string, isoDay: Number(isoDay), hour: Number(hour) };
}

export interface FoldReadingsResult {
  unmatchedCount: number;
  parseFailures: number;
}

// Parses a batch of raw Socrata records (either the one-time rolling-window
// fold or a single streamed archive chunk -- see main()) and folds each
// matched reading directly into the shared accumulators Map, in place.
// Never materializes a WeightedReading[] the way the old per-combo
// groupReadingsByBlockface did -- a streaming run can't afford to hold
// every reading for a bucket in memory at once, that's the entire point of
// the incremental accumulator (incrementalWeightedStats.ts). Reused for
// both the rolling-window fold and every archive chunk, so the two paths
// can never drift out of sync with each other's matching/weighting logic.
export function foldReadingsIntoAccumulators(
  records: SocrataRecord[],
  accumulators: Map<string, WeightedStatsAccumulator>,
  lookup: Map<string, string>,
  now: Date,
): FoldReadingsResult {
  let unmatchedCount = 0;
  let parseFailures = 0;

  for (const record of records) {
    let reading: RawReading;
    try {
      reading = parseRawReading(record);
    } catch {
      parseFailures += 1;
      continue;
    }

    const result = normalizeReading(reading, lookup, now);
    if (!result.matched) {
      unmatchedCount += 1;
      continue;
    }

    const bucketKey = buildAccumulatorBucketKey(result.blockfaceId, result.isoDay, result.hour);
    const weight = calculateRecencyWeight(result.ageInDays);
    const existing = accumulators.get(bucketKey) ?? createEmptyAccumulator();
    accumulators.set(bucketKey, addReading(existing, result.occupancyRatio, weight));
  }

  return { unmatchedCount, parseFailures };
}

// --- Diagnostics: clamped-occupancy detection ------------------------------

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
//
// Not currently called from main(): it scans a whole readings array at
// once, which fits the old per-combo design (one bounded batch per query)
// but not streaming (readings arrive in unbounded chunks, never held in
// memory as one array -- see foldReadingsIntoAccumulators). Kept as a
// tested, still-usable utility (e.g. against one chunk manually, or in a
// future incremental variant) rather than removed, the same treatment
// isoDayToSocrataDow gets for the same reason: unused by this file's own
// orchestration right now, but not dead code in the sense of having no
// remaining purpose.
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
    // entirely, rather than throwing and aborting the run over a
    // bookkeeping problem.
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
    // after decideBucketStatsFromAccumulator has already returned real
    // stats), but the retry pass still has to handle it defensively --
    // there's nothing to re-upsert without stats, so it's left as a
    // remaining failure rather than silently dropped.
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
  written: number;
  skippedInsufficientData: number;
  unmatched: number;
  remainingFailures: number;
  exceededRetryLimit: number;
}

function logOverallSummary(summary: OverallSummary): void {
  console.log("\n=== backfill-occupancy-stats overall summary ===");
  console.log(`Buckets written:                   ${summary.written}`);
  console.log(`Skipped (insufficient data):       ${summary.skippedInsufficientData}`);
  console.log(`Unmatched readings:                ${summary.unmatched}`);
  console.log(`Failures still eligible for retry: ${summary.remainingFailures}`);
  console.log(`Failures needing manual investigation (>= ${MAX_RETRY_COUNT} retries): ${summary.exceededRetryLimit}`);
  console.log("==================================================\n");
}

// --- Accumulator initialization: fresh start vs. resume -------------------

export interface InitializeAccumulatorsDeps {
  checkpointClient: ArchiveStreamCheckpointSupabaseClient;
  archiveDatasetId: string;
  lookup: Map<string, string>;
  now: Date;
  // Paginated, not a single fetch-everything call: the rolling window
  // (rke9-rsvs) is genuinely too large to hold in memory as one array --
  // live-verified, a first attempt at "fetch the whole thing, then parse,
  // then fold" OOM'd (~2GB heap) against its real 27,080,827 rows. onPage
  // is called once per page (see fetchSocrataRecordsPaginated), and
  // initializeAccumulators folds and discards each page immediately rather
  // than accumulating them.
  fetchRollingWindowPages: (onPage: (page: SocrataRecord[]) => Promise<void> | void) => Promise<void>;
}

export interface InitializeAccumulatorsResult {
  accumulators: Map<string, WeightedStatsAccumulator>;
  unmatchedCount: number;
  parseFailures: number;
  resuming: boolean;
}

// The rolling-window fetch has no other visible progress -- the next log
// line main() prints only appears once the ENTIRE ~27M-row window has been
// fetched and folded. Live-verified as a real problem, not a hypothetical:
// a real run sat silent between "Loaded N blockfaces" and "Fresh run:
// folded the rolling window..." for 45+ minutes, indistinguishable from a
// stalled process from the log alone. 20 pages is roughly 1,000,000 rows at
// SOCRATA_PAGE_LIMIT (50,000 rows/page, see fetchSocrataRecords.ts) --
// frequent enough to give real visibility without spamming a line on every
// single page.
export const ROLLING_WINDOW_PROGRESS_LOG_INTERVAL_PAGES = 20;

// Decides whether this is a fresh start or a resume for archiveDatasetId
// (by checking archive_stream_checkpoint directly), and folds the rolling
// window in ONLY on a fresh start. This is deliberate, not an oversight: on
// a resume, the rolling window's readings were already folded into
// accumulators during the original fresh run that produced this archive's
// very first checkpoint -- they're already baked into whatever accumulator
// snapshot streamArchiveWithResume goes on to restore via its own onResume
// hook. Re-fetching and re-folding the rolling window again here on a
// resume would double-count every single rolling-window reading a second
// time -- the exact same failure mode streamArchiveWithResume's own onChunk
// contract warns about for a replayed archive chunk, just at this
// orchestration level instead, for a data source streamArchiveWithResume
// itself has no knowledge of (it only checkpoints archive chunks, never the
// rolling window).
export async function initializeAccumulators(deps: InitializeAccumulatorsDeps): Promise<InitializeAccumulatorsResult> {
  const existingCheckpoint = await fetchArchiveStreamCheckpoint(deps.checkpointClient, deps.archiveDatasetId);
  const accumulators = new Map<string, WeightedStatsAccumulator>();

  if (existingCheckpoint !== null) {
    return { accumulators, unmatchedCount: 0, parseFailures: 0, resuming: true };
  }

  let unmatchedCount = 0;
  let parseFailures = 0;
  let pagesFetched = 0;
  let rowsFolded = 0;
  await deps.fetchRollingWindowPages((page) => {
    const result = foldReadingsIntoAccumulators(page, accumulators, deps.lookup, deps.now);
    unmatchedCount += result.unmatchedCount;
    parseFailures += result.parseFailures;
    pagesFetched += 1;
    rowsFolded += page.length;

    if (pagesFetched % ROLLING_WINDOW_PROGRESS_LOG_INTERVAL_PAGES === 0) {
      console.log(`Rolling window progress: ${pagesFetched} pages fetched, ${rowsFolded} rows folded so far...`);
    }
  });

  return { accumulators, unmatchedCount, parseFailures, resuming: false };
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

// Thrown from streamArchiveWithResume's onChunk once --max-chunks is
// reached, to stop its loop early for cheap testing -- the module itself
// exposes no other way to stop before the dataset is exhausted (see
// streamArchiveWithResume.ts). main() distinguishes this expected,
// deliberate stop from a genuine failure via instanceof, not a string match
// on the error message. Because onChunk throws instead of returning, the
// chunk that triggered it never gets checkpointed (streamArchiveWithResume
// only saves a chunk's checkpoint after onChunk returns successfully) --
// an accepted gap for a testing-only flag, not a concern for the real,
// uninterrupted production run.
//
// Deliberately NOT a constructor parameter property (no `public`/`readonly`
// modifier on the constructor argument itself): this file is run directly
// via plain `node` (no bundler -- see CLAUDE.md's Conventions section on
// the .ts-extension requirement for the same reason), which uses Node's
// strip-only TypeScript support. That mode only erases type annotations;
// it does not support parameter-property shorthand, which expands into
// real field-assignment code, not just a type. Live-verified: the
// parameter-property form crashed immediately with
// ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX under plain `node`, even though it
// type-checked fine and passed under vitest (which transforms via esbuild,
// not Node's stripper).
export class MaxChunksReachedError extends Error {
  readonly chunksProcessed: number;

  constructor(chunksProcessed: number) {
    super(`reached --max-chunks after ${chunksProcessed} chunk(s)`);
    this.name = "MaxChunksReachedError";
    this.chunksProcessed = chunksProcessed;
  }
}

export async function main(): Promise<void> {
  const { maxChunks } = parseCliOptions(process.argv.slice(2));
  console.log(maxChunks === null ? "Running the full backfill." : `Running a bounded test: stopping after ${maxChunks} archive chunk(s).`);

  const supabaseUrl = getRequiredEnvVar("SUPABASE_URL");
  const supabaseServiceRoleKey = getRequiredEnvVar("SUPABASE_SERVICE_ROLE_KEY");
  // Not used directly here -- fetchSocrataRecords/streamArchiveWithResume
  // read it from process.env themselves -- but validated up front so a
  // missing token fails fast at startup rather than partway through a run
  // this long. Required here (unlike fetchSocrataRecords' own generic
  // optional treatment) because this job's real request volume genuinely
  // needs it (see CLAUDE.md's Architecture section).
  getRequiredEnvVar("SOCRATA_APP_TOKEN");

  // Same unavoidable TS2589 cast as the import scripts (see
  // import-off-street-facilities.ts's comment) -- not a real structural
  // mismatch, just the real client's generic types recursing too deep for
  // these narrow, purpose-specific interfaces to satisfy directly.
  const rawSupabaseClient = createSupabaseClient(supabaseUrl, supabaseServiceRoleKey);
  const blockfaceLookupClient = rawSupabaseClient as unknown as BlockfaceLookupSupabaseClient;
  const occupancyStatsClient = rawSupabaseClient as unknown as OccupancyStatsSupabaseClient;
  const failuresClient = rawSupabaseClient as unknown as BackfillFailuresSupabaseClient;
  const checkpointClient = rawSupabaseClient as unknown as ArchiveStreamCheckpointSupabaseClient;

  const now = new Date();
  const priorYear = getPriorYear(now);
  const archiveDatasetId = resolveYearlyArchiveDatasetId(priorYear);
  console.log(`Using archive dataset ${archiveDatasetId} for year ${priorYear}.`);

  console.log("Building blockface lookup...");
  const lookup = await buildBlockfaceLookup(blockfaceLookupClient);
  console.log(`Loaded ${lookup.size} blockfaces.`);

  const initResult = await initializeAccumulators({
    checkpointClient,
    archiveDatasetId,
    lookup,
    now,
    fetchRollingWindowPages: (onPage) => fetchSocrataRecordsPaginated(buildSocrataDatasetUrl(ROLLING_WINDOW_DATASET_ID), "1=1", onPage),
  });
  let accumulators = initResult.accumulators;
  let totalUnmatched = initResult.unmatchedCount;
  let totalParseFailures = initResult.parseFailures;
  console.log(
    initResult.resuming
      ? "Resuming an interrupted run: skipped the rolling-window fetch (already folded into the restored checkpoint)."
      : `Fresh run: folded the rolling window into ${accumulators.size} buckets (${totalParseFailures} unparseable, ${totalUnmatched} unmatched so far).`,
  );

  let chunksProcessed = 0;
  try {
    await streamArchiveWithResume(checkpointClient, {
      archiveDatasetId,
      onResume: (snapshot) => {
        accumulators = new Map(Object.entries(snapshot));
        console.log(`Restored ${accumulators.size} buckets from an existing checkpoint.`);
      },
      onChunk: (records) => {
        chunksProcessed += 1;
        const result = foldReadingsIntoAccumulators(records, accumulators, lookup, now);
        totalUnmatched += result.unmatchedCount;
        totalParseFailures += result.parseFailures;
        const snapshot = Object.fromEntries(accumulators);

        if (maxChunks !== null && chunksProcessed >= maxChunks) {
          throw new MaxChunksReachedError(chunksProcessed);
        }

        return snapshot;
      },
    });
  } catch (error) {
    if (!(error instanceof MaxChunksReachedError)) {
      throw error;
    }
    console.log(`Stopped early: ${error.message}.`);
  }

  console.log(
    `Streaming complete. Evaluating ${accumulators.size} buckets (${totalParseFailures} unparseable records skipped, ${totalUnmatched} unmatched readings total)...`,
  );

  const writeRequests: OccupancyStatsWriteRequest[] = [];
  let skippedInsufficientData = 0;
  for (const [bucketKey, accumulator] of accumulators) {
    const stats = decideBucketStatsFromAccumulator(accumulator);
    if (stats === null) {
      skippedInsufficientData += 1;
      continue;
    }
    const { blockfaceId, isoDay, hour } = parseAccumulatorBucketKey(bucketKey);
    writeRequests.push({ blockfaceId, isoDay, hour, stats });
  }

  console.log(`Writing ${writeRequests.length} qualifying buckets (skipped ${skippedInsufficientData} with insufficient data)...`);
  const { writtenCount, failures } = await upsertOccupancyStatsBatch(occupancyStatsClient, writeRequests);
  for (const failure of failures) {
    await logBucketFailure(failuresClient, {
      blockfaceId: failure.blockfaceId,
      isoDay: failure.isoDay,
      hour: failure.hour,
      stats: failure.stats,
      errorMessage: failure.errorMessage,
    });
  }

  console.log("\nRunning final retry pass over occupancy_stats_backfill_failures...");
  const retryPassSummary = await runRetryPass({ occupancyStatsClient, failuresClient });
  console.log(
    `Retry pass: ${retryPassSummary.retriedSuccessfully} succeeded, ${retryPassSummary.remainingFailures} still eligible for retry, ${retryPassSummary.exceededRetryLimit} exceeded the retry limit (>= ${MAX_RETRY_COUNT}) and need manual investigation.`,
  );

  logOverallSummary({
    written: writtenCount + retryPassSummary.retriedSuccessfully,
    skippedInsufficientData,
    unmatched: totalUnmatched,
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
