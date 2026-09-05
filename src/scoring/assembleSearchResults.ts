import type { SupabaseQueryResult } from "../importers/upsertBlockface.ts";
import { calculateConfidenceScore } from "./confidenceScore.ts";

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
  meanOccupancy: number; // 0-1, the raw predicted occupancy ratio
}

export interface BlockfaceHasDataResult extends BaseCandidateResult {
  type: "blockface";
  hasData: true;
  confidence: BlockfaceConfidence;
  // Predicted occupancy, as its own primary, color-coded field -- distinct
  // from confidence.percentage/confidence.color, and NOT the same
  // percentage-to-color mapping: occupancyColor is inverted relative to
  // confidence.color (low occupancy is good/green, high is bad/red -- see
  // calculateOccupancyColor's own comment).
  occupancyPercent: number; // 0-100, confidence.meanOccupancy formatted as a percentage
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
  const occupancyPercentage = occupancyToPercentage(statsRow.mean_occupancy);

  return {
    ...base,
    hasData: true,
    confidence: {
      score,
      percentage: confidencePercentage,
      color: percentageToColor(confidencePercentage),
      meanOccupancy: statsRow.mean_occupancy,
    },
    occupancyPercent: occupancyPercentage,
    occupancyColor: calculateOccupancyColor(occupancyPercentage),
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

// hasData results first: grouped by occupancy band ascending (emptiest
// blocks first -- the whole point of a parking-availability app), and
// within a band, descending by confidence (the most trustworthy prediction
// for a given occupancy level first). hasData:false results come after all
// of those, in real combined distance order (nearest first) across BOTH
// candidate types together, not grouped by type -- a garage 50m away and a
// no-data blockface 200m away should sort by their actual distance to each
// other, not by which RPC they came from.
function sortResults(results: CandidateResult[]): CandidateResult[] {
  const withData = results.filter((r): r is BlockfaceHasDataResult => r.hasData);
  const withoutData = results.filter((r): r is BlockfaceNoDataResult | OffStreetFacilityResult => !r.hasData);

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

// --- Capping -----------------------------------------------------------

const DEFAULT_RESULT_LIMIT = 20;

// limit is a value from the app's own UI controls (a page-size/"show more"
// affordance), not free user input -- same reject-don't-clamp reasoning
// already used for nearby_blockfaces/nearby_off_street_facilities' own
// radius_meters: an invalid value here signals a real bug in the caller,
// not imprecise-but-real intent, so this throws rather than silently
// coercing it into range.
function applyLimit(results: CandidateResult[], limit: number | "all" | undefined): CandidateResult[] {
  if (limit === "all") {
    return results;
  }
  const effectiveLimit = limit ?? DEFAULT_RESULT_LIMIT;
  if (!Number.isInteger(effectiveLimit) || effectiveLimit <= 0) {
    throw new RangeError(`assembleSearchResults: limit must be a positive integer or "all", got ${JSON.stringify(limit)}`);
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
  // Omit for the default cap (20); pass "all" for the full, uncapped list.
  limit?: number | "all";
}

// Turns the raw results of nearby_blockfaces/nearby_off_street_facilities
// into the Edge Function's final, sorted, capped response list. isoDay/
// hour/daysInFuture are expected to already be validated (they come from
// resolveRequestTime.ts's output) -- not re-validated here.
export async function assembleSearchResults(
  client: OccupancyStatsSupabaseClient,
  options: AssembleSearchResultsOptions,
): Promise<CandidateResult[]> {
  const statsByBlockfaceId = await fetchOccupancyStatsForCandidates(
    client,
    options.blockfaceCandidates.map((row) => row.id),
    options.isoDay,
    options.hour,
  );

  const blockfaceResults = options.blockfaceCandidates.map((row) =>
    buildBlockfaceResult(row, statsByBlockfaceId.get(row.id), options.daysInFuture),
  );
  const facilityResults = options.facilityCandidates.map(buildFacilityResult);

  const sorted = sortResults([...blockfaceResults, ...facilityResults]);
  return applyLimit(sorted, options.limit);
}
