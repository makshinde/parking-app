// Canonical request/response contract for the parking-search Edge Function.
// This is the single source of truth the frontend is built against --
// consolidates what's already decided across resolveRequestTime.ts,
// migrations/017's spatial-search RPCs, geocodeAddress.ts, and
// assembleSearchResults.ts.
//
// Updated for the approved address-selection-flow design (Pieces 2 and 4):
// the request now accepts EITHER a free-form address string (forward-
// geocoded, the original path) OR direct coordinates as an alternative way
// to specify the search center, skipping geocoding entirely -- covering
// both a clicked local-suggestion result (search_local_addresses,
// migrations/019/020) and a manually-dragged map pin, which isn't tied to
// any known ID at all. This is a deliberate breaking change from the
// original flat `address: string` field: nothing outside this repo
// consumes this contract yet (no frontend built), so there is no
// compatibility obligation to preserve.
//
// Type-only module -- no runtime logic, so it carries no portability
// concerns of its own beyond the modules it re-exports types from (all of
// which are already independently confirmed Deno-portable).

import type { QuickTimeOption, ResolvedRequestTime } from "../scoring/resolveRequestTime.ts";
import type { CandidateResult } from "../scoring/assembleSearchResults.ts";

// --- Request -----------------------------------------------------------

// The wire-level counterpart to resolveRequestTime.ts's PredictionTimeRequest.
// That type's "specific" variant carries a real `Date`, which isn't
// JSON-serializable -- over the wire it arrives as an ISO 8601 string
// instead. The Edge Function is responsible for parsing `instant` into a
// `Date` (via `new Date(instant)`) before calling resolveRequestTime, and
// must treat a string that parses to an invalid Date as its own
// malformed_body case (see InvalidRequestReason below) -- distinct from
// resolveRequestTime's own NaN-Date guard, which exists for direct
// in-memory/test callers, not as the request's first line of defense.
export type PredictionTimeRequestWire = { type: "quick"; option: QuickTimeOption } | { type: "specific"; instant: string };

// Either a free-form address (forward-geocoded via geocodeAddress.ts, the
// original path) or direct coordinates, which skip geocoding entirely.
// `label`, on the coordinates variant, is how reverse-geocoding and
// parking-search stay decoupled: the frontend already knows a human-
// readable label for the point before ever calling this endpoint -- either
// from a clicked search_local_addresses suggestion's own display_text, or
// from an earlier, separate call to the reverse-geocode Edge Function when
// a pin was dragged (see reverseGeocodeContract.ts) -- so this endpoint
// never needs to reverse-geocode on its own. Omitting `label` (e.g. a raw
// API caller) falls back to a plain, honest coordinate description, never
// a guessed address.
export type SearchCenterWire = { type: "address"; query: string } | { type: "coordinates"; lat: number; lon: number; label?: string };

export interface ParkingSearchRequestBody {
  searchCenter: SearchCenterWire;
  time: PredictionTimeRequestWire;
  // Meters, (0, 1000], matching nearby_blockfaces/nearby_off_street_facilities'
  // own radius_meters bound exactly (migrations/017). Omit for the default (200).
  radiusMeters?: number;
  // Omit for the default cap (20, matching assembleSearchResults.ts's
  // DEFAULT_RESULT_LIMIT); "all" for the full, uncapped list.
  limit?: number | "all";
}

// --- Success response ----------------------------------------------------

export interface ResolvedSearchCenter {
  displayName: string;
  lat: number;
  lon: number;
  // Lets the frontend distinguish "we geocoded your text" from "you gave
  // us a point directly" without needing to remember which searchCenter
  // variant it originally sent.
  source: "geocoded" | "coordinates";
}

export interface ParkingSearchSuccessResponse {
  status: "ok";
  resolvedTime: ResolvedRequestTime;
  // Echoes back what the search center actually resolved to -- the
  // frontend needs this to confirm "we found your address as X" (or "you
  // picked this point") and to know the real center point results were
  // measured from.
  resolvedCenter: ResolvedSearchCenter;
  results: CandidateResult[];
  // Count before capping -- lets the frontend show "20 of 47 nearby" and
  // know whether requesting limit: "all" would actually return more.
  totalCandidateCount: number;
}

// --- "Valid request, nothing to show" responses ---------------------------
//
// Two genuinely different scenarios that must not be conflated, both
// legitimate (non-error) outcomes of a well-formed request:
//
// 1. AddressNotFoundResponse: geocodeAddress.ts returned matched: false --
//    we don't know where the address even is. No search was performed.
// 2. A normal ParkingSearchSuccessResponse with results: [] and
//    totalCandidateCount: 0 -- we resolved the address fine, but nothing
//    (no blockface, no facility) exists within the given radius. This is
//    NOT a distinct response type -- it's the ordinary success shape,
//    just empty. No special-casing needed; both nearby_* RPCs already
//    return empty arrays cleanly for this case (nothing here to design).

// address_not_found is modeled as
// its own top-level status, not folded into the generic error envelope,
// and NOT mapped to a 4xx/5xx status. Recommended HTTP status: 200.
// Reasoning: the request itself was well-formed and fully processed --
// "this address doesn't geocode" is domain information the frontend
// renders (e.g. "we couldn't find that address, try being more specific"),
// the same way a search returning zero matches is conventionally 200 with
// an empty/flagged body, not a transport-level failure. A real, live
// example already seen in this project's own LocationIQ investigation:
// querying "zzzznonexistentaddressxyzabc123, Nowhereville" against the
// real API is an entirely ordinary, expected occurrence (a typo, an
// address outside LocationIQ's coverage), not a bug or an abuse case --
// treating it as a 4xx would incorrectly imply the CLIENT violated the
// API contract, when it didn't. The realistic alternative is 422
// Unprocessable Entity ("syntactically valid, semantically unactionable")
// -- open to that instead if you'd rather the frontend branch on status
// code alone rather than inspecting the body's `status` field.
export interface AddressNotFoundResponse {
  status: "address_not_found";
  // The exact, normalized query that failed to resolve -- useful for the
  // frontend to echo back ("we couldn't find '123 fake st'") and for
  // debugging/logs.
  query: string;
  message: string;
  // Reuses search_local_addresses -- the same fuzzy-match function used
  // for live-typing autocomplete -- triggered specifically because the
  // typed address both matched no local suggestion (or the frontend's own
  // autocomplete wasn't used/ignored) and failed real LocationIQ
  // geocoding. Always present, possibly [] -- never omitted, so the
  // frontend never needs an existence check, the same convention
  // ParkingSearchSuccessResponse.results already uses for a genuinely
  // empty result set.
  suggestions: LocalAddressSuggestion[];
}

// One row from search_local_addresses (migrations/019/020), reused
// verbatim as the "did you mean" fallback above -- deliberately not a
// separate suggestion mechanism. Field names match this project's usual
// camelCase wire convention, not the RPC's raw snake_case columns.
export interface LocalAddressSuggestion {
  kind: "blockface" | "off_street_facility";
  id: string;
  displayText: string;
  lat: number;
  lon: number;
}

// --- Error responses -----------------------------------------------------
//
// A client-contract violation
// (malformed body, out-of-range radius, an invalid/too-far-future time
// request, an invalid limit) is validated and rejected by the Edge
// Function's OWN request-parsing layer, BEFORE calling either spatial-
// search RPC or resolveRequestTime in a way that could throw a raw,
// internal error message. This is a deliberate design decision, not
// incidental: nearby_blockfaces/nearby_off_street_facilities already
// enforce the same (0, 1000] radius bound themselves (a defense-in-depth
// backstop, per migrations/017's own reasoning -- these RPCs are directly
// callable by the anon key), but a raw Postgres RAISE EXCEPTION surfaced
// through PostgREST is not a clean, stable, frontend-facing error contract
// (its exact shape/status code was never verified against a real call in
// this project, and shouldn't be relied on for user-facing behavior).
// Likewise, resolveRequestTime.ts's thrown RangeErrors carry internal,
// implementation-oriented message text not meant for direct display.
// The Edge Function validates the SAME bounds itself first and returns a
// clean InvalidRequestResponse; the RPC/resolveRequestTime's own
// validation should in practice never be reached by a well-behaved Edge
// Function, but remains as the last line of defense either way.
export type InvalidRequestReason =
  | "malformed_body" // missing/wrong-typed searchCenter, time, radiusMeters, or limit field; an unrecognized searchCenter.type; a `time.instant` string that fails to parse to a valid Date
  | "invalid_radius" // radiusMeters <= 0 or > 1000 -- mirrors nearby_blockfaces/nearby_off_street_facilities' own bound exactly
  | "invalid_coordinates" // searchCenter.type === "coordinates" with a non-finite lat/lon or one outside real-world range ([-90,90]/[-180,180]) -- reject, don't clamp; see validateCoordinates.ts's own comment for the full reasoning
  | "time_too_far_in_future" // daysInFuture would exceed MAX_DAYS_IN_FUTURE (7 -- see confidenceScore.ts), called out as its own reason (not folded into invalid_time_request) so the frontend can show a specific "pick a time within the next 7 days" message
  | "invalid_time_request" // a specific instant that resolves to the past, or an unrecognized quick option/type -- resolveRequestTime.ts's other real rejection cases
  | "invalid_limit"; // limit present, not "all", and not a positive integer -- mirrors assembleSearchResults.ts's own validation exactly

// All InvalidRequestReason cases map to HTTP 400 -- a genuine client-
// contract violation in every case, distinct from the geocoding/upstream/
// internal failure modes below.
export interface InvalidRequestResponse {
  status: "invalid_request";
  reason: InvalidRequestReason;
  message: string;
}

// geocodeAddress.ts throwing (LocationIQ's retries exhausted on
// a sustained 429/5xx, a non-retryable failure like a bad API key, or an
// unexpected/non-numeric coordinate in an otherwise-successful response --
// see geocodeAddress.ts's own error classification) is a genuine upstream-
// dependency failure, not the caller's fault and not our own
// infrastructure's fault. Recommended HTTP status: 502 Bad Gateway (the
// conventional status for "a service we depend on failed"). The message
// shown to the frontend must be generic and safe -- never the raw thrown
// error text, which could include internal detail (e.g. LocationIQ's own
// response body) not meant for an end user.
export interface GeocodingServiceUnavailableResponse {
  status: "geocoding_service_unavailable";
  message: string;
}

// Every other failure -- occupancy_stats query errors
// (assembleSearchResults.ts), a genuine (non-validation) failure from
// either spatial-search RPC, a geocode_cache read/write failure
// (geocodeAddress.ts), or anything else unanticipated -- is our own
// infrastructure failing, not a third party and not the client. Recommended
// HTTP status: 500 Internal Server Error. Same "never leak the raw
// internal error text" rule as GeocodingServiceUnavailableResponse.
export interface InternalErrorResponse {
  status: "internal_error";
  message: string;
}

// --- Top-level response union -----------------------------------------

export type ParkingSearchResponse =
  | ParkingSearchSuccessResponse
  | AddressNotFoundResponse
  | InvalidRequestResponse
  | GeocodingServiceUnavailableResponse
  | InternalErrorResponse;

// HTTP status per response `status` value -- see each response type's own
// comment above for the reasoning behind each.
export const PARKING_SEARCH_HTTP_STATUS: Record<ParkingSearchResponse["status"], number> = {
  ok: 200,
  address_not_found: 200,
  invalid_request: 400,
  geocoding_service_unavailable: 502,
  internal_error: 500,
};
