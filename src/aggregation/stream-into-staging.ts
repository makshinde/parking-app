import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import { buildBlockfaceLookup, type BlockfaceLookupSupabaseClient } from "./blockfaceLookup.ts";
import {
  foldReadingsIntoAccumulators,
  mergeAccumulatorSnapshot,
  createMaxChunksOnChunk,
  MaxChunksReachedError,
} from "./backfill-occupancy-stats.ts";
import {
  fetchAccumulatorBuckets,
  streamArchiveWithResume,
  type ArchiveStreamAccumulatorBucketsSupabaseClient,
  type ArchiveStreamCheckpointSupabaseClient,
} from "./streamArchiveWithResume.ts";
import type { WeightedStatsAccumulator } from "./incrementalWeightedStats.ts";

// A narrow, dedicated script for streaming a real Socrata archive dataset
// into an accumulator identity that is NOT itself a real Socrata dataset id
// -- e.g. folding "q2e4-e7e5" (the 2026 Q1 archive) into
// "combined-history-staging" (a manually-seeded merge of prior totals),
// without ever touching the real, already-verified "7c2e-uany"-tagged rows
// in archive_stream_checkpoint / archive_stream_accumulator_buckets.
//
// Deliberately NOT a mode bolted onto backfill-occupancy-stats.ts's main():
// that function always folds the rolling window in on a fresh start and
// always writes occupancy_stats at the end, neither of which this script
// wants. This script does ONLY the accumulator-folding step, using
// streamArchiveWithResume's storageIdentity option (see that module's own
// comment) to keep the real Socrata source and the storage identity
// explicit and independently controlled. It never calls
// decideBucketStatsFromAccumulator or upsertOccupancyStatsBatch --
// promotion to occupancy_stats is a deliberately separate, later step, not
// something this script does on its own.

export interface CliOptions {
  sourceDataset: string;
  storageIdentity: string;
  maxChunks: number | null;
}

function getRequiredArgValue(argv: string[], flag: string): string {
  const prefix = `--${flag}=`;
  const arg = argv.find((a) => a.startsWith(prefix));
  if (arg === undefined) {
    throw new Error(`stream-into-staging: missing required --${flag}=<value> argument`);
  }
  const value = arg.slice(prefix.length);
  if (value.trim() === "") {
    throw new Error(`stream-into-staging: --${flag} must not be empty`);
  }
  return value;
}

// Both --source-dataset and --storage-identity are required, with no
// default for either -- this script exists specifically for cases where
// the two must be told apart explicitly, so silently defaulting one from
// the other here would undermine the whole point (unlike
// streamArchiveWithResume's own storageIdentity, which DOES default to
// archiveDatasetId, correctly, for its many callers that want them to
// match).
export function parseCliOptions(argv: string[]): CliOptions {
  const sourceDataset = getRequiredArgValue(argv, "source-dataset");
  const storageIdentity = getRequiredArgValue(argv, "storage-identity");

  const maxChunksArg = argv.find((a) => /^--max-chunks=(.+)$/.exec(a) !== null);
  let maxChunks: number | null = null;
  if (maxChunksArg !== undefined) {
    const match = /^--max-chunks=(.+)$/.exec(maxChunksArg);
    const rawValue = match?.[1];
    if (rawValue === undefined) {
      throw new Error("stream-into-staging: unreachable -- --max-chunks regex matched without a capture group");
    }
    const parsed = Number(rawValue);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`stream-into-staging: --max-chunks must be a positive integer, got "${rawValue}"`);
    }
    maxChunks = parsed;
  }

  return { sourceDataset, storageIdentity, maxChunks };
}

// --- Core orchestration (testable without real env vars/Supabase) --------

export interface StreamIntoStagingClients {
  checkpointClient: ArchiveStreamCheckpointSupabaseClient;
  bucketsClient: ArchiveStreamAccumulatorBucketsSupabaseClient;
}

export interface StreamIntoStagingResult {
  bucketsInMemory: number;
  unmatchedCount: number;
  parseFailures: number;
  stoppedEarly: boolean;
}

// Deliberately returns only the final in-memory accumulator SIZE and
// diagnostics, not the accumulator contents themselves -- this script's
// whole point is that the real accumulator state lives durably in
// archive_stream_accumulator_buckets under storageIdentity (written via
// streamArchiveWithResume's normal snapshotting), verified there directly,
// not trusted from this process's own in-memory Map after it exits.
export async function streamArchiveIntoStaging(
  clients: StreamIntoStagingClients,
  lookup: Map<string, string>,
  options: { sourceDataset: string; storageIdentity: string; maxChunks: number | null },
  now: Date,
): Promise<StreamIntoStagingResult> {
  const accumulators = new Map<string, WeightedStatsAccumulator>();
  let totalUnmatched = 0;
  let totalParseFailures = 0;
  let stoppedEarly = false;

  // Seed from whatever accumulator state already exists under this storage
  // identity, unconditionally, BEFORE streaming starts -- deliberately not
  // relying on streamArchiveWithResume's own onResume hook for this, since
  // that hook only fires when a CHECKPOINT already exists for this identity
  // (see streamArchiveWithResume.ts's own resume logic). A storage identity
  // used by this script can legitimately have pre-populated accumulator
  // rows with NO checkpoint at all -- e.g. a manually duplicated/seeded
  // merge like "combined-history-staging" -- and those must not be
  // silently ignored just because nothing has streamed into this identity
  // yet. Live-confirmed as a real bug, not a hypothetical: a first run
  // against a freshly-duplicated 105,931-row staging identity (no
  // checkpoint yet) folded only its own newly-fetched chunks into a Map
  // that started completely empty, because the (correct, for
  // streamArchiveWithResume's normal caller) checkpoint-gated onResume
  // never fired.
  //
  // On a genuine resume of THIS script (a checkpoint now exists),
  // streamArchiveWithResume's own onResume below reads this exact same
  // table again and re-merges -- redundant with this upfront seed, but
  // harmless (mergeAccumulatorSnapshot just overwrites matching keys with
  // the same or more current values) and not worth special-casing away for
  // a script expected to run only a handful of times.
  const preExistingSnapshot = await fetchAccumulatorBuckets(clients.bucketsClient, options.storageIdentity);
  const preExistingCount = mergeAccumulatorSnapshot(accumulators, preExistingSnapshot);
  if (preExistingCount > 0) {
    console.log(`Seeded ${preExistingCount} pre-existing buckets from "${options.storageIdentity}" before streaming.`);
  }

  const { onChunk } = createMaxChunksOnChunk(options.maxChunks, (records) => {
    const result = foldReadingsIntoAccumulators(records, accumulators, lookup, now);
    totalUnmatched += result.unmatchedCount;
    totalParseFailures += result.parseFailures;
    return Object.fromEntries(accumulators);
  });

  try {
    await streamArchiveWithResume(clients, {
      archiveDatasetId: options.sourceDataset,
      storageIdentity: options.storageIdentity,
      onResume: (snapshot) => {
        mergeAccumulatorSnapshot(accumulators, snapshot);
      },
      onChunk,
    });
  } catch (error) {
    if (!(error instanceof MaxChunksReachedError)) {
      throw error;
    }
    stoppedEarly = true;
  }

  return {
    bucketsInMemory: accumulators.size,
    unmatchedCount: totalUnmatched,
    parseFailures: totalParseFailures,
    stoppedEarly,
  };
}

// --- CLI glue -------------------------------------------------------------

function getRequiredEnvVar(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`stream-into-staging: missing required environment variable ${name} (see .env.example)`);
  }
  return value;
}

function createSupabaseClient(url: string, serviceRoleKey: string) {
  return createClient(url, serviceRoleKey);
}

export async function main(): Promise<void> {
  const { sourceDataset, storageIdentity, maxChunks } = parseCliOptions(process.argv.slice(2));
  console.log(`Streaming source dataset ${sourceDataset} into storage identity "${storageIdentity}".`);
  console.log(maxChunks === null ? "No --max-chunks limit: running to natural completion." : `Bounded test: stopping after ${maxChunks} chunk(s).`);
  console.log("This script never writes to occupancy_stats and never touches archive_stream_checkpoint/archive_stream_accumulator_buckets rows tagged with any identity other than the one given above.");

  const supabaseUrl = getRequiredEnvVar("SUPABASE_URL");
  const supabaseServiceRoleKey = getRequiredEnvVar("SUPABASE_SERVICE_ROLE_KEY");
  getRequiredEnvVar("SOCRATA_APP_TOKEN");

  // Same unavoidable TS2589 cast used throughout this project's scripts
  // (see backfill-occupancy-stats.ts's own comment).
  const rawSupabaseClient = createSupabaseClient(supabaseUrl, supabaseServiceRoleKey);
  const blockfaceLookupClient = rawSupabaseClient as unknown as BlockfaceLookupSupabaseClient;
  const checkpointClient = rawSupabaseClient as unknown as ArchiveStreamCheckpointSupabaseClient;
  const accumulatorBucketsClient = rawSupabaseClient as unknown as ArchiveStreamAccumulatorBucketsSupabaseClient;

  console.log("Building blockface lookup...");
  const lookup = await buildBlockfaceLookup(blockfaceLookupClient);
  console.log(`Loaded ${lookup.size} blockfaces.`);

  const result = await streamArchiveIntoStaging(
    { checkpointClient, bucketsClient: accumulatorBucketsClient },
    lookup,
    { sourceDataset, storageIdentity, maxChunks },
    new Date(),
  );

  if (result.stoppedEarly) {
    console.log(`Stopped early (--max-chunks reached).`);
  }

  console.log("\n=== stream-into-staging summary ===");
  console.log(`Storage identity:               ${storageIdentity}`);
  console.log(`Source dataset:                 ${sourceDataset}`);
  console.log(`Buckets currently in memory:     ${result.bucketsInMemory}`);
  console.log(`Unmatched readings (this run):   ${result.unmatchedCount}`);
  console.log(`Unparseable records (this run):  ${result.parseFailures}`);
  console.log(`occupancy_stats: NOT written -- this script never writes it. Verify the accumulator state directly, then promote separately when ready.`);
  console.log("=====================================\n");
}

// Same pathToFileURL-based direct-execution guard as the other scripts --
// see import-blockfaces.ts's comment for why a naive `file://${path}`
// template string doesn't work (this repo's own path contains a space).
const isRunDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isRunDirectly) {
  main().catch((error: unknown) => {
    console.error("stream-into-staging: fatal error:", error);
    process.exitCode = 1;
  });
}
