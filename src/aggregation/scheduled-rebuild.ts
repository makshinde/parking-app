import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import { buildBlockfaceLookup, type BlockfaceLookupSupabaseClient } from "./blockfaceLookup.ts";
import { streamArchiveIntoStaging } from "./stream-into-staging.ts";
import { resolveYearlyArchiveDatasetId, getPriorYear } from "./resolveYearlyArchive.ts";
import type { ArchiveStreamAccumulatorBucketsSupabaseClient, ArchiveStreamCheckpointSupabaseClient } from "./streamArchiveWithResume.ts";
import { checkAndRecordCoverage, type RollingWindowRefreshLogSupabaseClient } from "./rollingWindowRefreshLog.ts";
import { reconcileOccupancyStatsFromAccumulator } from "./reconcile-occupancy-stats.ts";
import { logBucketFailure, runRetryPass, type BackfillFailuresSupabaseClient } from "./backfill-occupancy-stats.ts";
import type { OccupancyStatsSupabaseClient } from "./upsertOccupancyStats.ts";
import { verifyAccumulatorIntegrity, compareOccupancyStatsToAccumulator, type OccupancyStatsBulkReadSupabaseClient } from "./accumulatorIntegrity.ts";
import {
  fetchLatestRebuildRun,
  startRebuildRun,
  advanceRebuildRunStep,
  finishRebuildRun,
  decideResumeAction,
  type ScheduledRebuildRunsSupabaseClient,
} from "./scheduledRebuildRunsLog.ts";
import { createGithubIssue, parseGithubRepository } from "../utils/githubIssue.ts";

// The weekly, scheduled version of CLAUDE.md's "Rebuild policy" section --
// duplicates the stable archive base fresh, folds in the current
// rke9-rsvs rolling window, runs the gap-detection safeguard, and promotes
// only if every real check passes, exactly the same sequence already
// proven live by hand during the Q1 2026 ingestion. The one genuinely new
// piece of behavior this script adds is making the promote/verify steps
// (previously manual) into real, atomic, always-run code -- see
// accumulatorIntegrity.ts and migrations/028's promote_accumulator_identity.

const ROLLING_WINDOW_DATASET_ID = "rke9-rsvs";
const SOCRATA_BASE_URL = "https://data.seattle.gov/resource";

function buildSocrataDatasetUrl(datasetId: string): string {
  return `${SOCRATA_BASE_URL}/${datasetId}.json`;
}

export interface PromoteAccumulatorIdentityRpcClient {
  rpc(
    fn: "promote_accumulator_identity",
    args: { p_stable_identity: string; p_staging_identity: string; p_backup_identity: string },
  ): PromiseLike<{ data: null; error: { message: string } | null }>;
}

export interface ScheduledRebuildClients {
  blockfaceLookupClient: BlockfaceLookupSupabaseClient;
  checkpointClient: ArchiveStreamCheckpointSupabaseClient;
  bucketsClient: ArchiveStreamAccumulatorBucketsSupabaseClient;
  refreshLogClient: RollingWindowRefreshLogSupabaseClient;
  occupancyStatsClient: OccupancyStatsSupabaseClient;
  occupancyStatsBulkReadClient: OccupancyStatsBulkReadSupabaseClient;
  failuresClient: BackfillFailuresSupabaseClient;
  runsLogClient: ScheduledRebuildRunsSupabaseClient;
  promoteRpcClient: PromoteAccumulatorIdentityRpcClient;
}

export interface ScheduledRebuildResult {
  runId: string;
  outcome: "succeeded" | "failed";
  failureReason: string | null;
  promoted: boolean;
  dryRun: boolean;
}

export interface ScheduledRebuildOptions {
  // Defaults to false: streams, gap-checks, and integrity-checks exactly
  // as a real run would, then stops BEFORE calling the promote RPC at
  // all. Both the manual CLI (--allow-promotion) and the (not yet added)
  // scheduled trigger must default this to false -- promotion is only
  // ever attempted when something explicitly, deliberately turns it on
  // for that one run.
  allowPromotion: boolean;
}

async function callPromoteAccumulatorIdentity(
  client: PromoteAccumulatorIdentityRpcClient,
  stableIdentity: string,
  stagingIdentity: string,
  backupIdentity: string,
): Promise<void> {
  const { error } = await client.rpc("promote_accumulator_identity", {
    p_stable_identity: stableIdentity,
    p_staging_identity: stagingIdentity,
    p_backup_identity: backupIdentity,
  });
  if (error !== null) {
    throw new Error(`promote_accumulator_identity RPC failed: ${error.message}`);
  }
}

// Shared tail end of the pipeline for BOTH the fresh path and the resumed
// path: reconcile occupancy_stats from the now-promoted stable identity's
// accumulator state, retry any individual write failures, then run the
// final stale-row comparison. Neither path re-streams or re-promotes --
// by the time this runs, promotion has already genuinely happened, either
// just now (fresh path) or on an earlier, failed run (resumed path).
async function reconcileAndVerify(
  clients: ScheduledRebuildClients,
  runId: string,
  stableIdentity: string,
  now: Date,
): Promise<ScheduledRebuildResult> {
  await advanceRebuildRunStep(clients.runsLogClient, runId, "reconciling");
  const reconcileResult = await reconcileOccupancyStatsFromAccumulator(clients.bucketsClient, clients.occupancyStatsClient, stableIdentity);
  for (const failure of reconcileResult.failures) {
    await logBucketFailure(clients.failuresClient, {
      blockfaceId: failure.blockfaceId,
      isoDay: failure.isoDay,
      hour: failure.hour,
      stats: failure.stats,
      errorMessage: failure.errorMessage,
    });
  }
  await runRetryPass({ occupancyStatsClient: clients.occupancyStatsClient, failuresClient: clients.failuresClient });

  await advanceRebuildRunStep(clients.runsLogClient, runId, "verifying");
  const staleReport = await compareOccupancyStatsToAccumulator(clients.bucketsClient, clients.occupancyStatsBulkReadClient, stableIdentity);
  if (staleReport.staleCount > 0) {
    const reason = `${staleReport.staleCount} stale occupancy_stats row(s) remain after reconcile -- samples: ${JSON.stringify(staleReport.staleSamples.slice(0, 5))}`;
    await finishRebuildRun(clients.runsLogClient, runId, { status: "failed", failureReason: reason }, now);
    return { runId, outcome: "failed", failureReason: reason, promoted: true, dryRun: false };
  }

  await finishRebuildRun(clients.runsLogClient, runId, { status: "succeeded" }, now);
  return { runId, outcome: "succeeded", failureReason: null, promoted: true, dryRun: false };
}

export async function runScheduledRebuild(clients: ScheduledRebuildClients, now: Date, options: ScheduledRebuildOptions = { allowPromotion: false }): Promise<ScheduledRebuildResult> {
  const stableIdentity = resolveYearlyArchiveDatasetId(getPriorYear(now));
  const previousRun = await fetchLatestRebuildRun(clients.runsLogClient, stableIdentity);
  const resumeDecision = decideResumeAction(previousRun);

  if (resumeDecision.action === "resume_from_reconcile") {
    // Not gated by options.allowPromotion -- promotion already genuinely
    // happened on the earlier run; finishing reconcile/verify here is
    // mandatory regardless, or occupancy_stats is left permanently out of
    // sync with the already-promoted accumulator. A resumed run is never
    // itself a dry run.
    console.log(`Previous run already promoted (backup identity "${resumeDecision.backupIdentity}") but didn't finish -- resuming from reconcile against "${stableIdentity}", no re-streaming or re-promoting.`);
    const runId = await startRebuildRun(clients.runsLogClient, {
      stableIdentity,
      stagingIdentity: previousRun?.stagingIdentity ?? stableIdentity,
      backupIdentity: resumeDecision.backupIdentity,
      startedAt: now,
      startStep: "reconciling",
      dryRun: false,
    });
    return reconcileAndVerify(clients, runId, stableIdentity, now);
  }

  const stagingIdentity = `${stableIdentity}-staging-${now.getTime()}`;
  const runId = await startRebuildRun(clients.runsLogClient, { stableIdentity, stagingIdentity, startedAt: now, dryRun: !options.allowPromotion });

  try {
    console.log(`Building blockface lookup...`);
    const lookup = await buildBlockfaceLookup(clients.blockfaceLookupClient);

    console.log(`Folding stable archive "${stableIdentity}" into staging identity "${stagingIdentity}"...`);
    const archiveResult = await streamArchiveIntoStaging(
      { checkpointClient: clients.checkpointClient, bucketsClient: clients.bucketsClient },
      lookup,
      { sourceDataset: stableIdentity, storageIdentity: stagingIdentity, maxChunks: null },
      now,
    );
    if (archiveResult.stoppedEarly) {
      throw new Error("archive fold stopped early unexpectedly -- maxChunks must be unset for a real scheduled run");
    }

    await advanceRebuildRunStep(clients.runsLogClient, runId, "streaming_rolling_window");
    console.log(`Folding current rolling window "${ROLLING_WINDOW_DATASET_ID}" into the SAME staging identity...`);
    const rollingResult = await streamArchiveIntoStaging(
      { checkpointClient: clients.checkpointClient, bucketsClient: clients.bucketsClient },
      lookup,
      { sourceDataset: ROLLING_WINDOW_DATASET_ID, storageIdentity: stagingIdentity, maxChunks: null },
      now,
    );
    if (rollingResult.stoppedEarly) {
      throw new Error("rolling-window fold stopped early unexpectedly -- maxChunks must be unset for a real scheduled run");
    }

    await advanceRebuildRunStep(clients.runsLogClient, runId, "gap_check");
    console.log("Running the gap-detection safeguard against rke9-rsvs's real, current coverage...");
    const { gapResult } = await checkAndRecordCoverage(clients.refreshLogClient, buildSocrataDatasetUrl(ROLLING_WINDOW_DATASET_ID), ROLLING_WINDOW_DATASET_ID, now);
    if (gapResult.gapDetected) {
      const reason = gapResult.gapDetail ?? "gap detected";
      await finishRebuildRun(clients.runsLogClient, runId, { status: "failed", failureReason: reason }, now);
      return { runId, outcome: "failed", failureReason: reason, promoted: false, dryRun: !options.allowPromotion };
    }

    await advanceRebuildRunStep(clients.runsLogClient, runId, "integrity_check", { gapDetected: false });
    console.log("Verifying the staging identity's internal consistency...");
    const integrity = await verifyAccumulatorIntegrity(clients.bucketsClient, stagingIdentity, stableIdentity);
    if (!integrity.ok) {
      const reason = `integrity check failed (${integrity.problems.length} problem(s)): ${integrity.problems.slice(0, 5).map((p) => `${p.bucketKey}: ${p.reason}`).join("; ")}`;
      await finishRebuildRun(clients.runsLogClient, runId, { status: "failed", failureReason: reason }, now);
      return { runId, outcome: "failed", failureReason: reason, promoted: false, dryRun: !options.allowPromotion };
    }

    if (!options.allowPromotion) {
      console.log(`Dry run (--allow-promotion not passed): streaming, gap check, and integrity check all passed. Stopping here -- "${stagingIdentity}" was never promoted, "${stableIdentity}" was never touched.`);
      await finishRebuildRun(clients.runsLogClient, runId, { status: "succeeded", step: "dry_run_complete" }, now);
      return { runId, outcome: "succeeded", failureReason: null, promoted: false, dryRun: true };
    }

    const backupIdentity = `${stableIdentity}-backup-${now.getTime()}`;
    await advanceRebuildRunStep(clients.runsLogClient, runId, "promoting", { backupIdentity });
    console.log(`All checks passed -- promoting "${stagingIdentity}" to "${stableIdentity}" (backing up the current live identity as "${backupIdentity}")...`);
    await callPromoteAccumulatorIdentity(clients.promoteRpcClient, stableIdentity, stagingIdentity, backupIdentity);

    return reconcileAndVerify(clients, runId, stableIdentity, now);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishRebuildRun(clients.runsLogClient, runId, { status: "failed", failureReason: message }, now).catch((logErr: unknown) => {
      console.error(`scheduled-rebuild: additionally failed to record this run's failure: ${logErr instanceof Error ? logErr.message : String(logErr)}`);
    });
    return { runId, outcome: "failed", failureReason: message, promoted: false, dryRun: !options.allowPromotion };
  }
}

// --- Notification -----------------------------------------------------------

async function reportFailure(result: ScheduledRebuildResult, githubToken: string, githubRepository: string): Promise<void> {
  await createGithubIssue(githubToken, {
    repository: parseGithubRepository(githubRepository),
    title: `Scheduled rolling-window refresh failed (run ${result.runId})`,
    body: [
      "The weekly scheduled rolling-window refresh (src/aggregation/scheduled-rebuild.ts) failed.",
      "",
      `**Dry run:** ${result.dryRun ? "yes -- promotion was never attempted on this run regardless of this failure" : "no -- this was a real, promotion-eligible attempt"}`,
      `**Promoted:** ${result.promoted ? "yes -- the live accumulator identity WAS already renamed before this failure" : "no -- the live accumulator identity was never touched"}`,
      "",
      `**Failure reason:**`,
      "```",
      result.failureReason ?? "(no reason recorded)",
      "```",
      "",
      "See the `scheduled_rebuild_runs` table (this run's id above) for the full real record of how far it got.",
    ].join("\n"),
    labels: ["automated", "scheduled-rebuild"],
  });
}

// --- CLI glue ---------------------------------------------------------------

// Absent means dry-run, the same "the safe behavior needs no flag" default
// used by fit-and-write-area-corrections.ts's own --write.
export function parseCliOptions(argv: readonly string[]): ScheduledRebuildOptions {
  return { allowPromotion: argv.includes("--allow-promotion") };
}

function getRequiredEnvVar(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`scheduled-rebuild: missing required environment variable ${name} (see .env.example)`);
  }
  return value;
}

export async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  console.log(options.allowPromotion ? "--allow-promotion passed: this run MAY actually promote if every check passes." : "Dry run (default, no --allow-promotion): will check everything but never promote.");

  const supabaseUrl = getRequiredEnvVar("SUPABASE_URL");
  const supabaseServiceRoleKey = getRequiredEnvVar("SUPABASE_SERVICE_ROLE_KEY");
  getRequiredEnvVar("SOCRATA_APP_TOKEN");

  const rawSupabaseClient = createClient(supabaseUrl, supabaseServiceRoleKey);
  const clients: ScheduledRebuildClients = {
    blockfaceLookupClient: rawSupabaseClient as unknown as BlockfaceLookupSupabaseClient,
    checkpointClient: rawSupabaseClient as unknown as ArchiveStreamCheckpointSupabaseClient,
    bucketsClient: rawSupabaseClient as unknown as ArchiveStreamAccumulatorBucketsSupabaseClient,
    refreshLogClient: rawSupabaseClient as unknown as RollingWindowRefreshLogSupabaseClient,
    occupancyStatsClient: rawSupabaseClient as unknown as OccupancyStatsSupabaseClient,
    occupancyStatsBulkReadClient: rawSupabaseClient as unknown as OccupancyStatsBulkReadSupabaseClient,
    failuresClient: rawSupabaseClient as unknown as BackfillFailuresSupabaseClient,
    runsLogClient: rawSupabaseClient as unknown as ScheduledRebuildRunsSupabaseClient,
    promoteRpcClient: rawSupabaseClient as unknown as PromoteAccumulatorIdentityRpcClient,
  };

  const result = await runScheduledRebuild(clients, new Date(), options);

  console.log("\n=== scheduled-rebuild summary ===");
  console.log(`Run id:    ${result.runId}`);
  console.log(`Dry run:   ${result.dryRun}`);
  console.log(`Outcome:   ${result.outcome}`);
  console.log(`Promoted:  ${result.promoted}`);
  if (result.failureReason !== null) {
    console.log(`Reason:    ${result.failureReason}`);
  }
  console.log("==================================\n");

  if (result.outcome === "failed") {
    const githubToken = process.env["GITHUB_TOKEN"];
    const githubRepository = process.env["GITHUB_REPOSITORY"];
    if (githubToken !== undefined && githubRepository !== undefined) {
      await reportFailure(result, githubToken, githubRepository);
    } else {
      console.warn("scheduled-rebuild: GITHUB_TOKEN/GITHUB_REPOSITORY not set -- skipping the failure-notification issue (expected when running locally, not in GitHub Actions).");
    }
    process.exitCode = 1;
  }
}

const isRunDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isRunDirectly) {
  main().catch((error: unknown) => {
    console.error("scheduled-rebuild: fatal error:", error);
    process.exitCode = 1;
  });
}
