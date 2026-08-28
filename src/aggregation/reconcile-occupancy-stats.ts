import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import { resolveYearlyArchiveDatasetId, getPriorYear } from "./resolveYearlyArchive.ts";
import { fetchAccumulatorBuckets, type ArchiveStreamAccumulatorBucketsSupabaseClient } from "./streamArchiveWithResume.ts";
import { parseAccumulatorBucketKey } from "./incrementalWeightedStats.ts";
import { decideBucketStatsFromAccumulator } from "./decideBucketStats.ts";
import {
  upsertOccupancyStatsBatch,
  type OccupancyStatsSupabaseClient,
  type OccupancyStatsWriteFailure,
  type OccupancyStatsWriteRequest,
} from "./upsertOccupancyStats.ts";
import { logBucketFailure, runRetryPass, MAX_RETRY_COUNT, type BackfillFailuresSupabaseClient } from "./backfill-occupancy-stats.ts";

// A narrow, dedicated correction pass -- deliberately NOT a variant of
// backfill-occupancy-stats.ts's main(), which always streams new archive
// data as part of its normal operation. This script does the opposite: it
// only reads the accumulator state ALREADY durably persisted in
// archive_stream_accumulator_buckets by prior runs, and re-writes
// occupancy_stats from it via the now-verified upsertOccupancyStatsBatch
// (see that function's own comment for the real, live-confirmed
// silent-write-failure bug this corrects for). It never touches
// archive_stream_checkpoint, never calls streamArchiveWithResume, and never
// makes a single request to Socrata -- no further archive data is streamed
// by running this.
export interface ReconcileResult {
  totalBuckets: number;
  skippedInsufficientData: number;
  writtenCount: number;
  failures: OccupancyStatsWriteFailure[];
}

export async function reconcileOccupancyStatsFromAccumulator(
  accumulatorClient: ArchiveStreamAccumulatorBucketsSupabaseClient,
  occupancyStatsClient: OccupancyStatsSupabaseClient,
  archiveDatasetId: string,
): Promise<ReconcileResult> {
  const snapshot = await fetchAccumulatorBuckets(accumulatorClient, archiveDatasetId);

  const writeRequests: OccupancyStatsWriteRequest[] = [];
  let skippedInsufficientData = 0;
  for (const [bucketKey, accumulator] of Object.entries(snapshot)) {
    const stats = decideBucketStatsFromAccumulator(accumulator);
    if (stats === null) {
      skippedInsufficientData += 1;
      continue;
    }
    const { blockfaceId, isoDay, hour } = parseAccumulatorBucketKey(bucketKey);
    writeRequests.push({ blockfaceId, isoDay, hour, stats });
  }

  const { writtenCount, failures } = await upsertOccupancyStatsBatch(occupancyStatsClient, writeRequests);

  return {
    totalBuckets: Object.keys(snapshot).length,
    skippedInsufficientData,
    writtenCount,
    failures,
  };
}

// --- Orchestration ------------------------------------------------------

function getRequiredEnvVar(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`reconcile-occupancy-stats: missing required environment variable ${name} (see .env.example)`);
  }
  return value;
}

function createSupabaseClient(url: string, serviceRoleKey: string) {
  return createClient(url, serviceRoleKey);
}

export async function main(): Promise<void> {
  const supabaseUrl = getRequiredEnvVar("SUPABASE_URL");
  const supabaseServiceRoleKey = getRequiredEnvVar("SUPABASE_SERVICE_ROLE_KEY");

  // Same unavoidable TS2589 cast used throughout this project's scripts
  // (see backfill-occupancy-stats.ts's own comment) -- not a real
  // structural mismatch, just the real client's generic types recursing
  // too deep for these narrow, purpose-specific interfaces to satisfy
  // directly.
  const rawSupabaseClient = createSupabaseClient(supabaseUrl, supabaseServiceRoleKey);
  const accumulatorClient = rawSupabaseClient as unknown as ArchiveStreamAccumulatorBucketsSupabaseClient;
  const occupancyStatsClient = rawSupabaseClient as unknown as OccupancyStatsSupabaseClient;
  const failuresClient = rawSupabaseClient as unknown as BackfillFailuresSupabaseClient;

  const now = new Date();
  const priorYear = getPriorYear(now);
  const archiveDatasetId = resolveYearlyArchiveDatasetId(priorYear);
  console.log(`Reconciling occupancy_stats from archive_stream_accumulator_buckets for archive_dataset_id=${archiveDatasetId} (year ${priorYear}). No archive data will be streamed -- this only reads already-persisted accumulator state.`);

  const result = await reconcileOccupancyStatsFromAccumulator(accumulatorClient, occupancyStatsClient, archiveDatasetId);

  console.log(
    `Read ${result.totalBuckets} buckets from archive_stream_accumulator_buckets (${result.skippedInsufficientData} skipped for insufficient data).`,
  );
  console.log(`Batch-verified write complete: ${result.writtenCount} buckets written, ${result.failures.length} failed even after individual retry.`);

  for (const failure of result.failures) {
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

  console.log("\n=== reconcile-occupancy-stats summary ===");
  console.log(`Buckets read from accumulator:      ${result.totalBuckets}`);
  console.log(`Skipped (insufficient data):        ${result.skippedInsufficientData}`);
  console.log(`Written (including retries):        ${result.writtenCount + retryPassSummary.retriedSuccessfully}`);
  console.log(`Failures still eligible for retry:  ${retryPassSummary.remainingFailures}`);
  console.log(`Failures needing manual investigation (>= ${MAX_RETRY_COUNT} retries): ${retryPassSummary.exceededRetryLimit}`);
  console.log("==========================================\n");
}

// Same pathToFileURL-based direct-execution guard as the other scripts --
// see import-blockfaces.ts's comment for why a naive `file://${path}`
// template string doesn't work (this repo's own path contains a space).
const isRunDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isRunDirectly) {
  main().catch((error: unknown) => {
    console.error("reconcile-occupancy-stats: fatal error:", error);
    process.exitCode = 1;
  });
}
