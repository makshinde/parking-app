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

export interface CliOptions {
  write: boolean;
}

export function parseCliOptions(argv: readonly string[]): CliOptions {
  return { write: argv.includes("--write") };
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
  const { write } = parseCliOptions(process.argv.slice(2));

  const trainPath = path.join(process.cwd(), "calibration-data", "annual-study-train.json");
  const trainGroups = JSON.parse(await readFile(trainPath, "utf-8")) as GroupedCalibrationPairs[];
  console.log(`Loaded ${trainGroups.length} (area, subarea) groups from ${trainPath}.`);

  const calibrations = fitAreaCalibrationsWithFallback(trainGroups);
  console.log(`\nFit ${calibrations.length} area/subarea calibrations with enough real evidence:\n`);
  for (const calibration of calibrations) {
    console.log(formatCalibration(calibration));
  }

  const skippedGroups = trainGroups.filter(
    (group) => !calibrations.some((c) => c.paidParkingArea === group.paidParkingArea && c.paidParkingSubarea === group.paidParkingSubarea),
  );
  if (skippedGroups.length > 0) {
    console.log("\nGroups with insufficient evidence (no correction fit, left uncorrected):");
    for (const group of skippedGroups) {
      const label = group.paidParkingSubarea === null ? group.paidParkingArea : `${group.paidParkingArea} / ${group.paidParkingSubarea}`;
      console.log(`  ${label}: ${group.pairs.length} pairs`);
    }
  }

  if (!write) {
    console.log("\nDry run (default) -- nothing written. Pass --write to actually populate area_occupancy_corrections.");
    return;
  }

  console.log("\n--write passed -- writing to area_occupancy_corrections...");
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
