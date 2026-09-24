import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { jsDayToIsoDay } from "../utils/dateHelpers.ts";

// Generates a CSV of real candidate blockfaces for an upcoming field-test
// trip, each row carrying this project's OWN current predicted occupancy
// (read straight from occupancy_stats, the same table the live app reads
// at request time -- see CLAUDE.md's Architecture section) for the
// requested day/hour, plus every field the next round of field testing
// needs to fill in by hand (realOccupiedCount, realTotalSpaces).
//
// Built specifically because the last round's fixture recorded
// paidParkingArea but not paidParkingSubarea, silently defaulting Gate 3
// to the area-level fallback path rather than the subarea-specific rows
// Gate 1 actually validated -- a real gap only caught by going back and
// looking each point's real subarea up directly. This tool pulls
// paidparkingarea/paidparkingsubarea from blockfaces itself, the exact
// same source syncBlockfaceParkingAreas.ts already populated it from, so
// every future field-test point starts with a real, confirmed subarea
// baked in rather than needing to be reconstructed after the fact.

export interface CliOptions {
  area: string;
  subarea: string | null;
  isoDay: number | null;
  hour: number | null;
  outPath: string | null;
  includeUnpaid: boolean;
}

function parseFlag(argv: readonly string[], key: string): string | null {
  const prefix = `--${key}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  return match === undefined ? null : match.slice(prefix.length);
}

// --day/--hour are discrete, fixed-domain inputs (1-7, 0-23) -- an
// out-of-range value has no meaningful "nearest valid" interpretation, so
// this throws rather than clamps, the same reasoning CLAUDE.md's "Handling
// invalid input" section gives for day-of-week specifically.
export function parseCliOptions(argv: readonly string[]): CliOptions {
  const area = parseFlag(argv, "area");
  if (area === null || area.trim() === "") {
    throw new Error("export-field-test-candidates: --area=<paidParkingArea> is required (e.g. --area=\"South Lake Union\")");
  }

  const dayRaw = parseFlag(argv, "day");
  let isoDay: number | null = null;
  if (dayRaw !== null) {
    isoDay = Number(dayRaw);
    if (!Number.isInteger(isoDay) || isoDay < 1 || isoDay > 7) {
      throw new Error(`export-field-test-candidates: --day must be an integer 1-7 (ISO 8601, 1=Monday..7=Sunday), got "${dayRaw}"`);
    }
  }

  const hourRaw = parseFlag(argv, "hour");
  let hour: number | null = null;
  if (hourRaw !== null) {
    hour = Number(hourRaw);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw new Error(`export-field-test-candidates: --hour must be an integer 0-23, got "${hourRaw}"`);
    }
  }

  return {
    area,
    subarea: parseFlag(argv, "subarea"),
    isoDay,
    hour,
    outPath: parseFlag(argv, "out"),
    // Defaults to real, paid blockfaces only -- a PAIDAREA/SUBAREA tag on
    // the Blockface FeatureServer carries across an ENTIRE segment
    // regardless of which side is actually paid (live-confirmed against
    // South Lake Union/North: 17 of its 93 blockfaces are tagged with a
    // real subarea but are genuinely unpaid, is_paid=false, 0 real
    // PAID_SPACES, "No Parking Allowed"), so exporting every tagged row
    // unfiltered would hand a field tester unpaid segments with nothing
    // to actually count. --include-unpaid is the explicit, real override
    // for the rare case someone genuinely wants those too.
    includeUnpaid: argv.includes("--include-unpaid"),
  };
}

// Defaults to right now (Seattle local time, matching where a real field
// trip would happen) so the exported "app predicted %" matches what a
// tester would actually see if they went out immediately -- but stays
// overridable via --day/--hour for planning a trip ahead of time.
export function resolveIsoDayAndHour(options: Pick<CliOptions, "isoDay" | "hour">, now: Date = new Date()): { isoDay: number; hour: number } {
  return {
    isoDay: options.isoDay ?? jsDayToIsoDay(now.getDay()),
    hour: options.hour ?? now.getHours(),
  };
}

export function buildCandidateName(streetName: string, crossStreetFrom: string, crossStreetTo: string): string {
  return `${streetName} (${crossStreetFrom}-${crossStreetTo})`;
}

// mean_occupancy is a 0-1 fraction, DB-constrained (occupancy_stats.mean_occupancy
// CHECK BETWEEN 0 AND 1) -- NaN/Infinity would mean something upstream is
// structurally broken (throw, no meaningful "nearest valid" value), while an
// in-range fraction just needs rounding to a whole display percent (no
// clamping ever actually needed given the DB constraint, but rounding is
// still real logic worth its own tested function).
export function meanOccupancyToPct(meanOccupancy: number): number {
  if (!Number.isFinite(meanOccupancy)) {
    throw new RangeError(`meanOccupancyToPct: expected a finite 0-1 fraction, got ${meanOccupancy}`);
  }
  return Math.round(meanOccupancy * 100);
}

export interface CandidateBlockface {
  sourceElementKey: number;
  sideOfStreet: string;
  streetName: string;
  crossStreetFrom: string;
  crossStreetTo: string;
  paidParkingArea: string | null;
  paidParkingSubarea: string | null;
}

export interface FieldTestCandidateRow {
  name: string;
  sourceElementKey: number;
  sideOfStreet: string;
  paidParkingArea: string | null;
  paidParkingSubarea: string | null;
  appPredictedPct: number | null;
}

export function buildCandidateRow(blockface: CandidateBlockface, meanOccupancy: number | null): FieldTestCandidateRow {
  return {
    name: buildCandidateName(blockface.streetName, blockface.crossStreetFrom, blockface.crossStreetTo),
    sourceElementKey: blockface.sourceElementKey,
    sideOfStreet: blockface.sideOfStreet,
    paidParkingArea: blockface.paidParkingArea,
    paidParkingSubarea: blockface.paidParkingSubarea,
    appPredictedPct: meanOccupancy === null ? null : meanOccupancyToPct(meanOccupancy),
  };
}

const CSV_COLUMNS = [
  "name",
  "sourceElementKey",
  "sideOfStreet",
  "paidParkingArea",
  "paidParkingSubarea",
  "appPredictedPct",
  "realOccupiedCount",
  "realTotalSpaces",
  "notes",
] as const;

// Minimal RFC4180-style escaping: only quote a field that actually needs
// it (contains a comma, double quote, or newline), doubling any embedded
// quotes -- real street names in this dataset can contain commas nowhere
// observed so far, but cross-street text is free-form city data, not
// worth trusting blindly.
function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function rowsToCsv(rows: readonly FieldTestCandidateRow[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    const values = [
      row.name,
      String(row.sourceElementKey),
      row.sideOfStreet,
      row.paidParkingArea ?? "",
      row.paidParkingSubarea ?? "",
      row.appPredictedPct === null ? "" : String(row.appPredictedPct),
      "", // realOccupiedCount -- filled in by hand during the field trip
      "", // realTotalSpaces -- filled in by hand during the field trip
      "", // notes -- free-form space for anything worth recording on-site
    ];
    lines.push(values.map(csvEscape).join(","));
  }
  return lines.join("\n") + "\n";
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// Same silent-1000-row-truncation guard as fetch-annual-study-calibration-data.ts's
// fetchAllRows -- PostgREST caps an unpaginated .select() at 1000 rows with
// no error, live-confirmed once already in this project. Duplicated here
// rather than shared, matching this codebase's existing per-script
// convention (see e.g. getRequiredEnvVar).
const SUPABASE_PAGE_SIZE = 1000;

interface RangeableQueryBuilder<T> {
  range(from: number, to: number): PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
}

async function fetchAllRows<T>(queryBuilder: RangeableQueryBuilder<T>, context: string): Promise<T[]> {
  const allRows: T[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await queryBuilder.range(offset, offset + SUPABASE_PAGE_SIZE - 1);
    if (error !== null) {
      throw new Error(`export-field-test-candidates: ${context} failed at offset ${offset}: ${error.message}`);
    }
    const page = data ?? [];
    allRows.push(...page);
    if (page.length < SUPABASE_PAGE_SIZE) break;
    offset += SUPABASE_PAGE_SIZE;
  }
  return allRows;
}

function getRequiredEnvVar(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`export-field-test-candidates: missing required environment variable ${name} (see .env.example)`);
  }
  return value;
}

function slugForFilename(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

interface BlockfaceRow {
  id: string;
  source_element_key: number;
  side_of_street: string;
  street_name: string;
  cross_street_from: string;
  cross_street_to: string;
  paidparkingarea: string | null;
  paidparkingsubarea: string | null;
  is_paid: boolean;
}

interface OccupancyStatsRow {
  blockface_id: string;
  mean_occupancy: number;
}

export async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const { isoDay, hour } = resolveIsoDayAndHour(options);

  console.log(`Area: "${options.area}"${options.subarea === null ? "" : ` / "${options.subarea}"`} -- day=${isoDay} (ISO), hour=${hour}${options.includeUnpaid ? " -- including unpaid blockfaces" : ""}`);

  const supabaseUrl = getRequiredEnvVar("SUPABASE_URL");
  const supabaseServiceRoleKey = getRequiredEnvVar("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

  console.log("Reading real candidate blockfaces directly from blockfaces...");
  let blockfaceQuery = supabase
    .from("blockfaces")
    .select("id, source_element_key, side_of_street, street_name, cross_street_from, cross_street_to, paidparkingarea, paidparkingsubarea, is_paid")
    .eq("paidparkingarea", options.area);
  if (options.subarea !== null) {
    blockfaceQuery = blockfaceQuery.eq("paidparkingsubarea", options.subarea);
  }
  // A PAIDAREA/SUBAREA tag carries across an entire street segment on the
  // source FeatureServer regardless of which specific side is actually
  // paid -- live-confirmed against South Lake Union/North, where 17 of 93
  // tagged blockfaces are genuinely unpaid (is_paid=false, 0 real
  // PAID_SPACES). Excluding those by default is what --include-unpaid
  // overrides.
  if (!options.includeUnpaid) {
    blockfaceQuery = blockfaceQuery.eq("is_paid", true);
  }
  const blockfaceRows = (await fetchAllRows(blockfaceQuery.order("street_name").order("cross_street_from"), "reading blockfaces")) as unknown as BlockfaceRow[];

  if (blockfaceRows.length === 0) {
    const filterNote = options.includeUnpaid ? "" : " (excluding unpaid blockfaces -- try --include-unpaid if you expect real unpaid segments here)";
    console.log(`No real blockfaces found for area="${options.area}"${options.subarea === null ? "" : `, subarea="${options.subarea}"`}${filterNote} -- nothing to export.`);
    return;
  }
  console.log(`${blockfaceRows.length} real candidate blockfaces found${options.includeUnpaid ? "" : " (paid only)"}.`);

  console.log("Reading this project's own current occupancy_stats prediction for each, at the requested day/hour...");
  const meanOccupancyByBlockfaceId = new Map<string, number>();
  for (const idChunk of chunk(blockfaceRows.map((b) => b.id), 200)) {
    const statsRows = (await fetchAllRows(
      supabase.from("occupancy_stats").select("blockface_id, mean_occupancy").in("blockface_id", idChunk).eq("day_of_week", isoDay).eq("hour_of_day", hour),
      "reading occupancy_stats",
    )) as unknown as OccupancyStatsRow[];
    for (const row of statsRows) {
      meanOccupancyByBlockfaceId.set(row.blockface_id, row.mean_occupancy);
    }
  }

  const rows = blockfaceRows.map((b) =>
    buildCandidateRow(
      {
        sourceElementKey: b.source_element_key,
        sideOfStreet: b.side_of_street,
        streetName: b.street_name,
        crossStreetFrom: b.cross_street_from,
        crossStreetTo: b.cross_street_to,
        paidParkingArea: b.paidparkingarea,
        paidParkingSubarea: b.paidparkingsubarea,
      },
      meanOccupancyByBlockfaceId.get(b.id) ?? null,
    ),
  );

  const withPrediction = rows.filter((r) => r.appPredictedPct !== null).length;
  console.log(`${withPrediction} of ${rows.length} candidates have a real prediction for day=${isoDay}/hour=${hour}; the rest have no occupancy_stats row for this bucket (insufficient historical data or the block doesn't operate then).`);

  const outDir = path.join(process.cwd(), "field-test-exports");
  await mkdir(outDir, { recursive: true });
  const defaultFilename = `${slugForFilename(options.area)}${options.subarea === null ? "" : `_${slugForFilename(options.subarea)}`}_day${isoDay}_hour${hour}.csv`;
  const outPath = options.outPath ?? path.join(outDir, defaultFilename);

  await writeFile(outPath, rowsToCsv(rows), "utf-8");
  console.log(`Wrote ${rows.length} candidate rows to ${outPath}.`);
}

const isRunDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isRunDirectly) {
  main().catch((error: unknown) => {
    console.error("export-field-test-candidates: fatal error:", error);
    process.exitCode = 1;
  });
}
