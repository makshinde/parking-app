import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { splitTrainHoldout } from "../scoring/areaCorrectionCalibration.ts";
import type { CalibrationPair, GroupedCalibrationPairs, SplitInput } from "../scoring/areaCorrectionCalibration.ts";

// Gathers the real, independent (predicted%, ground-truth%) pairs the
// area-occupancy-correction calibration is fit from: SDOT's Annual
// Parking Study (2014-2019 real human vehicle counts, data.seattle.gov
// dataset 7jzm-ucez) matched against this project's OWN current
// occupancy_stats prediction for the same blockface/day-of-week/hour
// bucket. Deliberately the ONLY ground truth this pipeline fits from --
// the field test (35 points) and the transaction-coverage rebuild are
// NEVER read here, on purpose (see heldOutFieldTestGroundTruth.ts and
// backtest-predictions.ts's runAreaCorrectionValidation, which hold
// those back for final, untouched validation instead).
//
// Output is a local JSON artifact (calibration-data/annual-study-pairs.json),
// not a direct DB write -- fit-and-write-area-corrections.ts consumes it
// separately, keeping "gather real evidence" and "fit + persist a
// correction from it" as two distinct, independently-inspectable steps.

const ANNUAL_STUDY_URL = "https://data.seattle.gov/resource/7jzm-ucez.json";
const STUDY_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})$/;

export interface StudyRow {
  elmntkey: string;
  side: string;
  date_time: string;
  parking_spaces: string;
  total_vehicle_count: string;
}

export interface BlockfaceAreaRow {
  id: string;
  source_element_key: number;
  side_of_street: string;
  paidparkingarea: string;
  paidparkingsubarea: string | null;
}

// Study timestamps arrive as naive Pacific "M/D/YYYY H:mm" (12/25/2018
// 9:00), not ISO 8601 -- a completely different shape from
// blockfaceLookup.ts's OCCUPANCY_DATETIME_PATTERN, so this is its own
// small parser rather than a shared one. Only isoDay/hour are needed
// (matching occupancy_stats' own bucketing), not a full instant -- no
// timezone/DST resolution required, the same reasoning
// blockfaceLookup.ts's getIsoDayOfWeek uses for its own isoDay/hour.
export function parseStudyDateTime(dateTime: string): { isoDay: number; hour: number } {
  const match = STUDY_DATE_PATTERN.exec(dateTime);
  if (match === null) {
    throw new Error(`parseStudyDateTime: "${dateTime}" does not match the expected "M/D/YYYY H:mm" shape`);
  }
  const [, monthStr, dayStr, yearStr, hourStr] = match;
  const utcMidnight = Date.UTC(Number(yearStr), Number(monthStr) - 1, Number(dayStr));
  // Date.UTC()+getUTCDay(), never getDay(): getDay() on this Date would
  // depend on the machine's own local timezone, reintroducing exactly the
  // ambiguity blockfaceLookup.ts's own comment on this same technique
  // warns about.
  const jsDay = new Date(utcMidnight).getUTCDay();
  const isoDay = jsDay === 0 ? 7 : jsDay;
  return { isoDay, hour: Number(hourStr) };
}

// A study row's real occupancy fraction, clamped to 100 the same way
// calculateOccupancyRatio.ts clamps a raw reading -- a manually-counted
// study block can plausibly show more vehicles than its recorded space
// count (the same real-world messiness that function's own comment
// documents for the payment-derived data), not a structural error.
export function computeStudyGroundTruthPct(parkingSpaces: number, totalVehicleCount: number): number | null {
  if (parkingSpaces <= 0) return null;
  return Math.min(100, (100 * totalVehicleCount) / parkingSpaces);
}

// Uniquely identifies the real-world observation behind one calibration
// pair (not its values) -- used as splitTrainHoldout's stable key so the
// train/holdout assignment never depends on processing order.
export function buildPairKey(elmntkey: string, side: string, dateTime: string): string {
  return `${elmntkey}|${side}|${dateTime}`;
}

interface OccupancyStatsBucket {
  source_element_key: number;
  side_of_street: string;
  day_of_week: number;
  hour_of_day: number;
  mean_occupancy: number;
}

// Pure join: combines real study rows, this project's own blockface/area
// reference data, and its own current occupancy_stats predictions into
// the (area, subarea, predictedPct, groundTruthPct, stable key) pairs
// fitAreaCalibrationsWithFallback needs -- no network or DB access here,
// so the matching logic itself is unit-testable independent of any real
// fetch.
export function buildCalibrationInputs(
  studyRows: readonly StudyRow[],
  blockfacesByKey: ReadonlyMap<string, BlockfaceAreaRow>,
  occupancyStatsByKey: ReadonlyMap<string, OccupancyStatsBucket>,
): SplitInput<{ area: string; subarea: string | null; pair: CalibrationPair }>[] {
  const inputs: SplitInput<{ area: string; subarea: string | null; pair: CalibrationPair }>[] = [];

  for (const row of studyRows) {
    const blockface = blockfacesByKey.get(`${row.elmntkey}|${row.side}`);
    if (blockface === undefined) continue;

    let parsed;
    try {
      parsed = parseStudyDateTime(row.date_time);
    } catch {
      continue;
    }

    const bucketKey = `${blockface.id}|${parsed.isoDay}|${parsed.hour}`;
    const bucket = occupancyStatsByKey.get(bucketKey);
    if (bucket === undefined) continue;

    const groundTruthPct = computeStudyGroundTruthPct(Number(row.parking_spaces), Number(row.total_vehicle_count));
    if (groundTruthPct === null || !Number.isFinite(groundTruthPct)) continue;

    inputs.push({
      key: buildPairKey(row.elmntkey, row.side, row.date_time),
      pair: {
        area: blockface.paidparkingarea,
        subarea: blockface.paidparkingsubarea,
        pair: { predictedPct: bucket.mean_occupancy * 100, groundTruthPct },
      },
    });
  }

  return inputs;
}

// Regroups a flat list of (area, subarea, pair) tuples into
// fitAreaCalibrationsWithFallback's GroupedCalibrationPairs shape.
export function groupCalibrationPairs(pairs: readonly { area: string; subarea: string | null; pair: CalibrationPair }[]): GroupedCalibrationPairs[] {
  const groups = new Map<string, GroupedCalibrationPairs>();
  for (const { area, subarea, pair } of pairs) {
    const key = `${area}|${subarea ?? ""}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { paidParkingArea: area, paidParkingSubarea: subarea, pairs: [pair] });
    } else {
      existing.pairs.push(pair);
    }
  }
  return Array.from(groups.values());
}

function getRequiredEnvVar(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`fetch-annual-study-calibration-data: missing required environment variable ${name} (see .env.example)`);
  }
  return value;
}

const SOCRATA_CHUNK_SIZE = 200; // keeps each $where IN(...) list comfortably short

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export async function main(): Promise<void> {
  const supabaseUrl = getRequiredEnvVar("SUPABASE_URL");
  const supabaseServiceRoleKey = getRequiredEnvVar("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

  console.log("Reading blockfaces with a real paidparkingarea on record...");
  const { data: blockfaceRows, error: blockfaceError } = await supabase
    .from("blockfaces")
    .select("id, source_element_key, side_of_street, paidparkingarea, paidparkingsubarea")
    .not("paidparkingarea", "is", null);
  if (blockfaceError !== null) {
    throw new Error(`fetch-annual-study-calibration-data: reading blockfaces failed: ${blockfaceError.message}`);
  }
  const blockfaces = (blockfaceRows ?? []) as BlockfaceAreaRow[];
  console.log(`${blockfaces.length} blockfaces carry a paidparkingarea.`);

  const blockfacesByKey = new Map(blockfaces.map((b) => [`${b.source_element_key}|${b.side_of_street}`, b]));
  const blockfaceIds = blockfaces.map((b) => b.id);

  console.log("Reading this project's own current occupancy_stats predictions for those blockfaces...");
  const occupancyStatsByKey = new Map<string, OccupancyStatsBucket>();
  for (const idChunk of chunk(blockfaceIds, 200)) {
    const { data, error } = await supabase
      .from("occupancy_stats")
      .select("blockface_id, day_of_week, hour_of_day, mean_occupancy")
      .in("blockface_id", idChunk);
    if (error !== null) {
      throw new Error(`fetch-annual-study-calibration-data: reading occupancy_stats failed: ${error.message}`);
    }
    for (const row of data ?? []) {
      occupancyStatsByKey.set(`${row.blockface_id}|${row.day_of_week}|${row.hour_of_day}`, {
        source_element_key: 0,
        side_of_street: "",
        day_of_week: row.day_of_week as number,
        hour_of_day: row.hour_of_day as number,
        mean_occupancy: row.mean_occupancy as number,
      });
    }
  }
  console.log(`${occupancyStatsByKey.size} occupancy_stats buckets loaded.`);

  console.log("Fetching real Annual Parking Study rows for these blockfaces...");
  const elmntkeys = Array.from(new Set(blockfaces.map((b) => String(b.source_element_key))));
  const socrataToken = process.env["SOCRATA_APP_TOKEN"];
  const allStudyRows: StudyRow[] = [];
  for (const keyChunk of chunk(elmntkeys, SOCRATA_CHUNK_SIZE)) {
    const whereClause = `elmntkey in (${keyChunk.map((k) => `'${k}'`).join(",")})`;
    const params = new URLSearchParams({
      $select: "elmntkey,side,date_time,parking_spaces,total_vehicle_count",
      $where: whereClause,
      $limit: "50000",
    });
    const response = await fetch(`${ANNUAL_STUDY_URL}?${params}`, {
      headers: socrataToken !== undefined ? { "X-App-Token": socrataToken } : {},
    });
    if (!response.ok) {
      throw new Error(`fetch-annual-study-calibration-data: Annual Study request failed with status ${response.status}`);
    }
    const rows = (await response.json()) as StudyRow[];
    allStudyRows.push(...rows);
  }
  console.log(`${allStudyRows.length} real Annual Study rows fetched.`);

  const flatInputs = buildCalibrationInputs(allStudyRows, blockfacesByKey, occupancyStatsByKey);
  console.log(`${flatInputs.length} rows matched to both a real blockface and a real current occupancy_stats bucket.`);

  const split = splitTrainHoldout(flatInputs, 0.7);
  console.log(`Train/held-out split: ${split.train.length} train, ${split.holdout.length} held-out.`);

  const trainGroups = groupCalibrationPairs(split.train);
  const holdoutGroups = groupCalibrationPairs(split.holdout);

  const outDir = path.join(process.cwd(), "calibration-data");
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "annual-study-train.json"), JSON.stringify(trainGroups, null, 2));
  await writeFile(path.join(outDir, "annual-study-holdout.json"), JSON.stringify(holdoutGroups, null, 2));
  console.log(`Wrote ${path.join(outDir, "annual-study-train.json")} and annual-study-holdout.json.`);
}

const isRunDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isRunDirectly) {
  main().catch((error: unknown) => {
    console.error("fetch-annual-study-calibration-data: fatal error:", error);
    process.exitCode = 1;
  });
}
