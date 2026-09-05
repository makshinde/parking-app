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

// One LocationIQ autocomplete result, reshaped for the frontend. `kind:
// "general_place"` is the deliberate counterpart to LocalAddressSuggestion's
// "blockface" | "off_street_facility" (parkingSearchContract.ts) -- the
// two are NEVER merged into one ranked list (their relevance scores --
// local trigram similarity vs LocationIQ's own internal ranking -- are
// incomparable, the same scale-mismatch problem migrations/020 already
// found and fixed for blockfaces vs off-street facilities). The frontend
// renders them as two clearly separate, independently-ranked groups
// ("Parking locations" vs "Destinations"), each simply in the order its
// own source returned.
//
// placeId is LocationIQ's own place_id -- a third-party, OSM-derived
// value, carried along for display/dedup purposes only, never treated as
// a stable domain identifier the way LocalAddressSuggestion.id is (a real
// blockfaces/off_street_facilities primary key).
//
// Selecting either kind converges on the exact same downstream shape:
// ParkingSearchRequestBody.searchCenter: { type: "coordinates", lat, lon,
// label: displayText } -- no further backend change needed for that
// contract.
export interface DestinationSuggestionWire {
  kind: "general_place";
  placeId: string;
  displayText: string; // LocationIQ's display_place -- the short name, e.g. "Pike Place Market"
  displayAddress: string | null; // LocationIQ's display_address -- the rest, e.g. "2nd Avenue Cycletrack, Seattle, WA..."
  lat: number;
  lon: number;
}

export interface DestinationAutocompleteSuccessResponse {
  status: "ok";
  // Always present, possibly [] -- a genuinely empty suggestion list
  // (LocationIQ's own no-match case, live-verified: HTTP 404
  // {"error":"Unable to geocode"}) is the ordinary outcome of an
  // unmatched partial query, not a distinct error state -- same
  // reasoning as ParkingSearchSuccessResponse.results being empty for a
  // real search with zero candidates.
  results: DestinationSuggestionWire[];
}

// Mirrors parkingSearchContract.ts's InvalidRequestReason split: a
// client-contract violation is validated and rejected before ever
// calling autocompleteDestination.
export type DestinationAutocompleteInvalidRequestReason =
  | "malformed_body" // missing/wrong-typed query, or a wrong-typed limit
  | "query_too_short" // query (after trimming) is under the 2-character minimum -- our own floor, not one LocationIQ itself enforces (live-verified a 1-character query returns real 200 results from LocationIQ directly); rejected here anyway since a 1-character query is real but low-value, and rejecting it cheaply avoids a wasted external call
  | "invalid_limit"; // limit present and not a positive integer at most 10 -- mirrors search_local_addresses' match_limit bound exactly

export interface DestinationAutocompleteInvalidRequestResponse {
  status: "invalid_request";
  reason: DestinationAutocompleteInvalidRequestReason;
  message: string;
}

// Mirrors parkingSearchContract.ts's GeocodingServiceUnavailableResponse:
// autocompleteDestination throwing (retries exhausted on a sustained
// 429/5xx, a non-retryable failure, or a non-numeric coordinate in an
// otherwise-successful response) is a genuine upstream-dependency
// failure, never the caller's fault.
export interface DestinationAutocompleteServiceUnavailableResponse {
  status: "geocoding_service_unavailable";
  message: string;
}

// Every other failure -- including, notably, LocationIQ rejecting a
// request with its own real "Invalid Request" (HTTP 400) shape despite
// this endpoint's own query_too_short validation already having passed --
// is treated as OUR bug, not LocationIQ's fault: our own validation
// should make that response unreachable, so actually reaching it signals
// a gap in our own logic. Same "never leak the raw internal error text"
// rule as every other internal_error response in this project.
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
