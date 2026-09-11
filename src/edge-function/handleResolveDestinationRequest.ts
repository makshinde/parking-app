import { resolveDestinationCoordinates } from "../geocoding/resolveDestinationCoordinates.ts";
import { GoogleApiRequestError } from "../geocoding/autocompleteDestination.ts";
import {
  RESOLVE_DESTINATION_HTTP_STATUS,
  type ResolveDestinationInvalidRequestReason,
  type ResolveDestinationResponse,
} from "../edge-function-types/resolveDestinationContract.ts";

// No Supabase client at all -- same reasoning as
// HandleDestinationAutocompleteRequestDeps: resolveDestinationCoordinates
// is a deliberately stateless proxy with no cache table (see that
// module's own header comment for why).
export interface HandleResolveDestinationRequestDeps {
  googlePlacesApiKey: string;
}

export interface HandleResolveDestinationResult {
  response: ResolveDestinationResponse;
  status: number;
}

// --- Request validation ----------------------------------------------------

function invalidRequest(reason: ResolveDestinationInvalidRequestReason, message: string): HandleResolveDestinationResult {
  return { response: { status: "invalid_request", reason, message }, status: RESOLVE_DESTINATION_HTTP_STATUS.invalid_request };
}

interface ValidatedRequest {
  placeId: string;
}

function parseAndValidateRequest(rawBody: string): ValidatedRequest | HandleResolveDestinationResult {
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

  if (typeof body.placeId !== "string" || body.placeId.trim() === "") {
    return invalidRequest("malformed_body", '"placeId" must be a non-empty string.');
  }

  return { placeId: body.placeId };
}

// --- Error classification --------------------------------------------------

function internalError(message = "Something went wrong on our end. Please try again."): HandleResolveDestinationResult {
  return { response: { status: "internal_error", message }, status: RESOLVE_DESTINATION_HTTP_STATUS.internal_error };
}

function geocodingServiceUnavailable(
  message = "The place lookup service is temporarily unavailable. Please try again shortly.",
): HandleResolveDestinationResult {
  return { response: { status: "geocoding_service_unavailable", message }, status: RESOLVE_DESTINATION_HTTP_STATUS.geocoding_service_unavailable };
}

// resolveDestinationCoordinates' own throw surface (see that module) is
// narrow enough to classify safely without needing message-matching
// against anything not owned by this codebase, except one
// deliberately-scoped case (see below) -- same pattern as
// handleDestinationAutocompleteRequest.ts's own classifyAutocompleteError.
function classifyResolveError(err: unknown): HandleResolveDestinationResult {
  if (err instanceof GoogleApiRequestError) {
    if (err.message.includes("rejected the request as invalid")) {
      // Should be unreachable given this handler's own placeId validation
      // above -- if Google ever rejects a request we already validated as
      // fine, that signals a gap in OUR validation logic (or a
      // misconfigured API key -- see resolveDestinationCoordinates.ts's
      // own comment), not a genuine upstream failure.
      console.error(
        "handleResolveDestinationRequest: Google Geocoding rejected a request that passed our own validation:",
        err.message,
      );
      return internalError();
    }
    return geocodingServiceUnavailable();
  }
  if (err instanceof RangeError) {
    // Within this call's scope, resolveDestinationCoordinates throws a
    // RangeError only for a non-numeric coordinate in an otherwise-
    // successful Geocoding response -- their data, not our infrastructure.
    return geocodingServiceUnavailable();
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("unexpected Google Geocoding status") || message.includes("empty results array")) {
    return geocodingServiceUnavailable();
  }
  return internalError();
}

// --- Main entry point --------------------------------------------------

// Pure(ish) orchestration, no Request/Response/Deno.serve coupling -- same
// shape as handleReverseGeocodeRequest.ts/handleDestinationAutocompleteRequest.ts.
// supabase/functions/resolve-destination/index.ts is the thin wrapper that
// actually touches Request/Response/CORS. No `now` parameter -- unlike
// handleReverseGeocodeRequest.ts, there's no cache-freshness logic here to
// need one (see resolveDestinationCoordinates.ts's own header comment for
// why this endpoint is deliberately stateless).
export async function handleResolveDestinationRequest(
  deps: HandleResolveDestinationRequestDeps,
  rawBody: string,
): Promise<HandleResolveDestinationResult> {
  const validated = parseAndValidateRequest(rawBody);
  if ("response" in validated) {
    return validated;
  }
  const { placeId } = validated;

  let result;
  try {
    result = await resolveDestinationCoordinates(deps.googlePlacesApiKey, placeId);
  } catch (err) {
    console.error("handleResolveDestinationRequest: resolveDestinationCoordinates failed:", err);
    return classifyResolveError(err);
  }

  if (!result.matched) {
    return {
      response: {
        status: "no_match",
        message: `We couldn't resolve coordinates for that selection.`,
      },
      status: RESOLVE_DESTINATION_HTTP_STATUS.no_match,
    };
  }

  return {
    response: {
      status: "ok",
      resolvedAddress: { displayName: result.displayName, lat: result.lat, lon: result.lon },
    },
    status: RESOLVE_DESTINATION_HTTP_STATUS.ok,
  };
}
