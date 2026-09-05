import { reverseGeocodeCoordinates, type ReverseGeocodeCacheSupabaseClient } from "../geocoding/reverseGeocodeCoordinates.ts";
import { LocationIQRequestError } from "../geocoding/geocodeAddress.ts";
import {
  REVERSE_GEOCODE_HTTP_STATUS,
  type ReverseGeocodeInvalidRequestReason,
  type ReverseGeocodeResponse,
} from "../edge-function-types/reverseGeocodeContract.ts";

export interface HandleReverseGeocodeRequestDeps {
  reverseGeocodeCacheClient: ReverseGeocodeCacheSupabaseClient;
  locationIqApiKey: string;
}

export interface HandleReverseGeocodeResult {
  response: ReverseGeocodeResponse;
  status: number;
}

// --- Request validation ----------------------------------------------------

function invalidRequest(reason: ReverseGeocodeInvalidRequestReason, message: string): HandleReverseGeocodeResult {
  return { response: { status: "invalid_request", reason, message }, status: REVERSE_GEOCODE_HTTP_STATUS.invalid_request };
}

// Reject (don't clamp) both non-finite and merely out-of-real-world-range
// values -- same reasoning as parkingSearchContract.ts's coordinates
// variant (see that file's own comment): a map widget cannot structurally
// produce an out-of-range value from a real drag, so one signals a bug,
// not imprecise intent, and there's no meaningful "nearest valid"
// coordinate to clamp toward.
//
// This check is inline here for now, not yet a shared helper -- Piece 2
// (the parking-search searchCenter contract change) will need the
// identical check in handleParkingSearchRequest.ts too, at which point
// it's worth extracting into its own validateCoordinates.ts module rather
// than duplicating it a second time. One caller doesn't yet justify that
// abstraction.
function validateCoordinates(lat: unknown, lon: unknown): string | null {
  if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    return '"lat" must be a finite number between -90 and 90.';
  }
  if (typeof lon !== "number" || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    return '"lon" must be a finite number between -180 and 180.';
  }
  return null;
}

interface ValidatedRequest {
  lat: number;
  lon: number;
}

function parseAndValidateRequest(rawBody: string): ValidatedRequest | HandleReverseGeocodeResult {
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

  const validationError = validateCoordinates(body.lat, body.lon);
  if (validationError !== null) {
    return invalidRequest("invalid_coordinates", validationError);
  }

  return { lat: body.lat as number, lon: body.lon as number };
}

// --- Error classification --------------------------------------------------

function internalError(message = "Something went wrong on our end. Please try again."): HandleReverseGeocodeResult {
  return { response: { status: "internal_error", message }, status: REVERSE_GEOCODE_HTTP_STATUS.internal_error };
}

function geocodingServiceUnavailable(
  message = "The geocoding service is temporarily unavailable. Please try again shortly.",
): HandleReverseGeocodeResult {
  return { response: { status: "geocoding_service_unavailable", message }, status: REVERSE_GEOCODE_HTTP_STATUS.geocoding_service_unavailable };
}

// Same classification logic as handleParkingSearchRequest.ts's
// classifyGeocodeError, applied to reverseGeocodeCoordinates' own,
// equally-narrow throw surface.
function classifyGeocodeError(err: unknown): HandleReverseGeocodeResult {
  if (err instanceof LocationIQRequestError) {
    return geocodingServiceUnavailable();
  }
  if (err instanceof RangeError) {
    // Within this call's scope, reverseGeocodeCoordinates throws a
    // RangeError only for a non-numeric coordinate in an otherwise-
    // successful LocationIQ response -- their data, not our infrastructure.
    return geocodingServiceUnavailable();
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("unexpected LocationIQ response shape")) {
    return geocodingServiceUnavailable();
  }
  // Cache read/write failures and anything else unanticipated: our own
  // infrastructure, not LocationIQ's.
  return internalError();
}

// --- Main entry point --------------------------------------------------

// Pure(ish) orchestration, no Request/Response/Deno.serve coupling -- same
// shape as handleParkingSearchRequest.ts. supabase/functions/reverse-
// geocode/index.ts is the thin wrapper that actually touches
// Request/Response/CORS.
export async function handleReverseGeocodeRequest(
  deps: HandleReverseGeocodeRequestDeps,
  rawBody: string,
  now: Date,
): Promise<HandleReverseGeocodeResult> {
  const validated = parseAndValidateRequest(rawBody);
  if ("response" in validated) {
    return validated;
  }
  const { lat, lon } = validated;

  let result;
  try {
    result = await reverseGeocodeCoordinates(deps.reverseGeocodeCacheClient, deps.locationIqApiKey, lat, lon, now);
  } catch (err) {
    console.error("handleReverseGeocodeRequest: reverseGeocodeCoordinates failed:", err);
    return classifyGeocodeError(err);
  }

  if (!result.matched) {
    return {
      response: {
        status: "no_match",
        message: `We couldn't find an address for (${lat}, ${lon}).`,
      },
      status: REVERSE_GEOCODE_HTTP_STATUS.no_match,
    };
  }

  return {
    response: {
      status: "ok",
      resolvedAddress: { displayName: result.displayName, lat: result.lat, lon: result.lon },
    },
    status: REVERSE_GEOCODE_HTTP_STATUS.ok,
  };
}
