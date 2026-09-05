import { resolveRequestTime, type PredictionTimeRequest, type QuickTimeOption } from "../scoring/resolveRequestTime.ts";
import { geocodeAddress, LocationIQRequestError, type GeocodeCacheSupabaseClient } from "../geocoding/geocodeAddress.ts";
import {
  assembleSearchResults,
  type NearbyBlockfaceRow,
  type NearbyOffStreetFacilityRow,
  type OccupancyStatsSupabaseClient,
} from "../scoring/assembleSearchResults.ts";
import { validateCoordinates } from "./validateCoordinates.ts";
import {
  PARKING_SEARCH_HTTP_STATUS,
  type InvalidRequestReason,
  type LocalAddressSuggestion,
  type ParkingSearchResponse,
  type SearchCenterWire,
} from "../edge-function-types/parkingSearchContract.ts";

// --- RPC client shape -----------------------------------------------------
//
// Neither nearby_blockfaces, nearby_off_street_facilities, nor
// search_local_addresses has a DI interface of its own yet (they're
// called directly here, the one place that needs to) -- narrow,
// table-name-generic pattern, same as every other client interface in
// this project.

export interface RpcQueryResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

// Raw row shape returned by search_local_addresses (migrations/019/020) --
// snake_case, matching the RPC's own column names, distinct from the
// camelCase LocalAddressSuggestion wire type it gets mapped to below.
export interface SearchLocalAddressesRow {
  kind: "blockface" | "off_street_facility";
  id: string;
  display_text: string;
  lat: number;
  lon: number;
  similarity: number;
}

export interface ParkingSearchRpcClient {
  rpc(
    fn: "nearby_blockfaces",
    args: { center_lon: number; center_lat: number; radius_meters: number },
  ): PromiseLike<RpcQueryResult<NearbyBlockfaceRow>>;
  rpc(
    fn: "nearby_off_street_facilities",
    args: { center_lon: number; center_lat: number; radius_meters: number },
  ): PromiseLike<RpcQueryResult<NearbyOffStreetFacilityRow>>;
  rpc(
    fn: "search_local_addresses",
    args: { query_text: string; match_limit: number },
  ): PromiseLike<RpcQueryResult<SearchLocalAddressesRow>>;
}

// Three independently-typed fields rather than one combined client
// interface: GeocodeCacheSupabaseClient and OccupancyStatsSupabaseClient
// each declare their own from()/select() shape, and trying to unify them
// under a single structural type is more trouble than it's worth. In
// practice the real Supabase client satisfies all three simultaneously --
// index.ts constructs it once and casts it three times, the same
// as-unknown-as pattern already used everywhere else in this project.
export interface HandleParkingSearchRequestDeps {
  geocodeCacheClient: GeocodeCacheSupabaseClient;
  occupancyStatsClient: OccupancyStatsSupabaseClient;
  rpcClient: ParkingSearchRpcClient;
  locationIqApiKey: string;
}

export interface HandleParkingSearchResult {
  response: ParkingSearchResponse;
  status: number;
}

// --- Request validation ----------------------------------------------------
//
// Everything checkable without calling anything that could throw
// internally happens here, before any of the four underlying pieces are
// touched -- per parkingSearchContract.ts's own design: nearby_blockfaces/
// nearby_off_street_facilities' RAISE EXCEPTION and resolveRequestTime's
// thrown RangeErrors are a defense-in-depth backstop, not this function's
// primary validation layer.

const DEFAULT_RADIUS_METERS = 200;
const MAX_RADIUS_METERS = 1000;

const QUICK_TIME_OPTIONS: readonly QuickTimeOption[] = ["right_now", "in_10_minutes", "in_30_minutes", "in_1_hour"];

function isQuickTimeOption(value: unknown): value is QuickTimeOption {
  return typeof value === "string" && (QUICK_TIME_OPTIONS as readonly string[]).includes(value);
}

// Converts the wire-level time field (parkingSearchContract.ts's
// PredictionTimeRequestWire -- an ISO string for "specific", since Date
// isn't JSON-serializable) into resolveRequestTime's in-memory
// PredictionTimeRequest. Returns null for anything structurally invalid;
// the caller maps that to malformed_body.
function parseTimeWire(rawTime: unknown): PredictionTimeRequest | null {
  if (typeof rawTime !== "object" || rawTime === null) {
    return null;
  }
  const time = rawTime as Record<string, unknown>;

  if (time.type === "quick") {
    return isQuickTimeOption(time.option) ? { type: "quick", option: time.option } : null;
  }

  if (time.type === "specific") {
    if (typeof time.instant !== "string") {
      return null;
    }
    const instant = new Date(time.instant);
    // A malformed instant string is a request-shape problem (malformed_body),
    // not a "resolves to the past"/"too far future" problem -- both of
    // those require a VALID Date to even evaluate. Caught here, before
    // resolveRequestTime ever sees it, rather than relying on its own
    // NaN-Date guard (a backstop for direct/test callers, not this
    // request's first line of defense -- see parkingSearchContract.ts).
    if (Number.isNaN(instant.getTime())) {
      return null;
    }
    return { type: "specific", instant };
  }

  return null;
}

interface ValidatedRequest {
  searchCenter: SearchCenterWire;
  time: PredictionTimeRequest;
  radiusMeters: number;
  limit: number | "all" | undefined;
}

function invalidRequest(reason: InvalidRequestReason, message: string): HandleParkingSearchResult {
  return { response: { status: "invalid_request", reason, message }, status: PARKING_SEARCH_HTTP_STATUS.invalid_request };
}

// Validates the searchCenter discriminated union. An unrecognized/missing
// `type`, or a malformed `address`-variant `query`, is malformed_body; a
// coordinates-variant lat/lon outside real-world range or non-finite is
// its own, more specific invalid_coordinates reason (see
// validateCoordinates.ts) -- mirrors the same distinction
// resolveRequestTime's day-bound errors already get (time_too_far_in_future
// vs invalid_time_request) rather than folding everything into one
// generic reason.
function parseSearchCenter(rawSearchCenter: unknown): SearchCenterWire | HandleParkingSearchResult {
  if (typeof rawSearchCenter !== "object" || rawSearchCenter === null) {
    return invalidRequest("malformed_body", '"searchCenter" must be an object.');
  }
  const center = rawSearchCenter as Record<string, unknown>;

  if (center.type === "address") {
    if (typeof center.query !== "string" || center.query.trim() === "") {
      return invalidRequest("malformed_body", '"searchCenter.query" must be a non-empty string.');
    }
    return { type: "address", query: center.query };
  }

  if (center.type === "coordinates") {
    const validationError = validateCoordinates(center.lat, center.lon);
    if (validationError !== null) {
      return invalidRequest("invalid_coordinates", validationError);
    }
    if (center.label !== undefined && typeof center.label !== "string") {
      return invalidRequest("malformed_body", '"searchCenter.label" must be a string, if provided.');
    }
    return { type: "coordinates", lat: center.lat as number, lon: center.lon as number, label: center.label as string | undefined };
  }

  return invalidRequest(
    "malformed_body",
    '"searchCenter" must be { type: "address", query: <non-empty string> } or { type: "coordinates", lat: <number>, lon: <number>, label?: <string> }.',
  );
}

function parseAndValidateRequest(rawBody: string): ValidatedRequest | HandleParkingSearchResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return invalidRequest("malformed_body", "Request body must be valid JSON.");
  }

  if (typeof parsed !== "object" || parsed === null) {
    return invalidRequest("malformed_body", "Request body must be a JSON object.");
  }
  const body = parsed as Record<string, unknown>;

  const searchCenter = parseSearchCenter(body.searchCenter);
  if ("response" in searchCenter) {
    return searchCenter;
  }

  const time = parseTimeWire(body.time);
  if (time === null) {
    return invalidRequest(
      "malformed_body",
      '"time" must be { type: "quick", option: <one of right_now/in_10_minutes/in_30_minutes/in_1_hour> } or { type: "specific", instant: <ISO 8601 string> }.',
    );
  }

  let radiusMeters = DEFAULT_RADIUS_METERS;
  if (body.radiusMeters !== undefined) {
    if (typeof body.radiusMeters !== "number" || !Number.isFinite(body.radiusMeters) || body.radiusMeters <= 0 || body.radiusMeters > MAX_RADIUS_METERS) {
      return invalidRequest("invalid_radius", `"radiusMeters" must be greater than 0 and at most ${MAX_RADIUS_METERS}.`);
    }
    radiusMeters = body.radiusMeters;
  }

  let limit: number | "all" | undefined;
  if (body.limit !== undefined) {
    if (body.limit === "all") {
      limit = "all";
    } else if (typeof body.limit === "number" && Number.isInteger(body.limit) && body.limit > 0) {
      limit = body.limit;
    } else {
      return invalidRequest("invalid_limit", '"limit" must be a positive integer or "all".');
    }
  }

  return { searchCenter, time, radiusMeters, limit };
}

// --- Error classification --------------------------------------------------

function internalError(message = "Something went wrong on our end. Please try again."): HandleParkingSearchResult {
  return { response: { status: "internal_error", message }, status: PARKING_SEARCH_HTTP_STATUS.internal_error };
}

function geocodingServiceUnavailable(
  message = "The geocoding service is temporarily unavailable. Please try again shortly.",
): HandleParkingSearchResult {
  return { response: { status: "geocoding_service_unavailable", message }, status: PARKING_SEARCH_HTTP_STATUS.geocoding_service_unavailable };
}

// Only the two day-bound RangeErrors are mapped to a specific
// invalid_request reason -- both are stable, self-owned message strings
// (this same codebase's resolveRequestTime.ts). Anything else reaching
// here means a structurally-valid time request (already pre-validated
// above) somehow still failed in a way this function didn't anticipate --
// safer to call that our own bug (internal_error) than to guess at a
// client-facing reason for it.
function classifyResolveRequestTimeError(err: unknown): HandleParkingSearchResult {
  if (err instanceof RangeError) {
    if (err.message.includes("exceeding the")) {
      return invalidRequest("time_too_far_in_future", "The requested time is more than 7 days in the future. Please choose a closer time.");
    }
    if (err.message.includes("days in the past")) {
      return invalidRequest("invalid_time_request", "The requested time has already passed. Please choose a future time.");
    }
  }
  console.error("handleParkingSearchRequest: unrecognized resolveRequestTime failure:", err);
  return internalError();
}

// geocodeAddress's own throw surface (see that module) is narrow enough to
// classify safely without needing message-matching against anything not
// owned by this codebase, except one deliberately-scoped case (see below).
function classifyGeocodeError(err: unknown): HandleParkingSearchResult {
  if (err instanceof LocationIQRequestError) {
    return geocodingServiceUnavailable();
  }
  if (err instanceof RangeError) {
    // Within THIS call's scope, geocodeAddress throws a RangeError only
    // for a non-numeric coordinate in an otherwise-successful LocationIQ
    // response -- their data, not our infrastructure.
    return geocodingServiceUnavailable();
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("unexpected LocationIQ response shape")) {
    return geocodingServiceUnavailable();
  }
  // Cache read/write failures (a real Supabase-side error) and anything
  // else unanticipated: our own infrastructure, not LocationIQ's.
  return internalError();
}

// --- "Did you mean" fallback (Piece 4) --------------------------------

// Only ever the top few -- this is a "did you mean X, Y, Z" fallback, not
// a second search results list. Independent of assembleSearchResults.ts's
// own DEFAULT_RESULT_LIMIT (20), which caps genuine search results, not
// suggestions for a failed one.
const SUGGESTION_MATCH_LIMIT = 5;

function toLocalAddressSuggestion(row: SearchLocalAddressesRow): LocalAddressSuggestion {
  return { kind: row.kind, id: row.id, displayText: row.display_text, lat: row.lat, lon: row.lon };
}

// Reuses search_local_addresses -- the same fuzzy-match function backing
// live-typing autocomplete -- rather than a second, separate suggestion
// mechanism. Called only here, sequentially AFTER geocoding has already
// failed, not concurrently with geocodeAddress: running both in parallel
// would add a database query to every SUCCESSFUL address search (the
// common case) just to cover this uncommon failure case, in exchange for
// latency savings that only matter on the already-uncommon failure path.
async function buildAddressNotFoundResponse(rpcClient: ParkingSearchRpcClient, query: string): Promise<HandleParkingSearchResult> {
  const normalizedQuery = query.trim().replace(/\s+/g, " ").toLowerCase();

  const suggestionsResult = await rpcClient.rpc("search_local_addresses", { query_text: query, match_limit: SUGGESTION_MATCH_LIMIT });
  // A suggestions-lookup failure degrades to an empty list, not
  // internal_error -- the address genuinely wasn't found either way;
  // suggestions are an enrichment on top of that outcome, not the primary
  // one, so a secondary lookup failing shouldn't turn an honest
  // "not found" into a 500.
  if (suggestionsResult.error !== null) {
    console.error("handleParkingSearchRequest: search_local_addresses (did-you-mean) failed:", suggestionsResult.error.message);
  }
  const suggestions = suggestionsResult.error !== null ? [] : (suggestionsResult.data ?? []).map(toLocalAddressSuggestion);

  return {
    response: {
      status: "address_not_found",
      query: normalizedQuery,
      message: `We couldn't find a location matching "${query}". Try a more specific address.`,
      suggestions,
    },
    status: PARKING_SEARCH_HTTP_STATUS.address_not_found,
  };
}

// --- Main entry point --------------------------------------------------

// Pure(ish) orchestration: no direct Request/Response/Deno.serve coupling,
// so this is fully testable the same way as every other piece in this
// project -- DI'd Supabase-shaped clients, an explicit `now`, a plain
// string body in, a plain {response, status} out. supabase/functions/
// parking-search/index.ts is the thin wrapper that actually touches
// Request/Response/CORS.
export async function handleParkingSearchRequest(
  deps: HandleParkingSearchRequestDeps,
  rawBody: string,
  now: Date,
): Promise<HandleParkingSearchResult> {
  const validated = parseAndValidateRequest(rawBody);
  if ("response" in validated) {
    return validated;
  }
  const { searchCenter, time, radiusMeters, limit } = validated;

  let resolvedTime;
  try {
    resolvedTime = resolveRequestTime(time, now);
  } catch (err) {
    return classifyResolveRequestTimeError(err);
  }

  // Resolves searchCenter into a real center point + a ResolvedSearchCenter
  // to echo back, via one of two entirely separate paths: "coordinates"
  // skips geocodeAddress (and therefore LocationIQ and geocode_cache)
  // entirely, while "address" behaves exactly as before Piece 2.
  let centerLat: number;
  let centerLon: number;
  let resolvedCenter: { displayName: string; lat: number; lon: number; source: "geocoded" | "coordinates" };

  if (searchCenter.type === "coordinates") {
    centerLat = searchCenter.lat;
    centerLon = searchCenter.lon;
    resolvedCenter = {
      // Never guesses an address for a bare coordinate pair -- if the
      // frontend didn't supply a label (e.g. from a clicked local
      // suggestion, or an earlier reverse-geocode call), this falls back
      // to an honest, plain description of the point itself.
      displayName: searchCenter.label ?? `Custom location (${searchCenter.lat.toFixed(5)}, ${searchCenter.lon.toFixed(5)})`,
      lat: searchCenter.lat,
      lon: searchCenter.lon,
      source: "coordinates",
    };
  } else {
    let geocodeResult;
    try {
      geocodeResult = await geocodeAddress(deps.geocodeCacheClient, deps.locationIqApiKey, searchCenter.query, now);
    } catch (err) {
      console.error("handleParkingSearchRequest: geocodeAddress failed:", err);
      return classifyGeocodeError(err);
    }

    if (!geocodeResult.matched) {
      return buildAddressNotFoundResponse(deps.rpcClient, searchCenter.query);
    }

    centerLat = geocodeResult.lat;
    centerLon = geocodeResult.lon;
    resolvedCenter = { displayName: geocodeResult.displayName, lat: geocodeResult.lat, lon: geocodeResult.lon, source: "geocoded" };
  }

  try {
    const [blockfacesResult, facilitiesResult] = await Promise.all([
      deps.rpcClient.rpc("nearby_blockfaces", { center_lon: centerLon, center_lat: centerLat, radius_meters: radiusMeters }),
      deps.rpcClient.rpc("nearby_off_street_facilities", {
        center_lon: centerLon,
        center_lat: centerLat,
        radius_meters: radiusMeters,
      }),
    ]);

    // Reached only after our own radius pre-validation already passed, so
    // an error here (the RPCs' own RAISE EXCEPTION included) is genuinely
    // unexpected -- our fault, not the caller's.
    if (blockfacesResult.error !== null) {
      console.error("handleParkingSearchRequest: nearby_blockfaces failed:", blockfacesResult.error.message);
      return internalError();
    }
    if (facilitiesResult.error !== null) {
      console.error("handleParkingSearchRequest: nearby_off_street_facilities failed:", facilitiesResult.error.message);
      return internalError();
    }

    const blockfaceCandidates = blockfacesResult.data ?? [];
    const facilityCandidates = facilitiesResult.data ?? [];

    const results = await assembleSearchResults(deps.occupancyStatsClient, {
      blockfaceCandidates,
      facilityCandidates,
      isoDay: resolvedTime.isoDay,
      hour: resolvedTime.hour,
      daysInFuture: resolvedTime.daysInFuture,
      limit,
    });

    return {
      response: {
        status: "ok",
        resolvedTime,
        resolvedCenter,
        results,
        totalCandidateCount: blockfaceCandidates.length + facilityCandidates.length,
      },
      status: PARKING_SEARCH_HTTP_STATUS.ok,
    };
  } catch (err) {
    console.error("handleParkingSearchRequest: unexpected failure assembling results:", err);
    return internalError();
  }
}
