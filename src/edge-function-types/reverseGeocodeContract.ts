// Canonical request/response contract for the reverse-geocode Edge
// Function -- a separate, independent capability from parking-search
// (parkingSearchContract.ts), used when a pin gets manually moved to show
// an honest, current description of the new location. Kept in its own
// file rather than folded into parkingSearchContract.ts: this endpoint
// isn't a parking search at all, and parkingSearchContract.ts's own header
// comment already designates it as the canonical contract for that
// specific request, not a catch-all for every Edge Function this project
// exposes.
//
// Type-only module -- no runtime logic, so it carries no portability
// concerns of its own.

// --- Request -----------------------------------------------------------

export interface ReverseGeocodeRequestBody {
  lat: number;
  lon: number;
}

// --- Responses -----------------------------------------------------------

export interface ResolvedReverseGeocodeAddress {
  displayName: string;
  lat: number;
  lon: number;
}

export interface ReverseGeocodeSuccessResponse {
  status: "ok";
  resolvedAddress: ResolvedReverseGeocodeAddress;
}

// Mirrors parkingSearchContract.ts's AddressNotFoundResponse reasoning
// exactly: a well-formed request that LocationIQ genuinely couldn't
// resolve is domain information, not a transport-level failure -- HTTP
// 200, not 4xx/5xx. Live-verified (this project's own reverse-geocoding
// investigation) that this is rare in practice: LocationIQ falls back to
// a coarse enclosing city/county match for most points near a populated
// region, even genuine water points, so a real no_match only happens for
// a coordinate with no enclosing administrative area at all (e.g. open
// ocean).
export interface ReverseGeocodeNoMatchResponse {
  status: "no_match";
  message: string;
}

// Mirrors parkingSearchContract.ts's InvalidRequestReason split: a client-
// contract violation is validated and rejected before ever calling
// reverseGeocodeCoordinates, the same "our own validation is the primary
// layer, not a raw internal error surfaced to the client" reasoning.
export type ReverseGeocodeInvalidRequestReason =
  | "malformed_body" // missing/wrong-typed lat or lon
  | "invalid_coordinates"; // lat/lon non-finite or outside real-world range ([-90,90]/[-180,180]) -- reject, don't clamp, same reasoning as parkingSearchContract.ts's coordinates variant: a map widget cannot structurally produce an out-of-range value from a real drag, so one signals a bug, not imprecise intent, and there's no meaningful "nearest valid" coordinate to clamp toward.

export interface ReverseGeocodeInvalidRequestResponse {
  status: "invalid_request";
  reason: ReverseGeocodeInvalidRequestReason;
  message: string;
}

// Mirrors parkingSearchContract.ts's GeocodingServiceUnavailableResponse:
// reverseGeocodeCoordinates throwing (retries exhausted on a sustained
// 429/5xx, a non-retryable failure, or a non-numeric coordinate in an
// otherwise-successful response) is a genuine upstream-dependency
// failure, never the caller's fault. Message shown to the frontend must
// stay generic -- never the raw thrown error text.
export interface ReverseGeocodeServiceUnavailableResponse {
  status: "geocoding_service_unavailable";
  message: string;
}

// Mirrors parkingSearchContract.ts's InternalErrorResponse: a cache
// read/write failure or anything else unanticipated is our own
// infrastructure failing, not LocationIQ's and not the client's.
export interface ReverseGeocodeInternalErrorResponse {
  status: "internal_error";
  message: string;
}

export type ReverseGeocodeResponse =
  | ReverseGeocodeSuccessResponse
  | ReverseGeocodeNoMatchResponse
  | ReverseGeocodeInvalidRequestResponse
  | ReverseGeocodeServiceUnavailableResponse
  | ReverseGeocodeInternalErrorResponse;

export const REVERSE_GEOCODE_HTTP_STATUS: Record<ReverseGeocodeResponse["status"], number> = {
  ok: 200,
  no_match: 200,
  invalid_request: 400,
  geocoding_service_unavailable: 502,
  internal_error: 500,
};
