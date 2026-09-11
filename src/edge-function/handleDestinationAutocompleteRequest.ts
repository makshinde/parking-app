import { autocompleteDestination, GoogleApiRequestError, type DestinationSuggestion } from "../geocoding/autocompleteDestination.ts";
import {
  DESTINATION_AUTOCOMPLETE_HTTP_STATUS,
  type DestinationAutocompleteInvalidRequestReason,
  type DestinationAutocompleteResponse,
  type DestinationSuggestionWire,
} from "../edge-function-types/destinationAutocompleteContract.ts";

// No Supabase client at all -- the simplest deps shape in this project so
// far, a direct consequence of autocompleteDestination.ts being a
// deliberately stateless proxy with no cache table (see that module's own
// header comment for why).
export interface HandleDestinationAutocompleteRequestDeps {
  googlePlacesApiKey: string;
}

export interface HandleDestinationAutocompleteResult {
  response: DestinationAutocompleteResponse;
  status: number;
}

// --- Request validation ----------------------------------------------------

const DEFAULT_SUGGESTION_LIMIT = 5;
const MAX_SUGGESTION_LIMIT = 10;
// Our own floor, not one LocationIQ itself enforces -- live-verified a
// 1-character query returns real 200 results directly from LocationIQ.
// Rejected here anyway: real but low-value, and rejecting it cheaply
// avoids a wasted external call.
const MIN_QUERY_LENGTH = 2;

interface ValidatedRequest {
  query: string;
  limit: number;
}

function invalidRequest(reason: DestinationAutocompleteInvalidRequestReason, message: string): HandleDestinationAutocompleteResult {
  return { response: { status: "invalid_request", reason, message }, status: DESTINATION_AUTOCOMPLETE_HTTP_STATUS.invalid_request };
}

function parseAndValidateRequest(rawBody: string): ValidatedRequest | HandleDestinationAutocompleteResult {
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

  if (typeof body.query !== "string") {
    return invalidRequest("malformed_body", '"query" must be a string.');
  }
  const trimmedQuery = body.query.trim();
  if (trimmedQuery.length < MIN_QUERY_LENGTH) {
    return invalidRequest("query_too_short", `"query" must be at least ${MIN_QUERY_LENGTH} characters.`);
  }

  let limit = DEFAULT_SUGGESTION_LIMIT;
  if (body.limit !== undefined) {
    if (typeof body.limit !== "number" || !Number.isInteger(body.limit) || body.limit <= 0 || body.limit > MAX_SUGGESTION_LIMIT) {
      return invalidRequest("invalid_limit", `"limit" must be a positive integer, at most ${MAX_SUGGESTION_LIMIT}.`);
    }
    limit = body.limit;
  }

  return { query: trimmedQuery, limit };
}

// --- Error classification --------------------------------------------------

function internalError(message = "Something went wrong on our end. Please try again."): HandleDestinationAutocompleteResult {
  return { response: { status: "internal_error", message }, status: DESTINATION_AUTOCOMPLETE_HTTP_STATUS.internal_error };
}

function geocodingServiceUnavailable(
  message = "The suggestion service is temporarily unavailable. Please try again shortly.",
): HandleDestinationAutocompleteResult {
  return {
    response: { status: "geocoding_service_unavailable", message },
    status: DESTINATION_AUTOCOMPLETE_HTTP_STATUS.geocoding_service_unavailable,
  };
}

// autocompleteDestination's own throw surface (see that module) is narrow
// enough to classify safely without needing message-matching against
// anything not owned by this codebase, except one deliberately-scoped
// case (see below).
function classifyAutocompleteError(err: unknown): HandleDestinationAutocompleteResult {
  if (err instanceof GoogleApiRequestError) {
    if (err.message.includes("rejected the request as invalid")) {
      // Should be unreachable given this handler's own query_too_short
      // validation above -- if Google ever rejects a request we already
      // validated as fine, that signals a gap in OUR validation logic (or
      // a misconfigured API key -- see autocompleteDestination.ts's own
      // comment), not a genuine upstream failure.
      console.error(
        "handleDestinationAutocompleteRequest: Google Places rejected a request that passed our own validation:",
        err.message,
      );
      return internalError();
    }
    return geocodingServiceUnavailable();
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("unexpected Google Places response shape")) {
    return geocodingServiceUnavailable();
  }
  return internalError();
}

// --- Main entry point --------------------------------------------------

function toWireSuggestion(suggestion: DestinationSuggestion): DestinationSuggestionWire {
  return {
    kind: "general_place",
    placeId: suggestion.placeId,
    displayText: suggestion.displayText,
    displayAddress: suggestion.displayAddress,
  };
}

// Pure(ish) orchestration, no Request/Response/Deno.serve coupling -- same
// shape as handleParkingSearchRequest.ts/handleReverseGeocodeRequest.ts.
// supabase/functions/destination-autocomplete/index.ts is the thin
// wrapper that actually touches Request/Response/CORS. No `now` parameter
// -- unlike the other two handlers, there's no cache-freshness logic here
// to need one.
export async function handleDestinationAutocompleteRequest(
  deps: HandleDestinationAutocompleteRequestDeps,
  rawBody: string,
): Promise<HandleDestinationAutocompleteResult> {
  const validated = parseAndValidateRequest(rawBody);
  if ("response" in validated) {
    return validated;
  }
  const { query, limit } = validated;

  let suggestions: DestinationSuggestion[];
  try {
    suggestions = await autocompleteDestination(deps.googlePlacesApiKey, query, limit);
  } catch (err) {
    console.error("handleDestinationAutocompleteRequest: autocompleteDestination failed:", err);
    return classifyAutocompleteError(err);
  }

  return {
    response: { status: "ok", results: suggestions.map(toWireSuggestion) },
    status: DESTINATION_AUTOCOMPLETE_HTTP_STATUS.ok,
  };
}
