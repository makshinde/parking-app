import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import { buildBlockfaceLookup, type BlockfaceLookupSupabaseClient } from "./blockfaceLookup.ts";
import { foldReadingsIntoAccumulators, mergeAccumulatorSnapshot } from "./backfill-occupancy-stats.ts";
import { fetchAccumulatorBuckets, upsertAccumulatorBuckets, type ArchiveStreamAccumulatorBucketsSupabaseClient } from "./streamArchiveWithResume.ts";
import { fetchSocrataRecordsPaginated, buildRequestHeaders } from "../utils/fetchSocrataRecords.ts";
import {
  fetchLedgeredDates,
  recordLedgerEntry,
  enumerateDates,
  computeUpperBoundDate,
  type RollingWindowFoldLedgerSupabaseClient,
} from "./rollingWindowFoldLedger.ts";
import type { WeightedStatsAccumulator, AccumulatorSnapshot } from "./incrementalWeightedStats.ts";

// Day-by-day, ledgered catch-up fold: the staging-only counterpart to the
// weekly scheduled-rebuild.ts, built specifically for the real xkas-9n43
// gap this investigation found. Deliberately NOT a variant of
// stream-into-staging.ts (which streams a WHOLE dataset via :id-keyset
// pagination with no day boundaries) -- this fetches and folds one real
// calendar day at a time, so each day can be independently checked for
// stability, classified, and ledgered, and so a day already folded is
// never re-fetched by a later run.

// --- Pure decision logic ---------------------------------------------------

// Sunday is a confirmed, dataset-wide, EXPECTED zero (free parking, no
// paid-occupancy transactions at all -- live-verified earlier this
// investigation), never an anomaly -- classified 'folded' unconditionally,
// never 'low_volume', regardless of count.
const SUNDAY_JS_DAY = 0;

// How far below the recent real median a day's row count must fall to be
// flagged, rather than guessed at: the one real anomaly actually found
// this investigation (Aug 13-14 2026 in rke9-rsvs) ran at ~57-62% of a
// normal day's volume -- 70% sits comfortably above that, so it would
// have caught the real case found without being so tight it flags
// ordinary day-to-day variation.
const LOW_VOLUME_THRESHOLD_FRACTION = 0.7;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2 : (sorted[mid] as number);
}

export function classifyDayVolume(date: string, rowCount: number, recentStableCounts: readonly number[]): "folded" | "low_volume" {
  const jsDay = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (jsDay === SUNDAY_JS_DAY) {
    return "folded";
  }
  if (recentStableCounts.length === 0) {
    // No real baseline yet this run -- nothing honest to compare against.
    return "folded";
  }
  const baseline = median(recentStableCounts);
  if (baseline === 0) {
    return "folded";
  }
  return rowCount < baseline * LOW_VOLUME_THRESHOLD_FRACTION ? "low_volume" : "folded";
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function buildDayWhereClause(isoDate: string): string {
  const next = addDays(isoDate, 1);
  return `occupancydatetime >= '${isoDate}T00:00:00' AND occupancydatetime < '${next}T00:00:00'`;
}

// --- Socrata reads -----------------------------------------------------

async function fetchDayRowCount(datasetUrl: string, isoDate: string): Promise<number> {
  const url = new URL(datasetUrl);
  url.searchParams.set("$select", "count(*) as n");
  url.searchParams.set("$where", buildDayWhereClause(isoDate));
  const response = await fetch(url.toString(), { headers: buildRequestHeaders() });
  if (!response.ok) {
    throw new Error(`fetchDayRowCount: request for ${isoDate} failed with status ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as { n?: string }[];
  const n = body[0]?.n;
  if (n === undefined) {
    throw new Error(`fetchDayRowCount: unexpected response shape for ${isoDate}: ${JSON.stringify(body)}`);
  }
  return Number(n);
}

// The real stability safeguard this catch-up was built for (see this
// investigation's own finding: successive reads of a live Socrata
// rolling-window dataset seconds apart can genuinely disagree). A day is
// only safe to fold once two independent reads of its own row count
// agree -- disagreement means skip, retry a later run, never fold.
export interface DayCountStability {
  stable: boolean;
  count: number | null;
}

export async function fetchDayRowCountTwice(datasetUrl: string, isoDate: string): Promise<DayCountStability> {
  const first = await fetchDayRowCount(datasetUrl, isoDate);
  const second = await fetchDayRowCount(datasetUrl, isoDate);
  return first === second ? { stable: true, count: first } : { stable: false, count: null };
}

async function fetchDatasetEarliestDate(datasetUrl: string): Promise<string> {
  const url = new URL(datasetUrl);
  url.searchParams.set("$select", "min(occupancydatetime) as earliest");
  const response = await fetch(url.toString(), { headers: buildRequestHeaders() });
  if (!response.ok) {
    throw new Error(`fetchDatasetEarliestDate: request failed with status ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as { earliest?: string }[];
  const earliest = body[0]?.earliest;
  if (earliest === undefined) {
    throw new Error(`fetchDatasetEarliestDate: unexpected response shape: ${JSON.stringify(body)}`);
  }
  return earliest.slice(0, 10);
}

// --- Orchestration -------------------------------------------------------

export interface CatchUpFoldClients {
  blockfaceLookupClient: BlockfaceLookupSupabaseClient;
  bucketsClient: ArchiveStreamAccumulatorBucketsSupabaseClient;
  ledgerClient: RollingWindowFoldLedgerSupabaseClient;
}

export interface CatchUpFoldOptions {
  logicalWindow: string;
  sourceDatasetId: string;
  sourceDatasetUrl: string;
  stagingIdentity: string;
  // A day only becomes eligible once it is at least this many days old as
  // of `now` -- pinned once at the start of the run (see
  // computeUpperBoundDate), never re-evaluated mid-run.
  minAgeDays: number;
  // Real, already-confirmed permanent gap dates (e.g. 2026-09-02 through
  // 2026-09-07) to record once, if not already recorded, before
  // considering anything else.
  permanentGapDates: readonly string[];
  now: Date;
}

export interface DayOutcome {
  date: string;
  outcome: "folded" | "low_volume" | "skipped_unstable" | "already_ledgered" | "permanent_gap";
  rowCount: number | null;
}

export interface CatchUpFoldResult {
  stagingIdentity: string;
  upperBoundDate: string;
  days: DayOutcome[];
  bucketsWritten: number;
}

export async function runCatchUpFold(clients: CatchUpFoldClients, options: CatchUpFoldOptions): Promise<CatchUpFoldResult> {
  const ledger = await fetchLedgeredDates(clients.ledgerClient, options.logicalWindow);
  const days: DayOutcome[] = [];

  for (const date of options.permanentGapDates) {
    if (!ledger.has(date)) {
      await recordLedgerEntry(clients.ledgerClient, {
        logicalWindow: options.logicalWindow,
        date,
        sourceDatasetId: null,
        rowCountAtFold: null,
        status: "permanent_gap",
        foldedAt: options.now,
      });
      ledger.set(date, { date, sourceDatasetId: null, rowCountAtFold: null, foldedAt: options.now.toISOString(), status: "permanent_gap" });
    }
    days.push({ date, outcome: "permanent_gap", rowCount: null });
  }

  const upperBoundDate = computeUpperBoundDate(options.now, options.minAgeDays);
  const earliestDate = await fetchDatasetEarliestDate(options.sourceDatasetUrl);
  const candidateDates = enumerateDates(earliestDate, addDays(upperBoundDate, 1)).filter((d) => !ledger.has(d));

  console.log(`Catch-up fold: logical_window="${options.logicalWindow}", source="${options.sourceDatasetId}", staging="${options.stagingIdentity}"`);
  console.log(`Pinned upper bound (now - ${options.minAgeDays}d): ${upperBoundDate}. Real source earliest: ${earliestDate}. Candidate days: ${candidateDates.length}.`);

  const lookup = await buildBlockfaceLookup(clients.blockfaceLookupClient);
  const accumulators = new Map<string, WeightedStatsAccumulator>();
  const existingSnapshot = await fetchAccumulatorBuckets(clients.bucketsClient, options.stagingIdentity);
  const seededCount = mergeAccumulatorSnapshot(accumulators, existingSnapshot);
  console.log(`Seeded ${seededCount} pre-existing buckets from staging identity "${options.stagingIdentity}" (the copied-live baseline).`);

  const recentStableCounts: number[] = [];

  for (const date of candidateDates) {
    const stability = await fetchDayRowCountTwice(options.sourceDatasetUrl, date);
    if (!stability.stable) {
      console.log(`[${date}] SKIPPED: row count unstable across two reads -- will retry on a later run.`);
      days.push({ date, outcome: "skipped_unstable", rowCount: null });
      continue;
    }

    const count = stability.count as number;
    if (count === 0) {
      await recordLedgerEntry(clients.ledgerClient, { logicalWindow: options.logicalWindow, date, sourceDatasetId: options.sourceDatasetId, rowCountAtFold: 0, status: "folded", foldedAt: options.now });
      console.log(`[${date}] folded: 0 real rows (confirmed stable) -- nothing to fold.`);
      days.push({ date, outcome: "folded", rowCount: 0 });
      continue;
    }

    let chunkIndex = 0;
    let lastChunkEndedAt = Date.now();
    await fetchSocrataRecordsPaginated(options.sourceDatasetUrl, buildDayWhereClause(date), (page) => {
      const sincePrevMs = Date.now() - lastChunkEndedAt;
      const foldStartedAt = Date.now();
      const foldResult = foldReadingsIntoAccumulators(page, accumulators, lookup, options.now);
      const foldMs = Date.now() - foldStartedAt;
      chunkIndex += 1;
      console.log(`[${date}] chunk ${chunkIndex}: rows=${page.length}, sincePrevChunkMs=${sincePrevMs} (fetch+overhead), foldMs=${foldMs}, unmatched=${foldResult.unmatchedCount}, parseFailures=${foldResult.parseFailures}`);
      lastChunkEndedAt = Date.now();
    });

    const baselineForLog = recentStableCounts.length > 0 ? median(recentStableCounts) : count;
    const status = classifyDayVolume(date, count, recentStableCounts);
    recentStableCounts.push(count);
    await recordLedgerEntry(clients.ledgerClient, { logicalWindow: options.logicalWindow, date, sourceDatasetId: options.sourceDatasetId, rowCountAtFold: count, status, foldedAt: options.now });
    console.log(`[${date}] ${status}: real row count=${count}${status === "low_volume" ? ` (below ${(LOW_VOLUME_THRESHOLD_FRACTION * 100).toFixed(0)}% of recent median ${baselineForLog})` : ""}.`);
    days.push({ date, outcome: status, rowCount: count });
  }

  await upsertAccumulatorBuckets(clients.bucketsClient, options.stagingIdentity, Object.fromEntries(accumulators) as AccumulatorSnapshot);
  console.log(`Persisted ${accumulators.size} total buckets to staging identity "${options.stagingIdentity}".`);

  return { stagingIdentity: options.stagingIdentity, upperBoundDate, days, bucketsWritten: accumulators.size };
}

// --- CLI glue ---------------------------------------------------------------

function getRequiredEnvVar(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`catch-up-fold-days: missing required environment variable ${name} (see .env.example)`);
  }
  return value;
}

export async function main(): Promise<void> {
  const supabaseUrl = getRequiredEnvVar("SUPABASE_URL");
  const supabaseServiceRoleKey = getRequiredEnvVar("SUPABASE_SERVICE_ROLE_KEY");

  const rawSupabaseClient = createClient(supabaseUrl, supabaseServiceRoleKey);
  const clients: CatchUpFoldClients = {
    blockfaceLookupClient: rawSupabaseClient as unknown as BlockfaceLookupSupabaseClient,
    bucketsClient: rawSupabaseClient as unknown as ArchiveStreamAccumulatorBucketsSupabaseClient,
    ledgerClient: rawSupabaseClient as unknown as RollingWindowFoldLedgerSupabaseClient,
  };

  const stagingArg = process.argv.find((a) => a.startsWith("--staging-identity="));
  if (stagingArg === undefined) {
    throw new Error("catch-up-fold-days: --staging-identity=<name> is required");
  }
  const stagingIdentity = stagingArg.slice("--staging-identity=".length);

  const result = await runCatchUpFold(clients, {
    logicalWindow: "seattle-paid-parking-rolling-30-day",
    sourceDatasetId: "xkas-9n43",
    sourceDatasetUrl: "https://data.seattle.gov/resource/xkas-9n43.json",
    stagingIdentity,
    minAgeDays: 3,
    permanentGapDates: ["2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07"],
    now: new Date(),
  });

  console.log("\n=== catch-up-fold-days summary ===");
  console.log(`Staging identity: ${result.stagingIdentity}`);
  console.log(`Upper bound date: ${result.upperBoundDate}`);
  console.log(`Buckets written:  ${result.bucketsWritten}`);
  for (const day of result.days) {
    console.log(`  ${day.date}: ${day.outcome}${day.rowCount !== null ? ` (n=${day.rowCount})` : ""}`);
  }
  console.log("====================================\n");
}

const isRunDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isRunDirectly) {
  main().catch((error: unknown) => {
    console.error("catch-up-fold-days: fatal error:", error);
    process.exitCode = 1;
  });
}
