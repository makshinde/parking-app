import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { fitAreaCalibrationsWithFallback } from "../scoring/areaCorrectionCalibration.ts";
import type { AreaCalibration, GroupedCalibrationPairs } from "../scoring/areaCorrectionCalibration.ts";

// Fits the area-aware calibration from the real training data
// fetch-annual-study-calibration-data.ts already gathered, and prints
// exactly what it would write. Writing to area_occupancy_corrections
// requires the explicit --write flag; the default is a dry run -- per
// this build's own instructions, the calibration table does not get
// populated with real, live data without that explicit confirmation.
//
// --area/--subarea optionally scope BOTH the dry-run display and the
// real write down to exactly one fitted calibration (e.g. a single,
// staged Tier 1 row like Ballard/Core), instead of the full fitted set --
// for a staged rollout where only some rows have cleared every gate,
// writing everything would deploy far more than intended. --area alone
// (no --subarea) means that area's bare, area-level fallback row
// (paidParkingSubarea IS NULL), matching how null subarea is treated
// everywhere else in this pipeline.

export interface CliOptions {
  write: boolean;
  area: string | null;
  subarea: string | null;
}

function parseFlag(argv: readonly string[], key: string): string | null {
  const prefix = `--${key}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  return match === undefined ? null : match.slice(prefix.length);
}

export function parseCliOptions(argv: readonly string[]): CliOptions {
  return { write: argv.includes("--write"), area: parseFlag(argv, "area"), subarea: parseFlag(argv, "subarea") };
}

// Pure so the scoping logic (and the "no --area means everything" default)
// is directly testable without touching the network or Supabase.
export function filterCalibrationsForScope(calibrations: readonly AreaCalibration[], area: string | null, subarea: string | null): AreaCalibration[] {
  if (area === null) return [...calibrations];
  return calibrations.filter((c) => c.paidParkingArea === area && c.paidParkingSubarea === subarea);
}

export interface WriteSupabaseQueryResult {
  data: { id: string }[] | null;
  error: { message: string } | null;
}

export interface WriteSupabaseTableBuilder {
  upsert(values: Record<string, unknown>[], options: { onConflict: string }): {
    select(columns: string): PromiseLike<WriteSupabaseQueryResult>;
  };
}

export interface WriteSupabaseClient {
  from(table: string): WriteSupabaseTableBuilder;
}

function buildRows(calibrations: readonly AreaCalibration[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const calibration of calibrations) {
    for (const band of calibration.bands) {
      rows.push({
        paidparkingarea: calibration.paidParkingArea,
        paidparkingsubarea: calibration.paidParkingSubarea,
        predicted_band_low: band.predictedBandLow,
        predicted_band_high: band.predictedBandHigh,
        corrected_pct: band.correctedPct,
        sample_count: band.sampleCount,
      });
    }
  }
  return rows;
}

export async function writeAreaCorrections(supabaseClient: WriteSupabaseClient, calibrations: readonly AreaCalibration[]): Promise<{ writtenCount: number; errorMessage: string | null }> {
  const rows = buildRows(calibrations);
  if (rows.length === 0) {
    return { writtenCount: 0, errorMessage: null };
  }
  const { data, error } = await supabaseClient
    .from("area_occupancy_corrections")
    .upsert(rows, { onConflict: "paidparkingarea,paidparkingsubarea,predicted_band_low" })
    .select("id");

  if (error !== null) {
    return { writtenCount: 0, errorMessage: error.message };
  }
  return { writtenCount: data?.length ?? 0, errorMessage: null };
}

function formatCalibration(calibration: AreaCalibration): string {
  const label = calibration.paidParkingSubarea === null ? calibration.paidParkingArea : `${calibration.paidParkingArea} / ${calibration.paidParkingSubarea}`;
  const bandLines = calibration.bands
    .map((band) => `    [${band.predictedBandLow}-${band.predictedBandHigh}) -> ${band.correctedPct.toFixed(1)}% (n=${band.sampleCount})`)
    .join("\n");
  return `  ${label}:\n${bandLines}`;
}

function getRequiredEnvVar(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`fit-and-write-area-corrections: missing required environment variable ${name} (see .env.example)`);
  }
  return value;
}

export async function main(): Promise<void> {
  const { write, area, subarea } = parseCliOptions(process.argv.slice(2));

  const trainPath = path.join(process.cwd(), "calibration-data", "annual-study-train.json");
  const trainGroups = JSON.parse(await readFile(trainPath, "utf-8")) as GroupedCalibrationPairs[];
  console.log(`Loaded ${trainGroups.length} (area, subarea) groups from ${trainPath}.`);

  const allCalibrations = fitAreaCalibrationsWithFallback(trainGroups);
  console.log(`\nFit ${allCalibrations.length} area/subarea calibrations total with enough real evidence.`);

  const calibrations = filterCalibrationsForScope(allCalibrations, area, subarea);
  if (area !== null) {
    const label = subarea === null ? area : `${area} / ${subarea}`;
    if (calibrations.length === 0) {
      console.log(`\nNo fitted calibration matches the requested scope (${label}) -- nothing to show or write.`);
      return;
    }
    console.log(`Scoped to "${label}" only (--area${subarea === null ? "" : "/--subarea"} passed) -- ${calibrations.length} of ${allCalibrations.length} fitted calibrations match this exact scope:\n`);
  } else {
    console.log("No --area given -- this would write the FULL fitted set:\n");
  }
  for (const calibration of calibrations) {
    console.log(formatCalibration(calibration));
  }

  // Skipped-evidence reporting is about the fit's overall coverage, not
  // this run's write scope -- only worth printing on a full, unscoped run,
  // where it's the whole picture rather than noise next to one requested row.
  if (area === null) {
    const skippedGroups = trainGroups.filter(
      (group) => !allCalibrations.some((c) => c.paidParkingArea === group.paidParkingArea && c.paidParkingSubarea === group.paidParkingSubarea),
    );
    if (skippedGroups.length > 0) {
      console.log("\nGroups with insufficient evidence (no correction fit, left uncorrected):");
      for (const group of skippedGroups) {
        const label = group.paidParkingSubarea === null ? group.paidParkingArea : `${group.paidParkingArea} / ${group.paidParkingSubarea}`;
        console.log(`  ${label}: ${group.pairs.length} pairs`);
      }
    }
  }

  if (!write) {
    console.log(`\nDry run (default) -- nothing written. Pass --write to actually write exactly the ${calibrations.length} row-generating calibration(s) shown above to area_occupancy_corrections.`);
    return;
  }

  console.log(`\n--write passed -- writing exactly the ${calibrations.length} calibration(s) shown above to area_occupancy_corrections...`);
  const supabaseUrl = getRequiredEnvVar("SUPABASE_URL");
  const supabaseServiceRoleKey = getRequiredEnvVar("SUPABASE_SERVICE_ROLE_KEY");
  const supabaseClient = createClient(supabaseUrl, supabaseServiceRoleKey) as unknown as WriteSupabaseClient;
  const result = await writeAreaCorrections(supabaseClient, calibrations);
  if (result.errorMessage !== null) {
    throw new Error(`fit-and-write-area-corrections: write failed: ${result.errorMessage}`);
  }
  console.log(`Wrote ${result.writtenCount} band rows.`);
}

const isRunDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isRunDirectly) {
  main().catch((error: unknown) => {
    console.error("fit-and-write-area-corrections: fatal error:", error);
    process.exitCode = 1;
  });
}
