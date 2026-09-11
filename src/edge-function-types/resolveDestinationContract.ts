// Canonical request/response contract for the resolve-destination Edge
// Function -- a separate, independent capability from destination-
// autocomplete (destinationAutocompleteContract.ts), parking-search
// (parkingSearchContract.ts), and reverse-geocode (reverseGeocodeContract.ts).
//
// Exists specifically because Google's Places Autocomplete (New) API
// structurally cannot return coordinates on a prediction (see
// destinationAutocompleteContract.ts's own header comment for the live
// verification behind that) -- so once a user actually SELECTS a
// suggestion, the frontend needs one more real call to turn that
// suggestion's placeId into real lat/lon before it can build
// ParkingSearchRequestBody.searchCenter.
//
// Deliberately a single Geocoding API call (`place_id=` lookup), NOT a
// Place Details call: Google's own documented cost-comparison guidance
// ("Autocomplete (New) and session pricing") states plainly that making a
// few Autocomplete requests plus a Geocoding API call is cheaper than
// per-session Autocomplete + Place Details pricing for exactly this
// resolve-one-selected-place use case -- and this endpoint deliberately
// does not use session tokens at all (see autocompleteDestination.ts's own
// header comment for why that was ruled out for this project), which rules
// out Place Details/Address Validation entirely as a session-closing
// mechanism anyway: without a session token, there's no session to close.
//
// Type-only module -- no runtime logic, so it carries no portability
// concerns of its own.

// --- Request -----------------------------------------------------------

export interface ResolveDestinationRequestBody {
  // Google's own Places (New) place ID, exactly as returned on a
  // DestinationSuggestionWire from destination-autocomplete -- not
  // free-text (the suggestion's own display text), deliberately: geocoding
  // by placeId resolves the EXACT place the user selected, unambiguously,
  // rather than re-interpreting a text string that could in principle
  // match a different real place than the one actually shown (e.g. two
  // distinct real locations sharing a very similar display name).
  placeId: string;
}

// --- Responses -----------------------------------------------------------

export interface ResolvedDestinationAddress {
  displayName: string;
  lat: number;
  lon: number;
}

export interface ResolveDestinationSuccessResponse {
  status: "ok";
  resolvedAddress: ResolvedDestinationAddress;
}

// Mirrors reverseGeocodeContract.ts's ReverseGeocodeNoMatchResponse
// reasoning: modeled defensively for a genuine, if rare, real outcome --
// the placeId being resolved here came directly from Google's own
// Autocomplete response moments earlier, so a real no-match should be
// close to impossible in practice, but a transient data inconsistency on
// Google's side is still a legitimate domain outcome, not a transport-
// level failure, if it ever happens.
export interface ResolveDestinationNoMatchResponse {
  status: "no_match";
  message: string;
}

// Mirrors parkingSearchContract.ts's InvalidRequestReason split: a
// client-contract violation is validated and rejected before ever calling
// resolveDestinationCoordinates.
export type ResolveDestinationInvalidRequestReason =
  | "malformed_body"; // missing/wrong-typed placeId

export interface ResolveDestinationInvalidRequestResponse {
  status: "invalid_request";
  reason: ResolveDestinationInvalidRequestReason;
  message: string;
}

// Mirrors reverseGeocodeContract.ts's ReverseGeocodeServiceUnavailableResponse:
// resolveDestinationCoordinates throwing (retries exhausted on a sustained
// 429/5xx, a non-retryable failure, or an unexpected response shape) is a
// genuine upstream-dependency failure, never the caller's fault. Message
// shown to the frontend must stay generic -- never the raw thrown error
// text.
export interface ResolveDestinationServiceUnavailableResponse {
  status: "geocoding_service_unavailable";
  message: string;
}

// Mirrors destinationAutocompleteContract.ts's InternalErrorResponse
// reasoning exactly, including the same real, live-verified cause: Google
// returns the same HTTP 400 for a structurally invalid request and for an
// invalid/misconfigured API key, distinguishable only by the response
// body's own error.details[].reason field.
export interface ResolveDestinationInternalErrorResponse {
  status: "internal_error";
  message: string;
}

export type ResolveDestinationResponse =
  | ResolveDestinationSuccessResponse
  | ResolveDestinationNoMatchResponse
  | ResolveDestinationInvalidRequestResponse
  | ResolveDestinationServiceUnavailableResponse
  | ResolveDestinationInternalErrorResponse;

export const RESOLVE_DESTINATION_HTTP_STATUS: Record<ResolveDestinationResponse["status"], number> = {
  ok: 200,
  no_match: 200,
  invalid_request: 400,
  geocoding_service_unavailable: 502,
  internal_error: 500,
};
