import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fitAreaCalibrationsWithFallback } from "../scoring/areaCorrectionCalibration.ts";
import type { GroupedCalibrationPairs } from "../scoring/areaCorrectionCalibration.ts";
import {
  formatAreaCorrectionValidationReport,
  runAreaCorrectionValidation,
  runGate3PooledAcrossAreas,
  runGate3TransactionCoverageConfirmation,
} from "./backtest-predictions.ts";
import type { GateResult } from "./backtest-predictions.ts";

// Ties fetch-annual-study-calibration-data.ts's real train/held-out data
// to a real fit (fitAreaCalibrationsWithFallback) and all three gates
// (runAreaCorrectionValidation), and prints the result. Entirely
// read-only against Supabase -- this script never touches
// area_occupancy_corrections, written or otherwise; it only reads the
// local calibration-data/*.json files fetch-annual-study-calibration-data.ts
// already produced. Run this BEFORE fit-and-write-area-corrections.ts
// --write, not after: the whole point is deciding whether that real write
// should happen at all.

export async function main(): Promise<void> {
  const dataDir = path.join(process.cwd(), "calibration-data");
  const trainGroups = JSON.parse(await readFile(path.join(dataDir, "annual-study-train.json"), "utf-8")) as GroupedCalibrationPairs[];
  const holdoutGroups = JSON.parse(await readFile(path.join(dataDir, "annual-study-holdout.json"), "utf-8")) as GroupedCalibrationPairs[];

  console.log(`Loaded ${trainGroups.length} training groups, ${holdoutGroups.length} held-out groups.`);

  const calibrations = fitAreaCalibrationsWithFallback(trainGroups);
  console.log(`Fit ${calibrations.length} area/subarea calibrations from the training split.\n`);

  const report = runAreaCorrectionValidation(calibrations, holdoutGroups);
  console.log(formatAreaCorrectionValidationReport(report));

  // Additional, EXPLICITLY SEPARATE analysis -- not part of allGatesPassed
  // above, and not a redefinition of what "passing" gate 3 means. See
  // runGate3TransactionCoverageConfirmation's own comment for why the
  // transaction-coverage rebuild is reported alongside the physical-count
  // gate rather than merged into it, and runGate3PooledAcrossAreas' own
  // comment for why a pooled result doesn't substitute for the per-area
  // claim above.
  console.log("\n\n=== Additional gate-3 analysis (informational only -- NOT part of allGatesPassed) ===\n");

  const formatResult = (g: GateResult): string => `  [${g.passed ? "PASS" : "FAIL"}] ${g.gateName}: ${g.details}`;

  console.log("Transaction-coverage confirmation, per area (does the correction move predictions closer to the independently-reconstructed paid-coverage figure? A genuinely different question from physical-truth accuracy):");
  for (const g of runGate3TransactionCoverageConfirmation(calibrations)) {
    console.log(formatResult(g));
  }

  console.log("\nPooled-across-areas gate 3 (the coarser \"does the correction help overall, across the areas actually tested\" question -- NOT a per-area confidence claim):");
  const pooled = runGate3PooledAcrossAreas(calibrations);
  console.log(formatResult(pooled.physicalCount));
  console.log(formatResult(pooled.transactionCoverage));
}

const isRunDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isRunDirectly) {
  main().catch((error: unknown) => {
    console.error("validate-area-corrections: fatal error:", error);
    process.exitCode = 1;
  });
}
