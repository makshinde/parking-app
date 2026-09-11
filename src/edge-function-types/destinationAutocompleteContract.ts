// Canonical request/response contract for the destination-autocomplete
// Edge Function -- a separate, independent capability from parking-search
// (parkingSearchContract.ts) and reverse-geocode (reverseGeocodeContract.ts).
// Kept in its own file for the same reason those two are separate: this
// isn't a parking search, and general-destination autocomplete is a
// distinct concern from local parking-location fuzzy-match
// (search_local_addresses, called directly by the frontend -- see
// migrations/019/020 -- with no Edge Function of its own).
//
// Type-only module -- no runtime logic, so it carries no portability
// concerns of its own.

// --- Request -----------------------------------------------------------

export interface DestinationAutocompleteRequestBody {
  query: string;
  // Omit for the default (5); capped at 10 -- same small-number-of-
  // suggestions convention as search_local_addresses' match_limit.
  limit?: number;
}

// --- Response ------------------------------------------------------------

// One Google Places Autocomplete (New) prediction, reshaped for the
// frontend. `kind: "general_place"` is the deliberate counterpart to
// LocalAddressSuggestion's "blockface" | "off_street_facility"
// (parkingSearchContract.ts) -- the two are NEVER merged into one ranked
// list (their relevance scores -- local trigram similarity vs Google's own
// internal ranking -- are incomparable, the same scale-mismatch problem
// migrations/020 already found and fixed for blockfaces vs off-street
// facilities). The frontend renders them as two clearly separate,
// independently-ranked groups ("Parking locations" vs "Destinations"),
// each simply in the order its own source returned.
//
// Deliberately NO lat/lon here, unlike this field's original LocationIQ-
// backed shape. Google's Places Autocomplete (New) API structurally does
// not return coordinates on a prediction -- live-verified directly against
// the real API and confirmed against Google's own schema reference
// (placePrediction's real, complete field list: place, placeId, text,
// structuredFormat, types, distanceMeters -- no location field at all).
// Getting a suggestion's real coordinates now requires a SEPARATE,
// explicit resolve step once the user actually selects one -- see
// resolveDestinationContract.ts's own header comment for the full
// reasoning and the real Google billing guidance behind this design
// (a single Geocoding API call on selection, deliberately not a Place
// Details call, per Google's own documented cost comparison).
//
// placeId is Google's own Places (New) place ID (e.g.
// "ChIJkaHOMclqkFQRSMxIEFOHp_k") -- carried along specifically so the
// frontend can pass it to resolve-destination on selection; no longer just
// a display/dedup convenience the way LocationIQ's third-party OSM-derived
// place_id was.
export interface DestinationSuggestionWire {
  kind: "general_place";
  placeId: string;
  displayText: string; // Google's structuredFormat.mainText -- the short name, e.g. "Pike Place Market"
  displayAddress: string | null; // Google's structuredFormat.secondaryText -- the rest, e.g. "Seattle, WA, USA"
}

export interface DestinationAutocompleteSuccessResponse {
  status: "ok";
  // Always present, possibly [] -- a genuinely empty suggestion list
  // (Google's own real no-match shape, live-verified: HTTP 200, body
  // `{}` -- no `suggestions` key at all, not an error) is the ordinary
  // outcome of an unmatched partial query, not a distinct error state --
  // same reasoning as ParkingSearchSuccessResponse.results being empty
  // for a real search with zero candidates.
  results: DestinationSuggestionWire[];
}

// Mirrors parkingSearchContract.ts's InvalidRequestReason split: a
// client-contract violation is validated and rejected before ever
// calling autocompleteDestination.
export type DestinationAutocompleteInvalidRequestReason =
  | "malformed_body" // missing/wrong-typed query, or a wrong-typed limit
  | "query_too_short" // query (after trimming) is under the 2-character minimum -- our own floor, not one Google itself enforces; rejected here anyway since a 1-character query is real but low-value, and rejecting it cheaply avoids a wasted external call
  | "invalid_limit"; // limit present and not a positive integer at most 10 -- mirrors search_local_addresses' match_limit bound exactly

export interface DestinationAutocompleteInvalidRequestResponse {
  status: "invalid_request";
  reason: DestinationAutocompleteInvalidRequestReason;
  message: string;
}

// Mirrors parkingSearchContract.ts's GeocodingServiceUnavailableResponse:
// autocompleteDestination throwing (retries exhausted on a sustained
// 429/5xx, a non-retryable failure, or an unexpected response shape) is a
// genuine upstream-dependency failure, never the caller's fault.
export interface DestinationAutocompleteServiceUnavailableResponse {
  status: "geocoding_service_unavailable";
  message: string;
}

// Every other failure -- including, notably, Google rejecting a request
// with its own real "invalid argument" (HTTP 400) shape despite this
// endpoint's own query_too_short validation already having passed -- is
// treated as OUR bug, not Google's fault: our own validation should make
// that response unreachable, so actually reaching it signals a gap in our
// own logic (or, live-verified as a real, distinct cause: our own API key
// being invalid/misconfigured -- Google returns the SAME HTTP 400 for
// both, distinguishable only by the response body's own
// error.details[].reason field, e.g. "API_KEY_INVALID"). Same "never leak
// the raw internal error text" rule as every other internal_error
// response in this project.
export interface DestinationAutocompleteInternalErrorResponse {
  status: "internal_error";
  message: string;
}

export type DestinationAutocompleteResponse =
  | DestinationAutocompleteSuccessResponse
  | DestinationAutocompleteInvalidRequestResponse
  | DestinationAutocompleteServiceUnavailableResponse
  | DestinationAutocompleteInternalErrorResponse;

export const DESTINATION_AUTOCOMPLETE_HTTP_STATUS: Record<DestinationAutocompleteResponse["status"], number> = {
  ok: 200,
  invalid_request: 400,
  geocoding_service_unavailable: 502,
  internal_error: 500,
};
