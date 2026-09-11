import "dotenv/config";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fetchSocrataRecords, type SocrataRecord } from "../utils/fetchSocrataRecords.ts";
import { resolveYearlyArchiveDatasetId } from "./resolveYearlyArchive.ts";
import { isoDayToSocrataDow } from "./isoDayToSocrataDow.ts";
import { parseRawReadings } from "./backfill-occupancy-stats.ts";
import { buildLookupKey, normalizeReading, getPacificCalendarYear, type RawReading } from "./blockfaceLookup.ts";
import { calculateRecencyWeight } from "../scoring/recencyWeight.ts";
import { calculateOccupancyRatio } from "./calculateOccupancyRatio.ts";
import { decideBucketStats, type BucketStats } from "./decideBucketStats.ts";
import type { WeightedReading } from "./weightedStats.ts";
import { calculateConfidenceScore } from "../scoring/confidenceScore.ts";

// Retrospective backtesting harness for the prediction pipeline.
//
// Feasible with ZERO production code changes: the entire scoring chain
// (normalizeReading, calculateRecencyWeight, decideBucketStats,
// calculateConfidenceScore) already accepts an explicit reference date
// rather than reading the system clock internally (see each function's own
// module for its "now"/"currentYear" parameter). "Recompute what the
// pipeline would have predicted as of a past cutoff date" therefore means
// exactly what it says: fetch real historical readings dated before that
// cutoff, and run them through these exact same, already-existing
// functions with now = that cutoff date. This file imports and calls those
// functions unchanged -- it contains no parallel scoring logic of its own.
//
// Run directly via `node` (see package.json's backtest:predictions
// script), the same pattern as backfill-occupancy-stats.ts/
// reconcile-occupancy-stats.ts -- not an Edge Function, no Supabase
// dependency at all: every test case below carries its own blockfaceId/
// sourceElementKey/sideOfStreet directly (real values, live-verified
// against the blockfaces table while building this list), so this script
// only ever talks to Socrata.

// --- Naive-Pacific-date helpers -----------------------------------------
//
// This harness deliberately reimplements a small amount of the same
// naive-Pacific-components<->instant conversion blockfaceLookup.ts's own
// (private) resolveOccupancyInstant already does, rather than exporting
// that helper from production code. The whole feasibility argument above
// rests on this harness calling the pipeline's real, PUBLIC functions
// unchanged -- reaching into a production file's private internals to
// avoid ~20 lines of duplication isn't worth coupling this harness to
// blockfaceLookup.ts's implementation details.

const SOURCE_TIME_ZONE = "America/Los_Angeles";
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDateOnly(dateOnly: string, callerName: string): { year: number; month: number; day: number } {
  const match = DATE_ONLY_PATTERN.exec(dateOnly);
  if (match === null) {
    throw new Error(`${callerName}: expected a "YYYY-MM-DD" date, got "${dateOnly}"`);
  }
  const [, yearStr, monthStr, dayStr] = match;
  return { year: Number(yearStr), month: Number(monthStr), day: Number(dayStr) };
}

let pacificOffsetFormatter: Intl.DateTimeFormat | undefined;

// Same cached-formatter discipline as blockfaceLookup.ts's
// getCachedDateTimeFormat -- constructing an Intl.DateTimeFormat is
// expensive enough to matter at this project's real call volumes (see that
// file's own comment for the live-confirmed OOM this avoids), even though
// this harness's volume is far smaller than the production batch job's.
function getPacificOffsetMinutes(instant: Date): number {
  if (pacificOffsetFormatter === undefined) {
    pacificOffsetFormatter = new Intl.DateTimeFormat("en-US", { timeZone: SOURCE_TIME_ZONE, timeZoneName: "shortOffset" });
  }
  const parts = pacificOffsetFormatter.formatToParts(instant);
  const offsetPart = parts.find((part) => part.type === "timeZoneName");
  const match = offsetPart ? /^GMT([+-]\d+)$/.exec(offsetPart.value) : null;
  if (match === null || match[1] === undefined) {
    throw new Error(`getPacificOffsetMinutes: could not determine the UTC offset for ${SOURCE_TIME_ZONE} near ${instant.toISOString()}`);
  }
  return Number(match[1]) * 60;
}

// Resolves a "YYYY-MM-DD" calendar date, always interpreted as Pacific
// midnight (the start of that day), to the real absolute instant it
// represents -- DST-aware. Used as this harness's "now" for a given
// cutoff: normalizeReading needs a true instant to compute ageInDays
// against, not just a naive date string.
export function pacificMidnightInstant(dateOnly: string): Date {
  const { year, month, day } = parseDateOnly(dateOnly, "pacificMidnightInstant");
  // Same asIfUtcMillis trick as resolveOccupancyInstant: reinterpret the
  // naive Y/M/D as if already UTC, purely to get a rough instant to ask
  // Intl what offset Pacific observes around there -- only wrong within a
  // couple of hours of a DST transition (an accepted limitation of this
  // technique, same as blockfaceLookup.ts's own comment on it).
  const asIfUtcMillis = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offsetMinutes = getPacificOffsetMinutes(new Date(asIfUtcMillis));
  return new Date(asIfUtcMillis - offsetMinutes * MS_PER_MINUTE);
}

// Pure calendar-date arithmetic on a "YYYY-MM-DD" string -- deliberately
// NOT instant-based (no timezone/DST involved at all): a Socrata $where
// boundary needs a naive-local calendar date, and calendar-day addition is
// timezone-independent by definition (day N+7 is always exactly 7
// calendar days later, regardless of what the clock did on any day in
// between).
export function addCalendarDays(dateOnly: string, days: number): string {
  const { year, month, day } = parseDateOnly(dateOnly, "addCalendarDays");
  const resultMillis = Date.UTC(year, month - 1, day) + days * MS_PER_DAY;
  const result = new Date(resultMillis);
  const y = result.getUTCFullYear();
  const m = String(result.getUTCMonth() + 1).padStart(2, "0");
  const d = String(result.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function naiveMidnight(dateOnly: string): string {
  return `${dateOnly}T00:00:00`;
}

function naiveEndOfDay(dateOnly: string): string {
  return `${dateOnly}T23:59:59`;
}

// --- Dataset resolution ---------------------------------------------------
//
// Deliberately narrow, not a general "any year" resolver: this harness's
// fixed test-case list (below) only ever uses 2025 and 2026 cutoffs, so
// only those two need resolving. An unsupported year throws rather than
// guessing which dataset(s) would apply -- same reasoning
// resolveYearlyArchiveDatasetId itself uses for an unverified dataset ID.

// The current, not-yet-archived Paid Parking Occupancy dataset (see
// CLAUDE.md's Architecture section). Its real, live-verified coverage as
// of this harness's own investigation is 2026-07-27 through 2026-09-01 --
// narrower than "all of 2026" -- which is exactly why this harness's 2026
// cutoffs are limited to a handful of August Saturdays (see TEST_CASES).
const ROLLING_WINDOW_DATASET_ID = "rke9-rsvs";
const SOCRATA_BASE_URL = "https://data.seattle.gov/resource";

function buildSocrataDatasetUrl(datasetId: string): string {
  return `${SOCRATA_BASE_URL}/${datasetId}.json`;
}

export interface TrainingDatasetSpec {
  datasetId: string;
  upperBoundNaive: string | null;
}

export function resolveTrainingDatasets(cutoffYear: number, cutoffDateOnly: string): TrainingDatasetSpec[] {
  if (cutoffYear === 2025) {
    return [{ datasetId: resolveYearlyArchiveDatasetId(2025), upperBoundNaive: naiveMidnight(cutoffDateOnly) }];
  }
  if (cutoffYear === 2026) {
    return [
      // All of 2025 is entirely in the past relative to any 2026 cutoff --
      // no upper bound needed on the closed prior-year archive.
      { datasetId: resolveYearlyArchiveDatasetId(2025), upperBoundNaive: null },
      { datasetId: ROLLING_WINDOW_DATASET_ID, upperBoundNaive: naiveMidnight(cutoffDateOnly) },
    ];
  }
  throw new Error(`resolveTrainingDatasets: this harness's fixed test-case list only covers 2025/2026 cutoffs, got ${cutoffYear}`);
}

export function resolveGroundTruthDataset(cutoffYear: number): string {
  if (cutoffYear === 2025) {
    return resolveYearlyArchiveDatasetId(2025);
  }
  if (cutoffYear === 2026) {
    return ROLLING_WINDOW_DATASET_ID;
  }
  throw new Error(`resolveGroundTruthDataset: this harness's fixed test-case list only covers 2025/2026 cutoffs, got ${cutoffYear}`);
}

// --- Test case definition --------------------------------------------------

export interface TestCase {
  label: string;
  blockfaceId: string;
  sourceElementKey: number;
  sideOfStreet: string;
  isoDay: number;
  hour: number;
  // "YYYY-MM-DD", Pacific-local, always midnight -- see pacificMidnightInstant.
  cutoffDateOnly: string;
  horizonDays: number;
  slice: "capitol_hill_saturday" | "general";
}

interface BlockfaceIdentity {
  name: string;
  blockfaceId: string;
  sourceElementKey: number;
  sideOfStreet: string;
}

// The four blockfaces from this project's own real field test (Capitol
// Hill, Saturday evening) -- ids/sourceElementKeys/sides live-verified
// directly against the blockfaces table in an earlier investigation this
// session, reused here unchanged.
const CAPITOL_HILL_BLOCKFACES: readonly BlockfaceIdentity[] = [
  { name: "broadway_e_side", blockfaceId: "092b1304-6b23-4f61-8720-475242c4e84d", sourceElementKey: 32266, sideOfStreet: "E" },
  { name: "broadway_w_side", blockfaceId: "28219a48-35da-411b-8d90-fbd4d4a4a06f", sourceElementKey: 32265, sideOfStreet: "W" },
  { name: "pike_n_side", blockfaceId: "36493e3c-365a-4e66-a2d9-15e752928472", sourceElementKey: 59965, sideOfStreet: "N" },
  { name: "pike_s_side", blockfaceId: "42218748-a906-4aa0-bf60-4874d8881623", sourceElementKey: 59966, sideOfStreet: "S" },
];

const CAPITOL_HILL_CUTOFFS: readonly string[] = ["2025-09-06", "2025-10-04", "2025-11-01", "2026-08-15"];
const CAPITOL_HILL_HOURS: readonly number[] = [18, 19, 20];
const SATURDAY_ISO_DAY = 6;
const STANDARD_HORIZON_DAYS = 7;

function buildCapitolHillSaturdayEveningTestCases(): TestCase[] {
  const cases: TestCase[] = [];
  for (const blockface of CAPITOL_HILL_BLOCKFACES) {
    for (const cutoffDateOnly of CAPITOL_HILL_CUTOFFS) {
      for (const hour of CAPITOL_HILL_HOURS) {
        cases.push({
          label: `capitol_hill_${blockface.name}_${cutoffDateOnly}_h${hour}`,
          blockfaceId: blockface.blockfaceId,
          sourceElementKey: blockface.sourceElementKey,
          sideOfStreet: blockface.sideOfStreet,
          isoDay: SATURDAY_ISO_DAY,
          hour,
          cutoffDateOnly,
          horizonDays: STANDARD_HORIZON_DAYS,
          slice: "capitol_hill_saturday",
        });
      }
    }
  }
  return cases;
}

// A dedicated multi-occurrence demonstration with a wider horizon than the
// rest of this slice: a 14-day window from the same real cutoff
// (2025-09-06) spans THREE real Saturdays (2025-09-06 itself, still hours
// ahead of the cutoff's own midnight; 2025-09-13; and 2025-09-20). Note
// this project's Capitol Hill cutoffs are themselves always real
// Saturdays (matching the field test's own Saturday-evening scenario), so
// even the STANDARD 7-day-horizon cases above already pick up two
// occurrences each (the cutoff's own later-that-day evening, plus the
// following Saturday) -- live-confirmed in this harness's own smoke test,
// not just a theoretical edge case. This wider 14-day case exists to push
// that further (three occurrences instead of two) and to exercise a
// longer, more confidence-decaying horizon, not to be the only place
// multi-occurrence data ever shows up.
function buildCapitolHillMultiOccurrenceTestCases(): TestCase[] {
  const cutoffDateOnly = "2025-09-06";
  const hour = 19;
  return CAPITOL_HILL_BLOCKFACES.map((blockface) => ({
    label: `capitol_hill_${blockface.name}_${cutoffDateOnly}_h${hour}_multiocc14d`,
    blockfaceId: blockface.blockfaceId,
    sourceElementKey: blockface.sourceElementKey,
    sideOfStreet: blockface.sideOfStreet,
    isoDay: SATURDAY_ISO_DAY,
    hour,
    cutoffDateOnly,
    horizonDays: 14,
    slice: "capitol_hill_saturday" as const,
  }));
}

// Six real, geographically diverse paid blockfaces outside Capitol Hill
// (U-District, Queen Anne, South Lake Union, Belltown, Chinatown-ID,
// Ballard) -- ids/sourceElementKeys/sides live-verified directly against
// the blockfaces table while building this list, picked for real
// geographic spread rather than any property of their own occupancy data
// (chosen before this script ever ran, so there's no cherry-picking risk).
const GENERAL_BLOCKFACES: readonly BlockfaceIdentity[] = [
  { name: "ne_47th_st_u_district", blockfaceId: "d7cf5d15-1b12-4ed8-8d45-94bb52d41869", sourceElementKey: 84790, sideOfStreet: "S" },
  { name: "dexter_ave_n_queen_anne", blockfaceId: "8c2f740c-06f9-4c6c-a42d-15f6e64c6fd0", sourceElementKey: 77990, sideOfStreet: "E" },
  { name: "terry_ave_n_slu", blockfaceId: "5639ee4d-b07a-46aa-ba5a-80f25c44719e", sourceElementKey: 13105, sideOfStreet: "W" },
  { name: "cedar_st_belltown", blockfaceId: "14e86dd4-f610-4c53-98b3-1f449319a57d", sourceElementKey: 54954, sideOfStreet: "SE" },
  { name: "s_king_st_chinatown_id", blockfaceId: "854ce677-9548-4347-94cb-f84b76f153aa", sourceElementKey: 43057, sideOfStreet: "N" },
  { name: "ballard_ave_nw_ballard", blockfaceId: "12f21c84-6abc-48b2-8211-15266f1bf309", sourceElementKey: 31849, sideOfStreet: "SW" },
];

// Weekday midday and Saturday afternoon -- deliberately distinct from the
// Capitol Hill slice's Saturday-evening focus, for broader day/hour
// coverage in the general calibration sample.
const GENERAL_DAY_HOUR_COMBOS: readonly { isoDay: number; hour: number }[] = [
  { isoDay: 3, hour: 12 }, // Wednesday midday
  { isoDay: 6, hour: 14 }, // Saturday afternoon
];
const GENERAL_CUTOFFS: readonly string[] = ["2025-03-01", "2025-10-11"];
const GENERAL_HORIZONS: readonly number[] = [1, 7];

function buildGeneralTestCases(): TestCase[] {
  const cases: TestCase[] = [];
  for (const blockface of GENERAL_BLOCKFACES) {
    for (const { isoDay, hour } of GENERAL_DAY_HOUR_COMBOS) {
      for (const cutoffDateOnly of GENERAL_CUTOFFS) {
        for (const horizonDays of GENERAL_HORIZONS) {
          cases.push({
            label: `general_${blockface.name}_iso${isoDay}_h${hour}_${cutoffDateOnly}_horizon${horizonDays}d`,
            blockfaceId: blockface.blockfaceId,
            sourceElementKey: blockface.sourceElementKey,
            sideOfStreet: blockface.sideOfStreet,
            isoDay,
            hour,
            cutoffDateOnly,
            horizonDays,
            slice: "general",
          });
        }
      }
    }
  }
  return cases;
}

// The full, fixed test-case list -- decided and committed before this
// script is ever run against real results, per this harness's own design
// requirement (see the PR/commit this file was introduced in): nothing
// downstream of TEST_CASES may filter or reorder it based on outcomes.
export const TEST_CASES: readonly TestCase[] = [
  ...buildCapitolHillSaturdayEveningTestCases(),
  ...buildCapitolHillMultiOccurrenceTestCases(),
  ...buildGeneralTestCases(),
];

// --- Socrata query building -------------------------------------------------

interface BucketWhereBounds {
  lowerBoundNaive?: string;
  upperBoundNaive?: string;
}

// sideOfStreet is always one of this file's own fixed, developer-authored
// TestCase literals above (never external/user input), so plain string
// interpolation into a SoQL $where value is the same safe pattern already
// used throughout this project's other Socrata-querying scripts (e.g.
// backfill-occupancy-stats.ts, and the ad hoc queries this investigation's
// own earlier turns already ran directly).
function buildBucketWhereClause(testCase: TestCase, bounds: BucketWhereBounds): string {
  const socrataDow = isoDayToSocrataDow(testCase.isoDay);
  const clauses = [
    `sourceelementkey='${testCase.sourceElementKey}'`,
    `sideofstreet='${testCase.sideOfStreet}'`,
    `date_extract_dow(occupancydatetime)=${socrataDow}`,
    `date_extract_hh(occupancydatetime)=${testCase.hour}`,
  ];
  if (bounds.lowerBoundNaive !== undefined) {
    clauses.push(`occupancydatetime >= '${bounds.lowerBoundNaive}'`);
  }
  if (bounds.upperBoundNaive !== undefined) {
    clauses.push(`occupancydatetime < '${bounds.upperBoundNaive}'`);
  }
  return clauses.join(" AND ");
}

// --- Ground truth aggregation ------------------------------------------

function meanClampedRatio(readings: readonly RawReading[]): number {
  const ratios = readings.map((r) => calculateOccupancyRatio(r.paidOccupancy, r.parkingSpaceCount));
  return ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length;
}

// occupancyDateTime's naive "YYYY-MM-DDTHH:mm:ss[.sss]" shape always has
// its calendar date as the first 10 characters -- grouping by that prefix
// separates readings from genuinely distinct real calendar-day occurrences
// of the target isoDay/hour bucket, without needing to re-derive isoDay
// from each reading (every reading here already matched the day/hour
// filter in the $where clause that fetched it).
function groupReadingsByCalendarDate(readings: readonly RawReading[]): Map<string, RawReading[]> {
  const grouped = new Map<string, RawReading[]>();
  for (const reading of readings) {
    const dateOnly = reading.occupancyDateTime.slice(0, 10);
    const existing = grouped.get(dateOnly);
    if (existing === undefined) {
      grouped.set(dateOnly, [reading]);
    } else {
      existing.push(reading);
    }
  }
  return grouped;
}

export interface GroundTruth {
  // Mean of just the nearest real occurrence's readings -- the ground
  // truth a single real future night (like tonight's own field test)
  // would actually be checked against.
  singleNearestMean: number | null;
  // Mean of each real occurrence's own mean, averaged across every
  // occurrence within the horizon -- reduces the day-to-day noise a
  // single-night comparison bakes in (see this harness's own design
  // notes). Equal to singleNearestMean whenever only one occurrence
  // exists within the horizon. Note a horizon as short as 7 days can
  // still contain two occurrences when the cutoff's own weekday matches
  // the target isoDay (the ground-truth window starts at the cutoff's own
  // midnight, so "later today" already counts as the first occurrence) --
  // exactly the case for this harness's Capitol Hill Saturday cutoffs,
  // live-confirmed in its own smoke test. Only a horizon strictly shorter
  // than 7 days is guaranteed to contain at most one occurrence.
  multiOccurrenceMean: number | null;
  occurrenceCount: number;
  totalReadingCount: number;
}

export function computeGroundTruth(readings: readonly RawReading[]): GroundTruth {
  if (readings.length === 0) {
    return { singleNearestMean: null, multiOccurrenceMean: null, occurrenceCount: 0, totalReadingCount: 0 };
  }

  const byDate = groupReadingsByCalendarDate(readings);
  const sortedDates = [...byDate.keys()].sort();
  const nearestDate = sortedDates[0] as string;

  const perOccurrenceMeans = sortedDates.map((date) => meanClampedRatio(byDate.get(date) as RawReading[]));
  const multiOccurrenceMean = perOccurrenceMeans.reduce((sum, m) => sum + m, 0) / perOccurrenceMeans.length;

  return {
    singleNearestMean: meanClampedRatio(byDate.get(nearestDate) as RawReading[]),
    multiOccurrenceMean,
    occurrenceCount: sortedDates.length,
    totalReadingCount: readings.length,
  };
}

// --- Running one test case -----------------------------------------------

export interface BacktestDeps {
  fetchRecords: (datasetUrl: string, whereClause: string) => Promise<SocrataRecord[]>;
}

// The real dependency: fetchSocrataRecords already handles pagination,
// retry-with-backoff, and the app-token header (see that module) -- reused
// unchanged, same as this file's whole design principle.
export const REAL_BACKTEST_DEPS: BacktestDeps = {
  fetchRecords: (datasetUrl, whereClause) => fetchSocrataRecords(datasetUrl, whereClause),
};

// A blockfaces table lookup would normally come from buildBlockfaceLookup
// (a real DB read across every blockface) -- but each test case here
// already names its own single, specific blockfaceId/sourceElementKey/
// sideOfStreet directly, so normalizeReading only ever needs a one-entry
// Map for that one test case, built locally with no DB round trip at all.
function buildSingleBlockfaceLookup(testCase: TestCase): Map<string, string> {
  const lookup = new Map<string, string>();
  lookup.set(buildLookupKey(testCase.sourceElementKey, testCase.sideOfStreet), testCase.blockfaceId);
  return lookup;
}

// A blockface's real capacity isn't stable across years (see CLAUDE.md's
// Known open questions) and must come from the same rows being aggregated,
// never a cached/separately-joined value -- so this reports whichever
// parkingSpaceCount value appears most often across the training window's
// own real readings, not a fixed lookup.
function mostCommonParkingSpaceCount(readings: readonly RawReading[]): number | null {
  const counts = new Map<number, number>();
  for (const reading of readings) {
    counts.set(reading.parkingSpaceCount, (counts.get(reading.parkingSpaceCount) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = -1;
  for (const [capacity, count] of counts) {
    if (count > bestCount) {
      best = capacity;
      bestCount = count;
    }
  }
  return best;
}

// Low-capacity blocks (a handful of spaces) swing wildly on small-sample
// noise -- live-confirmed directly in this project's own earlier field
// investigation (a 4-space block's real occupancy average moved ~37
// points between two real time windows with no real underlying demand
// change). Tagging and slicing these out keeps the headline MAE from being
// dominated by noise that isn't really about prediction quality.
const LOW_CAPACITY_THRESHOLD = 6;

export type SkippedReason = "insufficient_training_data" | "no_ground_truth_data" | "fetch_error";

export interface TestCaseResult {
  label: string;
  blockfaceId: string;
  isoDay: number;
  hour: number;
  cutoffDateOnly: string;
  horizonDays: number;
  slice: TestCase["slice"];

  predictedMean: number | null;
  confidenceScore: number | null;
  sampleCount: number | null;
  stdDev: number | null;

  observedParkingSpaceCount: number | null;
  lowCapacity: boolean;

  singleNearestActualMean: number | null;
  multiOccurrenceActualMean: number | null;
  groundTruthOccurrenceCount: number;
  groundTruthReadingCount: number;

  // Signed (predicted - actual): positive means the pipeline
  // over-predicted occupancy, negative means it under-predicted --
  // recorded to catch a systematic bias, not just magnitude.
  errorSingleNearest: number | null;
  absErrorSingleNearest: number | null;
  errorMultiOccurrence: number | null;
  absErrorMultiOccurrence: number | null;

  skippedReason: SkippedReason | null;
  skippedDetail: string | null;
}

async function fetchTrainingReadings(testCase: TestCase, deps: BacktestDeps): Promise<RawReading[]> {
  const cutoffYear = Number(testCase.cutoffDateOnly.slice(0, 4));
  const datasets = resolveTrainingDatasets(cutoffYear, testCase.cutoffDateOnly);

  const allReadings: RawReading[] = [];
  for (const dataset of datasets) {
    const bounds: BucketWhereBounds = dataset.upperBoundNaive === null ? {} : { upperBoundNaive: dataset.upperBoundNaive };
    const where = buildBucketWhereClause(testCase, bounds);
    const records = await deps.fetchRecords(buildSocrataDatasetUrl(dataset.datasetId), where);
    allReadings.push(...parseRawReadings(records).readings);
  }
  return allReadings;
}

async function fetchGroundTruthReadings(testCase: TestCase, deps: BacktestDeps): Promise<RawReading[]> {
  const cutoffYear = Number(testCase.cutoffDateOnly.slice(0, 4));
  const datasetId = resolveGroundTruthDataset(cutoffYear);
  const groundTruthEndDateOnly = addCalendarDays(testCase.cutoffDateOnly, testCase.horizonDays);

  const where = buildBucketWhereClause(testCase, {
    lowerBoundNaive: naiveMidnight(testCase.cutoffDateOnly),
    upperBoundNaive: naiveEndOfDay(groundTruthEndDateOnly),
  });
  const records = await deps.fetchRecords(buildSocrataDatasetUrl(datasetId), where);
  return parseRawReadings(records).readings;
}

// Recomputes what decideBucketStats would have produced as of testCase's
// cutoff -- normalizeReading/calculateRecencyWeight/decideBucketStats
// called exactly as backfill-occupancy-stats.ts calls them for the real
// pipeline, just with now = the historical cutoff instead of new Date().
function predictFromTraining(
  trainingReadings: readonly RawReading[],
  testCase: TestCase,
  now: Date,
): { stats: BucketStats | null; observedParkingSpaceCount: number | null } {
  const lookup = buildSingleBlockfaceLookup(testCase);
  const currentYear = getPacificCalendarYear(now);

  const weighted: WeightedReading[] = [];
  for (const reading of trainingReadings) {
    const normalized = normalizeReading(reading, lookup, now);
    if (!normalized.matched) {
      // Would only happen if a fetched reading's own sourceElementKey/
      // sideOfStreet didn't match this test case's -- can't happen given
      // the $where clause already filtered on both, but normalizeReading
      // is defensive regardless, so this stays defensive too rather than
      // asserting it away.
      continue;
    }
    const weight = calculateRecencyWeight(normalized.ageInDays, normalized.readingYear, currentYear);
    weighted.push({ value: normalized.occupancyRatio, weight });
  }

  return {
    stats: decideBucketStats(weighted),
    observedParkingSpaceCount: mostCommonParkingSpaceCount(trainingReadings),
  };
}

export async function runTestCase(testCase: TestCase, deps: BacktestDeps): Promise<TestCaseResult> {
  const base = {
    label: testCase.label,
    blockfaceId: testCase.blockfaceId,
    isoDay: testCase.isoDay,
    hour: testCase.hour,
    cutoffDateOnly: testCase.cutoffDateOnly,
    horizonDays: testCase.horizonDays,
    slice: testCase.slice,
  };
  const empty: TestCaseResult = {
    ...base,
    predictedMean: null,
    confidenceScore: null,
    sampleCount: null,
    stdDev: null,
    observedParkingSpaceCount: null,
    lowCapacity: false,
    singleNearestActualMean: null,
    multiOccurrenceActualMean: null,
    groundTruthOccurrenceCount: 0,
    groundTruthReadingCount: 0,
    errorSingleNearest: null,
    absErrorSingleNearest: null,
    errorMultiOccurrence: null,
    absErrorMultiOccurrence: null,
    skippedReason: null,
    skippedDetail: null,
  };

  let trainingReadings: RawReading[];
  let groundTruthReadings: RawReading[];
  try {
    const now = pacificMidnightInstant(testCase.cutoffDateOnly);
    trainingReadings = await fetchTrainingReadings(testCase, deps);
    groundTruthReadings = await fetchGroundTruthReadings(testCase, deps);

    const { stats, observedParkingSpaceCount } = predictFromTraining(trainingReadings, testCase, now);
    const groundTruth = computeGroundTruth(groundTruthReadings);

    if (stats === null) {
      return { ...empty, observedParkingSpaceCount, skippedReason: "insufficient_training_data" };
    }
    // testCase.horizonDays is the ground-truth window's own upper bound,
    // used directly as calculateConfidenceScore's daysInFuture -- a
    // deliberate simplification, not always exactly how far out any ONE
    // specific occurrence within that window really is (see GroundTruth's
    // own comment: the nearest occurrence can be same-day, well under
    // horizonDays away). Treating the requested horizon itself as "how far
    // out this prediction reaches" mirrors how a real live request would
    // set daysInFuture (resolveRequestTime.ts resolves it from the
    // request's own target instant, not from whichever occurrence of a
    // bucket happens to land soonest).
    const confidenceScore = calculateConfidenceScore(stats.sampleCount, stats.stdDev, testCase.horizonDays);
    const lowCapacity = observedParkingSpaceCount !== null && observedParkingSpaceCount < LOW_CAPACITY_THRESHOLD;

    if (groundTruth.singleNearestMean === null) {
      return {
        ...empty,
        predictedMean: stats.mean,
        confidenceScore,
        sampleCount: stats.sampleCount,
        stdDev: stats.stdDev,
        observedParkingSpaceCount,
        lowCapacity,
        skippedReason: "no_ground_truth_data",
      };
    }

    const errorSingleNearest = stats.mean - groundTruth.singleNearestMean;
    const errorMultiOccurrence = groundTruth.multiOccurrenceMean !== null ? stats.mean - groundTruth.multiOccurrenceMean : null;

    return {
      ...base,
      predictedMean: stats.mean,
      confidenceScore,
      sampleCount: stats.sampleCount,
      stdDev: stats.stdDev,
      observedParkingSpaceCount,
      lowCapacity,
      singleNearestActualMean: groundTruth.singleNearestMean,
      multiOccurrenceActualMean: groundTruth.multiOccurrenceMean,
      groundTruthOccurrenceCount: groundTruth.occurrenceCount,
      groundTruthReadingCount: groundTruth.totalReadingCount,
      errorSingleNearest,
      absErrorSingleNearest: Math.abs(errorSingleNearest),
      errorMultiOccurrence,
      absErrorMultiOccurrence: errorMultiOccurrence !== null ? Math.abs(errorMultiOccurrence) : null,
      skippedReason: null,
      skippedDetail: null,
    };
  } catch (err) {
    // One test case's real Socrata fetch failing (a network hiccup,
    // despite fetchSocrataRecords' own internal retry-with-backoff)
    // shouldn't abort the whole run -- same per-case failure isolation
    // philosophy as the real batch job's occupancy_stats_backfill_failures
    // (see CLAUDE.md's Architecture section). Recorded plainly, not
    // silently dropped.
    const message = err instanceof Error ? err.message : String(err);
    return { ...empty, skippedReason: "fetch_error", skippedDetail: message };
  }
}

// --- Summary metrics -------------------------------------------------------

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error("mean: values must not be empty -- there is no meaningful mean of zero values");
  }
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// Standard Pearson correlation coefficient. n < 2 has no meaningful
// correlation to compute at all (no variance is even expressible from a
// single point), so this throws rather than returning a placeholder --
// same discrete/structural-validity reasoning as calculateWeightedStats'
// own empty-input throw. Zero variance in either series (every value
// identical) IS a real, well-formed-but-degenerate case -- correlation is
// mathematically undefined there (0/0), and this returns 0 rather than
// NaN, documented here as a deliberate simplification rather than a
// silently wrong value.
export function pearsonCorrelation(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length !== ys.length) {
    throw new Error(`pearsonCorrelation: xs and ys must be the same length, got ${xs.length} and ${ys.length}`);
  }
  if (xs.length < 2) {
    throw new Error(`pearsonCorrelation: need at least 2 data points, got ${xs.length}`);
  }
  const meanX = mean(xs);
  const meanY = mean(ys);
  let numerator = 0;
  let denomX = 0;
  let denomY = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = (xs[i] as number) - meanX;
    const dy = (ys[i] as number) - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  if (denomX === 0 || denomY === 0) {
    return 0;
  }
  return numerator / Math.sqrt(denomX * denomY);
}

// --- Bootstrap resampling ---------------------------------------------

// Percentile-method bootstrap on the mean: resamples `values` WITH
// replacement `resampleCount` times, recomputes the mean of each
// resample, and reports the [alpha/2, 1-alpha/2] percentiles of that
// distribution as a confidence interval -- the standard, model-free way
// to ask "how much would this mean plausibly have moved if a few
// different real cases had been drawn instead of the ones we actually
// have," without assuming any particular distribution shape for the
// underlying errors. fractionResamplesNegative is the practical
// trustworthiness check this harness actually needs: if a slice's real
// mean signed error is negative (a bias), the fraction of RESAMPLES that
// are also negative answers "how often would we have seen the same sign
// of bias, if we'd happened to draw a slightly different set of real
// cases" -- close to 1 means the sign is stable/trustworthy, close to 0.5
// means it's plausibly just noise around zero.
export interface BootstrapResult {
  observedMean: number;
  meanOfResampleMeans: number;
  lowerBound: number;
  upperBound: number;
  fractionResamplesNegative: number;
  resampleCount: number;
  sampleSize: number;
}

export function bootstrapMeanConfidenceInterval(
  values: readonly number[],
  resampleCount: number,
  confidenceLevel: number,
  // Injected rather than always Math.random -- the same testability-driven
  // pattern this whole project uses for "now" (see this file's header
  // comment): a deterministic randomFn lets this function's own tests
  // hand-verify an exact result instead of only checking loose statistical
  // properties.
  randomFn: () => number = Math.random,
): BootstrapResult {
  if (values.length === 0) {
    throw new Error("bootstrapMeanConfidenceInterval: values must not be empty -- there is no meaningful mean to bootstrap");
  }
  if (!Number.isInteger(resampleCount) || resampleCount <= 0) {
    throw new Error(`bootstrapMeanConfidenceInterval: resampleCount must be a positive integer, got ${resampleCount}`);
  }
  if (!Number.isFinite(confidenceLevel) || confidenceLevel <= 0 || confidenceLevel >= 1) {
    throw new Error(`bootstrapMeanConfidenceInterval: confidenceLevel must be a finite number strictly between 0 and 1, got ${confidenceLevel}`);
  }

  const observedMean = mean(values);
  const resampleMeans: number[] = [];
  for (let i = 0; i < resampleCount; i++) {
    let sum = 0;
    for (let j = 0; j < values.length; j++) {
      const index = Math.floor(randomFn() * values.length);
      sum += values[index] as number;
    }
    resampleMeans.push(sum / values.length);
  }
  resampleMeans.sort((a, b) => a - b);

  const alpha = 1 - confidenceLevel;
  const lowerIndex = Math.floor((alpha / 2) * resampleCount);
  const upperIndex = Math.min(Math.ceil((1 - alpha / 2) * resampleCount) - 1, resampleCount - 1);

  return {
    observedMean,
    meanOfResampleMeans: mean(resampleMeans),
    lowerBound: resampleMeans[lowerIndex] as number,
    upperBound: resampleMeans[upperIndex] as number,
    fractionResamplesNegative: resampleMeans.filter((m) => m < 0).length / resampleCount,
    resampleCount,
    sampleSize: values.length,
  };
}

const DEFAULT_BOOTSTRAP_RESAMPLES = 10_000;
const DEFAULT_BOOTSTRAP_CONFIDENCE_LEVEL = 0.95;

export interface ConfidenceBucketSummary {
  confidenceScore: number;
  count: number;
  maeSingleNearest: number;
  maeMultiOccurrence: number;
}

export interface SliceSummary {
  name: string;
  count: number;
  maeSingleNearest: number;
  maeMultiOccurrence: number;
  meanSignedErrorSingleNearest: number;
  // Bootstrap validation of meanSignedErrorSingleNearest -- null only when
  // there's nothing scored to bootstrap (see summarizeSlice). Answers "is
  // this slice's average bias a real, stable pattern, or could it plausibly
  // just be noise from which particular real cases happened to be in the
  // fixed test list" -- see bootstrapMeanConfidenceInterval's own comment.
  bootstrap: BootstrapResult | null;
}

export interface SummaryReport {
  totalCases: number;
  scoredCases: number;
  skippedInsufficientTraining: number;
  skippedNoGroundTruth: number;
  skippedFetchError: number;
  overallMaeSingleNearest: number;
  overallMaeMultiOccurrence: number;
  meanSignedErrorSingleNearest: number;
  // Headline calibration number: Pearson correlation between
  // confidenceScore and absErrorSingleNearest. A working calibration
  // should show a NEGATIVE correlation -- higher confidence going with
  // LOWER error.
  confidenceErrorCorrelation: number;
  confidenceBuckets: ConfidenceBucketSummary[];
  slices: SliceSummary[];
}

function summarizeSlice(name: string, results: readonly TestCaseResult[]): SliceSummary {
  const scored = results.filter((r) => r.skippedReason === null);
  if (scored.length === 0) {
    return { name, count: results.length, maeSingleNearest: NaN, maeMultiOccurrence: NaN, meanSignedErrorSingleNearest: NaN, bootstrap: null };
  }
  const signedErrors = scored.map((r) => r.errorSingleNearest as number);
  return {
    name,
    count: results.length,
    maeSingleNearest: mean(scored.map((r) => r.absErrorSingleNearest as number)),
    maeMultiOccurrence: mean(
      scored.filter((r) => r.absErrorMultiOccurrence !== null).map((r) => r.absErrorMultiOccurrence as number),
    ),
    meanSignedErrorSingleNearest: mean(signedErrors),
    bootstrap: bootstrapMeanConfidenceInterval(signedErrors, DEFAULT_BOOTSTRAP_RESAMPLES, DEFAULT_BOOTSTRAP_CONFIDENCE_LEVEL),
  };
}

export function computeSummary(results: readonly TestCaseResult[]): SummaryReport {
  const scored = results.filter((r) => r.skippedReason === null);
  if (scored.length === 0) {
    throw new Error("computeSummary: no scored test cases -- there is no meaningful summary to compute (every case was skipped)");
  }

  const confidenceBucketMap = new Map<number, TestCaseResult[]>();
  for (const result of scored) {
    const score = result.confidenceScore as number;
    const bucket = confidenceBucketMap.get(score) ?? [];
    bucket.push(result);
    confidenceBucketMap.set(score, bucket);
  }
  const confidenceBuckets: ConfidenceBucketSummary[] = [...confidenceBucketMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([confidenceScore, bucketResults]) => ({
      confidenceScore,
      count: bucketResults.length,
      maeSingleNearest: mean(bucketResults.map((r) => r.absErrorSingleNearest as number)),
      maeMultiOccurrence: mean(
        bucketResults.filter((r) => r.absErrorMultiOccurrence !== null).map((r) => r.absErrorMultiOccurrence as number),
      ),
    }));

  const slices: SliceSummary[] = [
    summarizeSlice("capitol_hill_saturday", results.filter((r) => r.slice === "capitol_hill_saturday")),
    summarizeSlice("general", results.filter((r) => r.slice === "general")),
    summarizeSlice(`low_capacity (<${LOW_CAPACITY_THRESHOLD} spaces)`, results.filter((r) => r.lowCapacity)),
    summarizeSlice(
      `standard_capacity (>=${LOW_CAPACITY_THRESHOLD} spaces)`,
      results.filter((r) => r.observedParkingSpaceCount !== null && !r.lowCapacity),
    ),
  ];

  return {
    totalCases: results.length,
    scoredCases: scored.length,
    skippedInsufficientTraining: results.filter((r) => r.skippedReason === "insufficient_training_data").length,
    skippedNoGroundTruth: results.filter((r) => r.skippedReason === "no_ground_truth_data").length,
    skippedFetchError: results.filter((r) => r.skippedReason === "fetch_error").length,
    overallMaeSingleNearest: mean(scored.map((r) => r.absErrorSingleNearest as number)),
    overallMaeMultiOccurrence: mean(
      scored.filter((r) => r.absErrorMultiOccurrence !== null).map((r) => r.absErrorMultiOccurrence as number),
    ),
    meanSignedErrorSingleNearest: mean(scored.map((r) => r.errorSingleNearest as number)),
    confidenceErrorCorrelation: pearsonCorrelation(
      scored.map((r) => r.confidenceScore as number),
      scored.map((r) => r.absErrorSingleNearest as number),
    ),
    confidenceBuckets,
    slices,
  };
}

// --- Output formatting -----------------------------------------------------

const CSV_COLUMNS: readonly (keyof TestCaseResult)[] = [
  "label",
  "blockfaceId",
  "isoDay",
  "hour",
  "cutoffDateOnly",
  "horizonDays",
  "slice",
  "predictedMean",
  "confidenceScore",
  "sampleCount",
  "stdDev",
  "observedParkingSpaceCount",
  "lowCapacity",
  "singleNearestActualMean",
  "multiOccurrenceActualMean",
  "groundTruthOccurrenceCount",
  "groundTruthReadingCount",
  "errorSingleNearest",
  "absErrorSingleNearest",
  "errorMultiOccurrence",
  "absErrorMultiOccurrence",
  "skippedReason",
  "skippedDetail",
];

function csvCell(value: TestCaseResult[keyof TestCaseResult]): string {
  if (value === null) {
    return "";
  }
  const stringValue = String(value);
  if (stringValue.includes(",") || stringValue.includes('"') || stringValue.includes("\n")) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

export function formatCsv(results: readonly TestCaseResult[]): string {
  const header = CSV_COLUMNS.join(",");
  const rows = results.map((result) => CSV_COLUMNS.map((column) => csvCell(result[column])).join(","));
  return [header, ...rows].join("\n") + "\n";
}

// --- CSV parsing (the inverse of formatCsv) ---------------------------
//
// Lets --from-csv (see main()) recompute a summary/bootstrap analysis
// against an ALREADY-COLLECTED real run's per-case CSV, without re-running
// the live Socrata queries that produced it -- e.g. to validate a slice's
// bias with bootstrapMeanConfidenceInterval, or to try a different
// resample count, against the exact same real results already on disk.

// Full-text state machine, not a per-line split -- a quoted field can
// legitimately contain a literal newline (see csvCell's own quoting rule),
// so splitting on "\n" first would corrupt exactly the kind of value (a
// multi-line error message in skippedDetail) most likely to need it.
function parseCsvRecords(csvText: string): string[][] {
  const records: string[][] = [];
  let currentField = "";
  let currentRecord: string[] = [];
  let inQuotes = false;
  let i = 0;

  while (i < csvText.length) {
    const char = csvText[i] as string;
    if (inQuotes) {
      if (char === '"') {
        if (csvText[i + 1] === '"') {
          currentField += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      currentField += char;
      i += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ",") {
      currentRecord.push(currentField);
      currentField = "";
      i += 1;
      continue;
    }
    if (char === "\n" || char === "\r") {
      currentRecord.push(currentField);
      records.push(currentRecord);
      currentField = "";
      currentRecord = [];
      i += char === "\r" && csvText[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    currentField += char;
    i += 1;
  }
  if (currentField.length > 0 || currentRecord.length > 0) {
    currentRecord.push(currentField);
    records.push(currentRecord);
  }
  return records;
}

const NULLABLE_NUMBER_COLUMNS = new Set<keyof TestCaseResult>([
  "predictedMean",
  "confidenceScore",
  "sampleCount",
  "stdDev",
  "observedParkingSpaceCount",
  "singleNearestActualMean",
  "multiOccurrenceActualMean",
  "errorSingleNearest",
  "absErrorSingleNearest",
  "errorMultiOccurrence",
  "absErrorMultiOccurrence",
]);
const REQUIRED_NUMBER_COLUMNS = new Set<keyof TestCaseResult>([
  "isoDay",
  "hour",
  "horizonDays",
  "groundTruthOccurrenceCount",
  "groundTruthReadingCount",
]);
// The two nullable STRING columns -- skippedReason/skippedDetail are null
// on every scored (non-skipped) result, distinct from NULLABLE_NUMBER_COLUMNS
// above (which are null on every SKIPPED result instead).
const NULLABLE_STRING_COLUMNS = new Set<keyof TestCaseResult>(["skippedReason", "skippedDetail"]);

function parseCsvCell(column: keyof TestCaseResult, raw: string): unknown {
  if (column === "lowCapacity") {
    return raw === "true";
  }
  if (raw === "") {
    // Only the nullable columns are ever legitimately empty (see csvCell's
    // own null -> "" rule) -- an empty cell under any other column means
    // this file wasn't really produced by formatCsv.
    if (!NULLABLE_NUMBER_COLUMNS.has(column) && !NULLABLE_STRING_COLUMNS.has(column)) {
      throw new Error(`parseResultsCsv: column "${column}" is never null, but got an empty cell`);
    }
    return null;
  }
  if (NULLABLE_NUMBER_COLUMNS.has(column) || REQUIRED_NUMBER_COLUMNS.has(column)) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      throw new Error(`parseResultsCsv: expected a number for column "${column}", got "${raw}"`);
    }
    return parsed;
  }
  return raw; // label, blockfaceId, cutoffDateOnly, slice, skippedReason, skippedDetail
}

export function parseResultsCsv(csvText: string): TestCaseResult[] {
  const records = parseCsvRecords(csvText).filter((record) => !(record.length === 1 && record[0] === ""));
  if (records.length === 0) {
    return [];
  }
  const header = records[0] as string[];
  const expectedHeader = CSV_COLUMNS as readonly string[];
  if (header.length !== expectedHeader.length || header.some((col, i) => col !== expectedHeader[i])) {
    throw new Error(
      "parseResultsCsv: CSV header does not match the columns formatCsv writes -- was this file really produced by formatCsv?",
    );
  }

  return records.slice(1).map((row, rowIndex) => {
    if (row.length !== CSV_COLUMNS.length) {
      throw new Error(`parseResultsCsv: row ${rowIndex + 1} has ${row.length} fields, expected ${CSV_COLUMNS.length}`);
    }
    const result = {} as Record<keyof TestCaseResult, unknown>;
    CSV_COLUMNS.forEach((column, i) => {
      result[column] = parseCsvCell(column, row[i] as string);
    });
    return result as unknown as TestCaseResult;
  });
}

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function signedPct(ratio: number): string {
  return `${ratio >= 0 ? "+" : ""}${pct(ratio)}`;
}

export function formatSummaryReport(summary: SummaryReport): string {
  const lines: string[] = [];
  lines.push("=== backtest-predictions summary ===");
  lines.push(`Total test cases:              ${summary.totalCases}`);
  lines.push(`Scored:                        ${summary.scoredCases}`);
  lines.push(`Skipped (insufficient train):  ${summary.skippedInsufficientTraining}`);
  lines.push(`Skipped (no ground truth):     ${summary.skippedNoGroundTruth}`);
  lines.push(`Skipped (fetch error):         ${summary.skippedFetchError}`);
  lines.push("");
  lines.push(`Overall MAE (single-nearest-occurrence):     ${pct(summary.overallMaeSingleNearest)}`);
  lines.push(`Overall MAE (multi-occurrence-averaged):     ${pct(summary.overallMaeMultiOccurrence)}`);
  lines.push(`Mean signed error (single-nearest):          ${signedPct(summary.meanSignedErrorSingleNearest)} (positive = over-predicts occupancy)`);
  lines.push(`Confidence-vs-error correlation (headline):  ${summary.confidenceErrorCorrelation.toFixed(3)} (negative = working calibration: higher confidence, lower error)`);
  lines.push("");
  lines.push("--- MAE by confidence-score bucket ---");
  lines.push("score  count  MAE(single)  MAE(multi)");
  for (const bucket of summary.confidenceBuckets) {
    lines.push(
      `${String(bucket.confidenceScore).padStart(5)}  ${String(bucket.count).padStart(5)}  ${pct(bucket.maeSingleNearest).padStart(10)}  ${pct(bucket.maeMultiOccurrence).padStart(9)}`,
    );
  }
  lines.push("");
  lines.push("--- Slices ---");
  lines.push("(bootstrap: 95% CI on the mean signed error, from 10,000 resamples -- see bootstrapMeanConfidenceInterval)");
  for (const slice of summary.slices) {
    const bootstrapStr =
      slice.bootstrap === null
        ? "bootstrap=n/a"
        : `bootstrap95%CI=[${signedPct(slice.bootstrap.lowerBound)}, ${signedPct(slice.bootstrap.upperBound)}] (${(slice.bootstrap.fractionResamplesNegative * 100).toFixed(0)}% of resamples negative)`;
    lines.push(
      `${slice.name.padEnd(32)} n=${String(slice.count).padStart(4)}  MAE(single)=${pct(slice.maeSingleNearest)}  MAE(multi)=${pct(slice.maeMultiOccurrence)}  signed=${signedPct(slice.meanSignedErrorSingleNearest)}  ${bootstrapStr}`,
    );
  }
  lines.push("=====================================");
  return lines.join("\n");
}

// --- Orchestration -----------------------------------------------------

export interface CliOptions {
  limit: number | null;
  outDir: string;
  // Re-analyze an already-collected real run's CSV (see parseResultsCsv)
  // instead of hitting Socrata again -- e.g. to bootstrap-validate a
  // slice's bias, or try a different resample count, against exactly the
  // same real results already on disk.
  fromCsv: string | null;
}

// --limit is a testing convenience -- run only the first N test cases
// instead of the full fixed list, the same spirit as backfill-occupancy-
// stats.ts's --max-chunks. Same reasoning for throwing on a malformed
// value: a CLI flag has no meaningful "nearest valid" fallback.
export function parseCliOptions(argv: readonly string[]): CliOptions {
  let limit: number | null = null;
  let outDir = "backtest-output";
  let fromCsv: string | null = null;
  for (const arg of argv) {
    const limitMatch = /^--limit=(.+)$/.exec(arg);
    if (limitMatch !== null) {
      const rawValue = limitMatch[1] as string;
      const parsed = Number(rawValue);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`backtest-predictions: --limit must be a positive integer, got "${rawValue}"`);
      }
      limit = parsed;
      continue;
    }
    const outDirMatch = /^--out-dir=(.+)$/.exec(arg);
    if (outDirMatch !== null) {
      outDir = outDirMatch[1] as string;
      continue;
    }
    const fromCsvMatch = /^--from-csv=(.+)$/.exec(arg);
    if (fromCsvMatch !== null) {
      fromCsv = fromCsvMatch[1] as string;
    }
  }
  return { limit, outDir, fromCsv };
}

async function runFullBacktest(limit: number | null): Promise<TestCaseResult[]> {
  const testCases = limit === null ? [...TEST_CASES] : TEST_CASES.slice(0, limit);
  console.log(
    `Running ${testCases.length} of ${TEST_CASES.length} fixed backtest cases${limit !== null ? ` (--limit=${limit})` : ""}...`,
  );

  const results: TestCaseResult[] = [];
  for (const [index, testCase] of testCases.entries()) {
    process.stdout.write(`  [${index + 1}/${testCases.length}] ${testCase.label} ... `);
    const result = await runTestCase(testCase, REAL_BACKTEST_DEPS);
    results.push(result);
    console.log(result.skippedReason === null ? `predicted=${pct(result.predictedMean as number)} actual=${pct(result.singleNearestActualMean as number)}` : `skipped (${result.skippedReason})`);
  }
  return results;
}

export async function main(): Promise<void> {
  const { limit, outDir, fromCsv } = parseCliOptions(process.argv.slice(2));

  let results: TestCaseResult[];
  if (fromCsv !== null) {
    console.log(`Re-analyzing existing results from ${fromCsv} (no Socrata queries this run)...`);
    results = parseResultsCsv(await readFile(fromCsv, "utf-8"));
    console.log(`Loaded ${results.length} rows.`);
  } else {
    results = await runFullBacktest(limit);
  }

  await mkdir(outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(outDir, `backtest-predictions-${timestamp}.txt`);

  // Only write a fresh CSV when this run actually collected new results --
  // re-analyzing an existing CSV (--from-csv) has nothing new to write back,
  // the input file already IS that CSV.
  if (fromCsv === null) {
    const csvPath = path.join(outDir, `backtest-predictions-${timestamp}.csv`);
    await writeFile(csvPath, formatCsv(results), "utf-8");
    console.log(`\nPer-case CSV written to:  ${csvPath}`);
  }

  const summary = computeSummary(results);
  const report = formatSummaryReport(summary);
  await writeFile(reportPath, report, "utf-8");

  console.log("\n" + report);
  console.log(`Summary report written to: ${reportPath}`);
}

const isRunDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isRunDirectly) {
  main().catch((error: unknown) => {
    console.error("backtest-predictions: fatal error:", error);
    process.exitCode = 1;
  });
}
