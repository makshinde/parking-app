import type { SupabaseQueryResult } from "../importers/upsertBlockface.ts";

// --- geocode_cache client shape --------------------------------------------
//
// Minimal, table-name-generic client shape, same DI pattern as
// blockfaceLookup.ts/streamArchiveWithResume.ts -- lets this module (and
// its tests) run against any client exposing this structural shape, the
// real @supabase/supabase-js client included, without depending on it
// directly.

interface GeocodeCacheRow {
  query_text: string;
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

export interface GeocodeCacheQueryBuilder extends PromiseLike<SupabaseQueryResult<GeocodeCacheRow[]>> {
  eq(column: string, value: string): GeocodeCacheQueryBuilder;
  maybeSingle(): PromiseLike<SupabaseQueryResult<GeocodeCacheRow>>;
}

export interface GeocodeCacheSupabaseTableBuilder {
  select(columns: string): GeocodeCacheQueryBuilder;
  upsert(values: Record<string, unknown>, options: { onConflict: string }): PromiseLike<SupabaseQueryResult>;
}

export interface GeocodeCacheSupabaseClient {
  from(table: string): GeocodeCacheSupabaseTableBuilder;
}

// --- Result shape ------------------------------------------------------

export interface MatchedGeocodeResult {
  matched: true;
  lat: number;
  lon: number;
  displayName: string;
  placeId: string;
  osmType: string | null;
  osmId: string | null;
  // The full, unmodified LocationIQ response object this result came from
  // (or was reconstructed from cache) -- see geocode_cache's own comment
  // (migrations/018) for why this is preserved rather than discarded.
  rawResponse: unknown;
}

export interface UnmatchedGeocodeResult {
  matched: false;
}

export type GeocodeAddressResult = MatchedGeocodeResult | UnmatchedGeocodeResult;

// --- Query normalization -------------------------------------------------

// Trivial formatting differences in what a caller passes in (extra
// whitespace, casing) shouldn't cost a second, redundant LocationIQ call
// for what is really the same query -- this is the actual cache key.
function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

// --- LocationIQ request/response -----------------------------------------

const LOCATIONIQ_SEARCH_URL = "https://us1.locationiq.com/v1/search";

// Seattle city limits with a generous margin, min_lon,min_lat,max_lon,max_lat.
// Live-verified (this project's own LocationIQ investigation) that viewbox
// alone -- without bounded=1 -- is only a soft ranking preference: a real,
// deliberately ambiguous test query ("100 Main Street") still returned a
// result ~30 miles outside this exact box when bounded wasn't set. bounded=1
// is what actually guarantees an in-area result, live-confirmed against the
// same query returning a genuine Seattle match once bounded=1 was added.
const SEATTLE_VIEWBOX = "-122.46,47.49,-122.22,47.73";

function buildSearchUrl(normalizedQuery: string, apiKey: string): string {
  const url = new URL(LOCATIONIQ_SEARCH_URL);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("q", normalizedQuery);
  url.searchParams.set("format", "json");
  // Address breakdown isn't currently promoted to its own column, but
  // rawResponse preserves whatever LocationIQ returns -- requesting it now
  // avoids needing to bust the cache later just to backfill it.
  url.searchParams.set("addressdetails", "1");
  // Only the top/best-ranked match is ever used.
  url.searchParams.set("limit", "1");
  url.searchParams.set("viewbox", SEATTLE_VIEWBOX);
  url.searchParams.set("bounded", "1");
  return url.toString();
}

// Live-verified real shape of LocationIQ's own response fields actually
// used here; place_id/osm_id are strings (see this file's own type/PR
// history for the direct comparison against Nominatim's numeric
// equivalents that confirmed this).
interface LocationIQSearchResult {
  place_id: string;
  osm_type?: string;
  osm_id?: string;
  lat: string;
  lon: string;
  display_name: string;
  [key: string]: unknown;
}

class LocationIQRequestError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "LocationIQRequestError";
    this.retryable = retryable;
  }
}

// One initial attempt plus up to 3 retries, exponential backoff (1s, 2s,
// 4s) -- the exact same shape already proven in this project for both
// external-API fetches (fetchSocrataRecords.ts, streamArchiveWithResume.ts's
// archive-page fetch) and a database write (streamArchiveWithResume.ts's
// accumulator-snapshot retry). Reused here rather than reinvented.
export const MAX_FETCH_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 1000;

// New here, not present in the precedent above: a small amount of random
// jitter added on top of each exponential wait, so multiple requests that
// hit the per-second limit at the same moment don't all retry in lockstep
// and collide again. 250ms is deliberately small, not an arbitrary round
// number -- live-verified (this project's own rate-limit investigation)
// that firing requests back-to-back got a 429 on request 3 and a clean
// 200 on request 4 immediately after, with only normal per-request
// overhead in between -- meaning LocationIQ's real per-second window
// resets in well under 250ms in practice. That's enough headroom to
// de-synchronize concurrent retries without adding perceptible extra
// latency on top of the already-short base waits.
const RETRY_JITTER_MAX_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 429 (rate limited) and 5xx (transient server error) are the only
// retryable statuses -- live-confirmed 429 really happens under rapid
// sequential requests against the real API (see this project's own
// rate-limit investigation).
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

// Live-confirmed real shape of LocationIQ's "no results" response: HTTP
// 404, body {"error":"Unable to geocode"}. This is a genuine, valid
// outcome, not a bug -- it must never be retried or thrown, just returned
// as a clean "no match."
function isNoMatchBody(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as Record<string, unknown>).error === "Unable to geocode";
}

// Returns the raw LocationIQ search results, or null for a confirmed
// no-match. Throws LocationIQRequestError (retryable or not) for every
// other non-2xx response, and lets a fetch()/json() failure propagate
// as whatever it naturally is -- same "unrecognized failure defaults to
// retryable" reasoning fetchSocrataRecords.ts's fetchPageOnce uses, not
// duplicated here via string-matching a specific runtime's error wording
// (which could differ between Node and Deno).
async function fetchGeocodeOnce(url: string): Promise<LocationIQSearchResult[] | null> {
  const response = await fetch(url);

  if (!response.ok) {
    if (response.status === 404) {
      const body: unknown = await response.json().catch(() => null);
      if (isNoMatchBody(body)) {
        return null;
      }
    }
    throw new LocationIQRequestError(
      `geocodeAddress: LocationIQ request failed with status ${response.status} ${response.statusText}`,
      isRetryableStatus(response.status),
    );
  }

  const body: unknown = await response.json();
  if (!Array.isArray(body)) {
    throw new Error(`geocodeAddress: unexpected LocationIQ response shape (expected a JSON array), got ${JSON.stringify(body)}`);
  }
  return body as LocationIQSearchResult[];
}

async function fetchGeocodeWithRetry(url: string): Promise<LocationIQSearchResult[] | null> {
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      return await fetchGeocodeOnce(url);
    } catch (err) {
      // Same defaulting rule as fetchSocrataRecords.ts's fetchPage: only a
      // LocationIQRequestError explicitly marked non-retryable stops the
      // loop early; everything else (a genuine network failure, a
      // malformed-body error, or any other unanticipated exception) is
      // treated as more likely transient than a bug, and gets retried.
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
        `geocodeAddress: attempt ${attempt}/${MAX_FETCH_ATTEMPTS} failed (${reason}); retrying in ${delayMs.toFixed(0)}ms`,
      );
      await sleep(delayMs);
    }
  }

  // Unreachable: the loop above always either returns, or throws on its
  // final iteration.
  throw new Error("geocodeAddress: unreachable -- fetchGeocodeWithRetry exhausted retries without a resolved result");
}

function parseCoordinate(value: string, label: "lat" | "lon"): number {
  const parsed = Number(value);
  // Structurally invalid (not a real number at all), not merely
  // out-of-range -- same discrete/structural-invalidity-throws reasoning
  // reprojectCoordinates.ts's RangeError uses (see CLAUDE.md's Handling
  // invalid input section): there is no meaningful "nearest valid" value
  // to clamp a non-numeric coordinate toward.
  if (!Number.isFinite(parsed)) {
    throw new RangeError(`geocodeAddress: LocationIQ returned a non-numeric ${label} ("${value}")`);
  }
  return parsed;
}

function buildMatchedResult(searchResult: LocationIQSearchResult): MatchedGeocodeResult {
  return {
    matched: true,
    lat: parseCoordinate(searchResult.lat, "lat"),
    lon: parseCoordinate(searchResult.lon, "lon"),
    displayName: searchResult.display_name,
    placeId: searchResult.place_id,
    osmType: searchResult.osm_type ?? null,
    osmId: searchResult.osm_id ?? null,
    rawResponse: searchResult,
  };
}

// --- Cache read/write ------------------------------------------------------

const CACHE_FRESHNESS_MS = 48 * 60 * 60 * 1000; // 48 hours -- see migrations/018's own comment for the ToS reasoning

async function fetchCachedGeocode(
  client: GeocodeCacheSupabaseClient,
  normalizedQuery: string,
): Promise<GeocodeCacheRow | null> {
  const { data, error } = await client
    .from("geocode_cache")
    .select("query_text, matched, lat, lon, display_name, place_id, osm_type, osm_id, raw_response, updated_at")
    .eq("query_text", normalizedQuery)
    .maybeSingle();

  if (error !== null) {
    throw new Error(`geocodeAddress: reading geocode_cache for "${normalizedQuery}" failed: ${error.message}`);
  }
  return data;
}

function isFresh(row: GeocodeCacheRow, now: Date): boolean {
  return now.getTime() - new Date(row.updated_at).getTime() < CACHE_FRESHNESS_MS;
}

function rowToResult(row: GeocodeCacheRow): GeocodeAddressResult {
  if (!row.matched) {
    return { matched: false };
  }
  // The CHECK constraint on geocode_cache (migrations/018) guarantees
  // these are non-null whenever matched = true.
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

async function upsertCachedGeocode(
  client: GeocodeCacheSupabaseClient,
  normalizedQuery: string,
  result: GeocodeAddressResult,
  now: Date,
): Promise<void> {
  const row: Record<string, unknown> = result.matched
    ? {
        query_text: normalizedQuery,
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
        query_text: normalizedQuery,
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

  const { error } = await client.from("geocode_cache").upsert(row, { onConflict: "query_text" });
  if (error !== null) {
    throw new Error(`geocodeAddress: writing geocode_cache for "${normalizedQuery}" failed: ${error.message}`);
  }
}

// --- Main entry point --------------------------------------------------

// Resolves a free-form address query to coordinates via LocationIQ,
// cache-first. `now` is passed in explicitly, not read internally via
// `new Date()`, matching normalizeReading/resolveRequestTime's existing
// testability convention. `apiKey` is likewise a plain parameter, not read
// via `process.env`/`Deno.env.get()` internally -- keeps this function
// itself runtime-agnostic; the caller reads the key however is idiomatic
// to its own runtime (see this project's Deno-portability investigation
// for why relying on process.env inside a shared module was the wrong
// call).
export async function geocodeAddress(
  client: GeocodeCacheSupabaseClient,
  apiKey: string,
  query: string,
  now: Date,
): Promise<GeocodeAddressResult> {
  const normalizedQuery = normalizeQuery(query);

  const cached = await fetchCachedGeocode(client, normalizedQuery);
  if (cached !== null && isFresh(cached, now)) {
    return rowToResult(cached);
  }

  const url = buildSearchUrl(normalizedQuery, apiKey);
  const searchResults = await fetchGeocodeWithRetry(url);

  const result: GeocodeAddressResult =
    searchResults === null || searchResults.length === 0 ? { matched: false } : buildMatchedResult(searchResults[0] as LocationIQSearchResult);

  await upsertCachedGeocode(client, normalizedQuery, result, now);

  return result;
}
