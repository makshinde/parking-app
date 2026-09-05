import { LocationIQRequestError, MAX_FETCH_ATTEMPTS, type GeocodeAddressResult, type MatchedGeocodeResult } from "./geocodeAddress.ts";
import type { SupabaseQueryResult } from "../importers/upsertBlockface.ts";

// Reuses geocodeAddress.ts's GeocodeAddressResult/MatchedGeocodeResult/
// UnmatchedGeocodeResult and LocationIQRequestError directly (a caught
// LocationIQ HTTP failure is the same kind of failure regardless of
// forward/reverse), and its exported MAX_FETCH_ATTEMPTS -- but does NOT
// modify that already-deployed file. RETRY_BASE_DELAY_MS/
// RETRY_JITTER_MAX_MS aren't exported there, so they're mirrored below as
// identical private constants rather than justifying a change to a file
// already backing the live parking-search Edge Function.

// --- reverse_geocode_cache client shape -------------------------------
//
// Same table-name-generic DI pattern as geocodeAddress.ts's
// GeocodeCacheSupabaseClient -- a fresh, mirrored set of interfaces, not a
// literal reuse of that file's, since the row shape (coordinate_key vs
// query_text) differs.

interface ReverseGeocodeCacheRow {
  coordinate_key: string;
  matched: boolean;
  lat: number | null;
  lon: number | null;
  display_name: string | null;
  place_id: string | null;
  osm_type: string | null;
  osm_id: string | null;
  raw_response: unknown;
  updated_at: string;
}

export interface ReverseGeocodeCacheQueryBuilder extends PromiseLike<SupabaseQueryResult<ReverseGeocodeCacheRow[]>> {
  eq(column: string, value: string): ReverseGeocodeCacheQueryBuilder;
  maybeSingle(): PromiseLike<SupabaseQueryResult<ReverseGeocodeCacheRow>>;
}

export interface ReverseGeocodeCacheSupabaseTableBuilder {
  select(columns: string): ReverseGeocodeCacheQueryBuilder;
  upsert(values: Record<string, unknown>, options: { onConflict: string }): PromiseLike<SupabaseQueryResult>;
}

export interface ReverseGeocodeCacheSupabaseClient {
  from(table: string): ReverseGeocodeCacheSupabaseTableBuilder;
}

// --- Coordinate rounding / cache key -------------------------------------

// 5 decimal places (~1.1m at this latitude) -- see migrations/021's own
// comment for the full reasoning. toFixed(5), not a bare numeric round,
// so the string format is stable (no trailing-zero or scientific-notation
// drift) and matches consistently on every lookup.
function roundCoordinate(value: number): string {
  return value.toFixed(5);
}

function buildCoordinateKey(lat: number, lon: number): string {
  return `${roundCoordinate(lat)},${roundCoordinate(lon)}`;
}

// --- LocationIQ request/response -----------------------------------------

const LOCATIONIQ_REVERSE_URL = "https://us1.locationiq.com/v1/reverse";

function buildReverseUrl(lat: number, lon: number, apiKey: string): string {
  const url = new URL(LOCATIONIQ_REVERSE_URL);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("format", "json");
  // Same reasoning as geocodeAddress.ts's forward-search request: not
  // currently promoted to its own column, but rawResponse preserves it,
  // avoiding a future cache-busting migration just to backfill it.
  url.searchParams.set("addressdetails", "1");
  return url.toString();
}

// Live-verified real shape of LocationIQ's reverse-geocoding response.
// Structurally different from forward search in one important way: this
// is a SINGLE JSON OBJECT, not an array of candidate matches -- reverse
// geocoding a specific point has no "which of several candidates" question
// the way an ambiguous text query does.
interface LocationIQReverseResult {
  place_id: string;
  osm_type?: string;
  osm_id?: string;
  lat: string;
  lon: string;
  display_name: string;
  [key: string]: unknown;
}

const RETRY_BASE_DELAY_MS = 1000;
const RETRY_JITTER_MAX_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

// Live-confirmed (this project's own reverse-geocoding investigation) that
// a genuine no-match uses the EXACT same shape as forward search: HTTP
// 404, body {"error":"Unable to geocode"} -- confirmed against a point in
// the open Pacific with no enclosing administrative area at all.
//
// Also live-confirmed, and worth noting for anyone surprised by it later:
// this genuine no-match is rare in practice for coordinates anywhere near
// a populated region. A real Puget Sound point and a real Lake Washington
// point -- both genuinely open water -- each returned an ordinary 200,
// falling back to a coarse enclosing city/county boundary (e.g. "Medina,
// King County, Washington, USA") rather than an error. This function
// doesn't second-guess that -- a coarse-but-real LocationIQ match is still
// matched: true, honestly relayed as whatever LocationIQ actually
// resolved, never invented or suppressed.
function isNoMatchBody(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as Record<string, unknown>).error === "Unable to geocode";
}

async function fetchReverseGeocodeOnce(url: string): Promise<LocationIQReverseResult | null> {
  const response = await fetch(url);

  if (!response.ok) {
    if (response.status === 404) {
      const body: unknown = await response.json().catch(() => null);
      if (isNoMatchBody(body)) {
        return null;
      }
    }
    throw new LocationIQRequestError(
      `reverseGeocodeCoordinates: LocationIQ request failed with status ${response.status} ${response.statusText}`,
      isRetryableStatus(response.status),
    );
  }

  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error(
      `reverseGeocodeCoordinates: unexpected LocationIQ response shape (expected a single JSON object), got ${JSON.stringify(body)}`,
    );
  }
  return body as LocationIQReverseResult;
}

async function fetchReverseGeocodeWithRetry(url: string): Promise<LocationIQReverseResult | null> {
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      return await fetchReverseGeocodeOnce(url);
    } catch (err) {
      const retryable = !(err instanceof LocationIQRequestError) || err.retryable;
      const isLastAttempt = attempt === MAX_FETCH_ATTEMPTS;
      if (!retryable || isLastAttempt) {
        throw err;
      }

      const baseDelayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      const jitterMs = Math.random() * RETRY_JITTER_MAX_MS;
      const delayMs = baseDelayMs + jitterMs;
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `reverseGeocodeCoordinates: attempt ${attempt}/${MAX_FETCH_ATTEMPTS} failed (${reason}); retrying in ${delayMs.toFixed(0)}ms`,
      );
      await sleep(delayMs);
    }
  }

  throw new Error("reverseGeocodeCoordinates: unreachable -- fetchReverseGeocodeWithRetry exhausted retries without a resolved result");
}

function parseCoordinate(value: string, label: "lat" | "lon"): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new RangeError(`reverseGeocodeCoordinates: LocationIQ returned a non-numeric ${label} ("${value}")`);
  }
  return parsed;
}

function buildMatchedResult(reverseResult: LocationIQReverseResult): MatchedGeocodeResult {
  return {
    matched: true,
    lat: parseCoordinate(reverseResult.lat, "lat"),
    lon: parseCoordinate(reverseResult.lon, "lon"),
    displayName: reverseResult.display_name,
    placeId: reverseResult.place_id,
    osmType: reverseResult.osm_type ?? null,
    osmId: reverseResult.osm_id ?? null,
    rawResponse: reverseResult,
  };
}

// --- Cache read/write ------------------------------------------------------

const CACHE_FRESHNESS_MS = 48 * 60 * 60 * 1000; // 48 hours -- see migrations/021's own comment for the ToS reasoning

async function fetchCachedReverseGeocode(
  client: ReverseGeocodeCacheSupabaseClient,
  coordinateKey: string,
): Promise<ReverseGeocodeCacheRow | null> {
  const { data, error } = await client
    .from("reverse_geocode_cache")
    .select("coordinate_key, matched, lat, lon, display_name, place_id, osm_type, osm_id, raw_response, updated_at")
    .eq("coordinate_key", coordinateKey)
    .maybeSingle();

  if (error !== null) {
    throw new Error(`reverseGeocodeCoordinates: reading reverse_geocode_cache for "${coordinateKey}" failed: ${error.message}`);
  }
  return data;
}

function isFresh(row: ReverseGeocodeCacheRow, now: Date): boolean {
  return now.getTime() - new Date(row.updated_at).getTime() < CACHE_FRESHNESS_MS;
}

function rowToResult(row: ReverseGeocodeCacheRow): GeocodeAddressResult {
  if (!row.matched) {
    return { matched: false };
  }
  // The CHECK constraint on reverse_geocode_cache (migrations/021)
  // guarantees these are non-null whenever matched = true.
  return {
    matched: true,
    lat: row.lat as number,
    lon: row.lon as number,
    displayName: row.display_name as string,
    placeId: row.place_id as string,
    osmType: row.osm_type,
    osmId: row.osm_id,
    rawResponse: row.raw_response,
  };
}

async function upsertCachedReverseGeocode(
  client: ReverseGeocodeCacheSupabaseClient,
  coordinateKey: string,
  result: GeocodeAddressResult,
  now: Date,
): Promise<void> {
  const row: Record<string, unknown> = result.matched
    ? {
        coordinate_key: coordinateKey,
        matched: true,
        lat: result.lat,
        lon: result.lon,
        display_name: result.displayName,
        place_id: result.placeId,
        osm_type: result.osmType,
        osm_id: result.osmId,
        raw_response: result.rawResponse,
        updated_at: now.toISOString(),
      }
    : {
        coordinate_key: coordinateKey,
        matched: false,
        lat: null,
        lon: null,
        display_name: null,
        place_id: null,
        osm_type: null,
        osm_id: null,
        raw_response: null,
        updated_at: now.toISOString(),
      };

  const { error } = await client.from("reverse_geocode_cache").upsert(row, { onConflict: "coordinate_key" });
  if (error !== null) {
    throw new Error(`reverseGeocodeCoordinates: writing reverse_geocode_cache for "${coordinateKey}" failed: ${error.message}`);
  }
}

// --- Main entry point --------------------------------------------------

// Resolves coordinates to a human-readable address via LocationIQ's
// reverse endpoint, cache-first -- same shape as geocodeAddress(), just
// keyed by rounded coordinates instead of normalized query text. `now`
// and `apiKey` are explicit parameters, not read internally, for the same
// testability/runtime-agnosticism reasons as geocodeAddress.ts.
export async function reverseGeocodeCoordinates(
  client: ReverseGeocodeCacheSupabaseClient,
  apiKey: string,
  lat: number,
  lon: number,
  now: Date,
): Promise<GeocodeAddressResult> {
  const coordinateKey = buildCoordinateKey(lat, lon);

  const cached = await fetchCachedReverseGeocode(client, coordinateKey);
  if (cached !== null && isFresh(cached, now)) {
    return rowToResult(cached);
  }

  const url = buildReverseUrl(lat, lon, apiKey);
  const reverseResult = await fetchReverseGeocodeWithRetry(url);

  const result: GeocodeAddressResult = reverseResult === null ? { matched: false } : buildMatchedResult(reverseResult);

  await upsertCachedReverseGeocode(client, coordinateKey, result, now);

  return result;
}
