import type { SupabaseQueryResult } from "../importers/upsertBlockface.ts";
import { calculateConfidenceScore } from "./confidenceScore.ts";
import { applyAreaCorrection } from "./areaCorrectionCalibration.ts";
import type { AreaCalibration, CalibrationBand } from "./areaCorrectionCalibration.ts";

// --- Raw RPC row shapes --------------------------------------------------
//
// Exact column names returned by nearby_blockfaces / nearby_off_street_facilities
// (migrations/017_add_nearby_spatial_search_functions.sql) -- snake_case,
// matching what supabase-js's .rpc() hands back verbatim, not remapped.

interface GeoJsonGeometry {
  type: string;
  coordinates: unknown;
}

export interface NearbyBlockfaceRow {
  id: string;
  street_name: string;
  cross_street_from: string;
  cross_street_to: string;
  side_of_street: string;
  is_paid: boolean;
  starting_rate_usd: number | null;
  operating_days: number[];
  operating_hours_start: string;
  operating_hours_end: string;
  rate_tiers: BlockfaceRateTier[];
  location_geojson: GeoJsonGeometry;
  distance_meters: number;
  // Added by migrations/026 -- null for the vast majority of blockfaces
  // (most of the city has no SDOT-designated paid-parking area at all).
  // Feeds applyAreaCorrection below; otherwise unused.
  paidparkingarea: string | null;
  paidparkingsubarea: string | null;
}

export interface BlockfaceRateTier {
  day_type: string;
  tier_number: number;
  start_time: string;
  end_time: string;
  rate_usd: number;
}

export interface NearbyOffStreetFacilityRow {
  id: string;
  name: string;
  address: string | null;
  capacity: number | null;
  facility_type: string | null;
  operator_name: string | null;
  rate_tiers: OffStreetRateTier[];
  location_geojson: GeoJsonGeometry;
  distance_meters: number;
}

export interface OffStreetRateTier {
  duration_type: string;
  rate_usd: number | null;
  rate_note: string | null;
}

// --- occupancy_stats client shape ----------------------------------------
//
// Minimal, table-name-generic DI shape, same pattern as this project's
// other narrow Supabase client interfaces (blockfaceLookup.ts,
// geocodeAddress.ts). Only .eq()/.in() chaining is needed -- the whole
// point of this lookup is one batched query (day_of_week + hour_of_day +
// blockface_id IN (...)), never one query per candidate.

interface OccupancyStatsRow {
  blockface_id: string;
  mean_occupancy: number;
  std_dev: number;
  sample_count: number;
}

export interface OccupancyStatsQueryBuilder extends PromiseLike<SupabaseQueryResult<OccupancyStatsRow[]>> {
  eq(column: string, value: string | number): OccupancyStatsQueryBuilder;
  in(column: string, values: string[]): OccupancyStatsQueryBuilder;
}

export interface OccupancyStatsSupabaseTableBuilder {
  select(columns: string): OccupancyStatsQueryBuilder;
}

export interface OccupancyStatsSupabaseClient {
  from(table: string): OccupancyStatsSupabaseTableBuilder;
}

// One batched query for every blockface candidate at once, keyed by
// blockface_id for O(1) lookup while assembling results below. Skips the
// query entirely when there are no blockface candidates at all (a search
// that returned only off-street facilities, or none) -- an empty .in()
// list is pointless to send and not worth a round trip.
async function fetchOccupancyStatsForCandidates(
  client: OccupancyStatsSupabaseClient,
  blockfaceIds: string[],
  isoDay: number,
  hour: number,
): Promise<Map<string, OccupancyStatsRow>> {
  const map = new Map<string, OccupancyStatsRow>();
  if (blockfaceIds.length === 0) {
    return map;
  }

  const { data, error } = await client
    .from("occupancy_stats")
    .select("blockface_id, mean_occupancy, std_dev, sample_count")
    .eq("day_of_week", isoDay)
    .eq("hour_of_day", hour)
    .in("blockface_id", blockfaceIds);

  if (error !== null) {
    throw new Error(`assembleSearchResults: reading occupancy_stats failed: ${error.message}`);
  }

  for (const row of data ?? []) {
    map.set(row.blockface_id, row);
  }
  return map;
}

// --- area_occupancy_corrections client shape -----------------------------
//
// Deliberately no .eq()/.in() -- unlike occupancy_stats (keyed per
// candidate blockface), this table is read in full on every request: it's
// small (a handful of rows per staged area/subarea, not one row per
// blockface) and every band across every calibrated area/subarea is
// needed up front, since which specific band applies depends on each
// candidate's own raw predicted percentage.

interface AreaCorrectionRow {
  paidparkingarea: string;
  paidparkingsubarea: string | null;
  predicted_band_low: number;
  predicted_band_high: number;
  corrected_pct: number;
  sample_count: number;
}

export type AreaCorrectionsQueryResult = PromiseLike<SupabaseQueryResult<AreaCorrectionRow[]>>;

export interface AreaCorrectionsSupabaseTableBuilder {
  select(columns: string): AreaCorrectionsQueryResult;
}

export interface AreaCorrectionsSupabaseClient {
  from(table: string): AreaCorrectionsSupabaseTableBuilder;
}

// Groups the table's per-band rows back into areaCorrectionCalibration.ts's
// AreaCalibration shape (one entry per real area/subarea, each holding all
// of its bands) -- the inverse of fit-and-write-area-corrections.ts's own
// buildRows, which flattened calibrations into these same per-band rows in
// the first place.
async function fetchAreaCalibrations(client: AreaCorrectionsSupabaseClient): Promise<AreaCalibration[]> {
  const { data, error } = await client.from("area_occupancy_corrections").select("paidparkingarea, paidparkingsubarea, predicted_band_low, predicted_band_high, corrected_pct, sample_count");
  if (error !== null) {
    throw new Error(`assembleSearchResults: reading area_occupancy_corrections failed: ${error.message}`);
  }

  const byKey = new Map<string, AreaCalibration>();
  for (const row of data ?? []) {
    const key = `${row.paidparkingarea}|${row.paidparkingsubarea ?? ""}`;
    const band: CalibrationBand = {
      predictedBandLow: row.predicted_band_low,
      predictedBandHigh: row.predicted_band_high,
      correctedPct: row.corrected_pct,
      sampleCount: row.sample_count,
    };
    const existing = byKey.get(key);
    if (existing !== undefined) {
      existing.bands.push(band);
    } else {
      byKey.set(key, { paidParkingArea: row.paidparkingarea, paidParkingSubarea: row.paidparkingsubarea, bands: [band] });
    }
  }
  return Array.from(byKey.values());
}

// --- Confidence percentage/color -----------------------------------------

// calculateConfidenceScore already rounds to an integer 0-10, so this
// percentage always lands on a multiple of 10 -- the exact boundary values
// below (75/50/25) are therefore never hit precisely, only crossed (e.g.
// 70 vs 80 either side of 75). That's expected, not a bug to "fix": these
// are still the correct thresholds to compare against.
function scoreToPercentage(score: number): number {
  return (score / 10) * 100;
}

export type ConfidenceColor = "green" | "yellow" | "orange" | "red";

function percentageToColor(percentage: number): ConfidenceColor {
  if (percentage >= 75) return "green";
  if (percentage >= 50) return "yellow";
  if (percentage >= 25) return "orange";
  return "red";
}

// --- Occupancy percentage/color -------------------------------------------

// meanOccupancy is already a 0-1 ratio (unlike calculateConfidenceScore's
// 0-10 integer score), so this is a straight *100, not a /10*100 like
// scoreToPercentage above.
function occupancyToPercentage(meanOccupancy: number): number {
  return meanOccupancy * 100;
}

// Same 75/50/25 percentage bands as confidence's percentageToColor, but
// DELIBERATELY INVERTED: for confidence, high is good (green); for
// occupancy, high is bad (nearly full, red) and low is good (available,
// green) -- the exact opposite direction. This is its own function, not a
// reuse of percentageToColor, specifically so the two can never be
// accidentally swapped or share a bug -- confirmed by this file's own
// tests that a 90% occupancy reading produces red, never green, the
// dangerous mistake this split guards against.
export function calculateOccupancyColor(percentage: number): ConfidenceColor {
  if (percentage >= 75) return "red";
  if (percentage >= 50) return "orange";
  if (percentage >= 25) return "yellow";
  return "green";
}

// --- Result shape ----------------------------------------------------------

export interface BlockfacePricing {
  isPaid: boolean;
  startingRateUsd: number | null;
  rateTiers: BlockfaceRateTier[];
}

export interface OffStreetPricing {
  rateTiers: OffStreetRateTier[];
}

interface BaseCandidateResult {
  id: string;
  name: string;
  geometry: GeoJsonGeometry;
  distanceMeters: number;
}

export interface BlockfaceConfidence {
  score: number; // 0-10, calculateConfidenceScore's own output
  percentage: number; // 0-100
  color: ConfidenceColor;
  // 0-1, the RAW predicted occupancy ratio straight from occupancy_stats --
  // deliberately NEVER area-corrected, even when occupancyPercent below is.
  // calculateConfidenceScore's inputs (sample_count/std_dev/daysInFuture)
  // are about the RAW prediction's own statistical reliability, which the
  // area correction doesn't change or know about -- correcting this value
  // too would conflate "how much do we trust the raw historical data" with
  // "how far off do we independently believe that data runs."
  meanOccupancy: number;
}

export interface BlockfaceHasDataResult extends BaseCandidateResult {
  type: "blockface";
  hasData: true;
  confidence: BlockfaceConfidence;
  // Predicted occupancy, as its own primary, color-coded field -- distinct
  // from confidence.percentage/confidence.color, and NOT the same
  // percentage-to-color mapping: occupancyColor is inverted relative to
  // confidence.color (low occupancy is good/green, high is bad/red -- see
  // calculateOccupancyColor's own comment). This IS the area-corrected
  // value where a real, fitted area_occupancy_corrections row applies to
  // this blockface's area/subarea and raw percentage band -- otherwise
  // identical to the raw prediction (see applyAreaCorrection).
  occupancyPercent: number; // 0-100
  occupancyColor: ConfidenceColor;
  pricing: BlockfacePricing;
}

export interface BlockfaceNoDataResult extends BaseCandidateResult {
  type: "blockface";
  hasData: false;
  pricing: BlockfacePricing;
}

export interface OffStreetFacilityResult extends BaseCandidateResult {
  type: "off_street_facility";
  // Always false -- no occupancy prediction exists structurally for
  // off-street facilities (no occupancy_stats row is ever written for
  // anything but a blockface_id -- see occupancy_stats' own schema).
  hasData: false;
  pricing: OffStreetPricing;
}

export type CandidateResult = BlockfaceHasDataResult | BlockfaceNoDataResult | OffStreetFacilityResult;

// --- Assembling individual results ----------------------------------------

function buildBlockfaceName(row: NearbyBlockfaceRow): string {
  return `${row.street_name} (${row.cross_street_from} to ${row.cross_street_to}), ${row.side_of_street} side`;
}

function buildBlockfacePricing(row: NearbyBlockfaceRow): BlockfacePricing {
  return {
    isPaid: row.is_paid,
    startingRateUsd: row.starting_rate_usd,
    rateTiers: row.rate_tiers,
  };
}

function buildBlockfaceResult(
  row: NearbyBlockfaceRow,
  statsRow: OccupancyStatsRow | undefined,
  daysInFuture: number,
  calibrations: readonly AreaCalibration[],
): BlockfaceHasDataResult | BlockfaceNoDataResult {
  const base = {
    type: "blockface" as const,
    id: row.id,
    name: buildBlockfaceName(row),
    geometry: row.location_geojson,
    distanceMeters: row.distance_meters,
    pricing: buildBlockfacePricing(row),
  };

  if (statsRow === undefined) {
    return { ...base, hasData: false };
  }

  const score = calculateConfidenceScore(statsRow.sample_count, statsRow.std_dev, daysInFuture);
  const confidencePercentage = scoreToPercentage(score);
  const rawOccupancyPercentage = occupancyToPercentage(statsRow.mean_occupancy);
  // Identity when no calibration matches this blockface's area/subarea (or
  // no area/subarea at all) -- see applyAreaCorrection's own subarea ->
  // area -> none fallback hierarchy.
  const correctedOccupancyPercentage = applyAreaCorrection(rawOccupancyPercentage, calibrations, row.paidparkingarea, row.paidparkingsubarea);

  return {
    ...base,
    hasData: true,
    confidence: {
      score,
      percentage: confidencePercentage,
      color: percentageToColor(confidencePercentage),
      meanOccupancy: statsRow.mean_occupancy,
    },
    occupancyPercent: correctedOccupancyPercentage,
    occupancyColor: calculateOccupancyColor(correctedOccupancyPercentage),
  };
}

function buildFacilityResult(row: NearbyOffStreetFacilityRow): OffStreetFacilityResult {
  return {
    type: "off_street_facility",
    id: row.id,
    name: row.name,
    geometry: row.location_geojson,
    distanceMeters: row.distance_meters,
    pricing: { rateTiers: row.rate_tiers },
    hasData: false,
  };
}

// --- Sorting ---------------------------------------------------------------

// Rounds a 0-1 occupancy ratio to the nearest 10%, producing an integer
// 0-10 band used purely as a sort key (not exposed in the response --
// callers get the raw, unrounded meanOccupancy on confidence instead).
function occupancyBand(meanOccupancy: number): number {
  return Math.round(meanOccupancy * 10);
}

// hasData blockfaces first: grouped by occupancy band ascending (emptiest
// blocks first -- the whole point of a parking-availability app), and
// within a band, descending by confidence (the most trustworthy prediction
// for a given occupancy level first). hasData:false blockfaces come after,
// by distance.
//
// Off-street facilities are deliberately NOT part of this list (or its
// distance-sort tail) any more -- they used to share a combined "no-data"
// bucket with hasData:false blockfaces, sorted by real combined distance,
// specifically so the two competed fairly for the same limited slots. That
// was the bug: in any area dense with metered blockfaces (most of downtown
// Seattle), hasData blockfaces alone could fill the entire shared cap
// before a single garage was ever considered, even one genuinely closer
// than every blockface shown -- live-confirmed 2026-09-17 (see CLAUDE.md),
// a real Diamond Parking location 69m away, correctly returned by
// nearby_off_street_facilities with no filtering bug anywhere, silently
// never appearing in a 69-blockface-dense area's results. Facilities now
// get their own independent list and cap (see sortFacilityResults/
// assembleSearchResults below) -- this function only ever sorts blockfaces.
function sortBlockfaceResults(results: (BlockfaceHasDataResult | BlockfaceNoDataResult)[]): (BlockfaceHasDataResult | BlockfaceNoDataResult)[] {
  const withData = results.filter((r): r is BlockfaceHasDataResult => r.hasData);
  const withoutData = results.filter((r): r is BlockfaceNoDataResult => !r.hasData);

  withData.sort((a, b) => {
    const bandDiff = occupancyBand(a.confidence.meanOccupancy) - occupancyBand(b.confidence.meanOccupancy);
    if (bandDiff !== 0) {
      return bandDiff;
    }
    return b.confidence.percentage - a.confidence.percentage;
  });

  withoutData.sort((a, b) => a.distanceMeters - b.distanceMeters);

  return [...withData, ...withoutData];
}

// Off-street facilities: nearest first. Unchanged from before the split --
// this category never had a "hasData" concept to group by, and doesn't
// need one; the only thing that changed is that it's no longer merged into
// the same sorted/capped list as blockfaces.
function sortFacilityResults(results: OffStreetFacilityResult[]): OffStreetFacilityResult[] {
  return [...results].sort((a, b) => a.distanceMeters - b.distanceMeters);
}

// --- Capping -----------------------------------------------------------

const DEFAULT_RESULT_LIMIT = 20;

// limit is a value from the app's own UI controls (a page-size/"show more"
// affordance), not free user input -- same reject-don't-clamp reasoning
// already used for nearby_blockfaces/nearby_off_street_facilities' own
// radius_meters: an invalid value here signals a real bug in the caller,
// not imprecise-but-real intent, so this throws rather than silently
// coercing it into range. limitName is threaded through purely so a
// thrown message says which of the two independent limits (blockfaceLimit
// vs facilityLimit) was the malformed one.
function applyLimit<T>(results: T[], limit: number | "all" | undefined, limitName: string): T[] {
  if (limit === "all") {
    return results;
  }
  const effectiveLimit = limit ?? DEFAULT_RESULT_LIMIT;
  if (!Number.isInteger(effectiveLimit) || effectiveLimit <= 0) {
    throw new RangeError(`assembleSearchResults: ${limitName} must be a positive integer or "all", got ${JSON.stringify(limit)}`);
  }
  return results.slice(0, effectiveLimit);
}

// --- Main entry point --------------------------------------------------

export interface AssembleSearchResultsOptions {
  blockfaceCandidates: NearbyBlockfaceRow[];
  facilityCandidates: NearbyOffStreetFacilityRow[];
  isoDay: number;
  hour: number;
  daysInFuture: number;
  // Each independently defaults to 20 and independently accepts "all" --
  // street blocks and off-street facilities no longer share one combined
  // cap (see sortBlockfaceResults' own comment for the real bug this
  // fixes), so a dense area's blockfaces can never crowd every garage out
  // of the response, and "show all" for one category doesn't force
  // uncapping the other.
  blockfaceLimit?: number | "all";
  facilityLimit?: number | "all";
}

export interface AssembledSearchResults {
  blockfaceResults: (BlockfaceHasDataResult | BlockfaceNoDataResult)[];
  facilityResults: OffStreetFacilityResult[];
}

// Two independent DI clients, not one combined interface (same reasoning
// as elsewhere in this project -- each declares its own from()/select()
// shape). Bundled into one object (rather than two positional params)
// since both are genuinely required on every call, unlike e.g. options'
// optional fields.
export interface AssembleSearchResultsClients {
  occupancyStatsClient: OccupancyStatsSupabaseClient;
  areaCorrectionsClient: AreaCorrectionsSupabaseClient;
}

// Turns the raw results of nearby_blockfaces/nearby_off_street_facilities
// into the Edge Function's final response shape: two independently sorted
// and independently capped lists, never merged into one. isoDay/hour/
// daysInFuture are expected to already be validated (they come from
// resolveRequestTime.ts's output) -- not re-validated here.
export async function assembleSearchResults(
  clients: AssembleSearchResultsClients,
  options: AssembleSearchResultsOptions,
): Promise<AssembledSearchResults> {
  const [statsByBlockfaceId, calibrations] = await Promise.all([
    fetchOccupancyStatsForCandidates(
      clients.occupancyStatsClient,
      options.blockfaceCandidates.map((row) => row.id),
      options.isoDay,
      options.hour,
    ),
    fetchAreaCalibrations(clients.areaCorrectionsClient),
  ]);

  const blockfaceResults = options.blockfaceCandidates.map((row) =>
    buildBlockfaceResult(row, statsByBlockfaceId.get(row.id), options.daysInFuture, calibrations),
  );
  const facilityResults = options.facilityCandidates.map(buildFacilityResult);

  return {
    blockfaceResults: applyLimit(sortBlockfaceResults(blockfaceResults), options.blockfaceLimit, "blockfaceLimit"),
    facilityResults: applyLimit(sortFacilityResults(facilityResults), options.facilityLimit, "facilityLimit"),
  };
}
