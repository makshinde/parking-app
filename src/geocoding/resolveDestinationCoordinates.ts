import { GoogleApiRequestError } from "./autocompleteDestination.ts";

// Resolves a Google Places (New) place ID -- exactly the one a
// destination-autocomplete suggestion carries -- to real coordinates, via
// the classic Google Geocoding API's real `place_id` lookup mode. See
// resolveDestinationContract.ts's own header comment for why this exists
// (Autocomplete (New) structurally never returns coordinates) and why a
// plain Geocoding call, not Place Details, was deliberately chosen (cost:
// Google's own documented guidance says a Geocoding API call here is
// cheaper than Place Details, and this project never uses session tokens
// in the first place -- see autocompleteDestination.ts's own header
// comment).
//
// Deliberately stateless, same reasoning as autocompleteDestination.ts:
// no cache table here either. Unlike a per-keystroke autocomplete query, a
// SELECTED place is genuinely cache-worthy (many different users
// realistically do select the same real place) -- a placeId-keyed cache
// would be a reasonable future addition, but is out of scope for this
// deliberately small, one-shot resolve endpoint; not built here.
const GOOGLE_GEOCODING_URL = "https://maps.googleapis.com/maps/api/geocode/json";

function buildGeocodeUrl(placeId: string, apiKey: string): string {
  const url = new URL(GOOGLE_GEOCODING_URL);
  url.searchParams.set("place_id", placeId);
  url.searchParams.set("key", apiKey);
  return url.toString();
}

// Real, documented shape of a Geocoding API result -- narrowed to the
// fields this module actually uses. Unlike every LocationIQ-backed module
// in this project, lat/lng arrive as real JSON numbers here, not numeric
// strings -- no string-to-number parsing needed for the coordinates
// themselves (still defensively validated as finite below, since this
// interface's `number` typing is a compile-time assertion, not a runtime
// guarantee about a real external response).
interface GoogleGeocodingResult {
  formatted_address: string;
  geometry: {
    location: { lat: number; lng: number };
  };
}

// The classic Geocoding API funnels essentially every outcome -- success,
// no-match, invalid key, rate limit, malformed request -- through HTTP 200
// with a body-level `status` field, NOT real HTTP status codes. Live-
// verified directly against this exact endpoint and key: an invalid API
// key still returned HTTP 200 with `status: "REQUEST_DENIED"` in the body
// (see below), not a 401/403 -- a genuinely different error-transport
// convention than Places API (New)'s real HTTP status codes
// (autocompleteDestination.ts). The other status values below
// (ZERO_RESULTS, OVER_QUERY_LIMIT, OVER_DAILY_LIMIT, INVALID_REQUEST,
// UNKNOWN_ERROR) are Google's own complete, official documented set
// (developers.google.com/maps/documentation/geocoding/requests-geocoding)
// -- not yet live-triggered as of this module's own initial build (the
// Geocoding API wasn't enabled yet on this project's real key at build
// time), pending a live re-verification pass once it is.
interface GoogleGeocodingResponse {
  status: "OK" | "ZERO_RESULTS" | "OVER_QUERY_LIMIT" | "OVER_DAILY_LIMIT" | "REQUEST_DENIED" | "INVALID_REQUEST" | "UNKNOWN_ERROR";
  results: GoogleGeocodingResult[];
  error_message?: string;
}

const MAX_FETCH_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_JITTER_MAX_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Google's own standard REST convention for a real transport-level
// failure (not one of the documented body-level `status` outcomes above,
// which this endpoint returns via HTTP 200 regardless of outcome) -- same
// retryable convention as autocompleteDestination.ts.
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function assertFiniteCoordinate(value: number, label: "lat" | "lon"): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`resolveDestinationCoordinates: Google Geocoding returned a non-numeric ${label} (${JSON.stringify(value)})`);
  }
  return value;
}

export type ResolveDestinationResult =
  | { matched: true; displayName: string; lat: number; lon: number }
  | { matched: false };

async function fetchGeocodeOnce(placeId: string, apiKey: string): Promise<ResolveDestinationResult> {
  const response = await fetch(buildGeocodeUrl(placeId, apiKey));

  if (!response.ok) {
    // A genuinely unexpected transport-level failure -- not one of the
    // documented body-level status outcomes below, which this endpoint
    // returns via HTTP 200 regardless of outcome (see this module's own
    // header comment).
    throw new GoogleApiRequestError(
      `resolveDestinationCoordinates: Google Geocoding request failed with status ${response.status} ${response.statusText}`,
      isRetryableStatus(response.status),
    );
  }

  const body = (await response.json()) as GoogleGeocodingResponse;

  switch (body.status) {
    case "OK": {
      const result = body.results[0];
      if (result === undefined) {
        throw new Error('resolveDestinationCoordinates: Google Geocoding returned status "OK" with an empty results array');
      }
      return {
        matched: true,
        displayName: result.formatted_address,
        lat: assertFiniteCoordinate(result.geometry.location.lat, "lat"),
        lon: assertFiniteCoordinate(result.geometry.location.lng, "lon"),
      };
    }
    case "ZERO_RESULTS":
      // A genuine, real outcome -- see resolveDestinationContract.ts's own
      // comment on why this should be rare (the placeId came directly
      // from Google's own Autocomplete response moments earlier) but is
      // still modeled honestly rather than assumed impossible.
      return { matched: false };
    case "OVER_QUERY_LIMIT":
      // Documented as "you are over your quota" -- a real rate limit,
      // same retryable treatment as a 429 elsewhere in this project.
      throw new GoogleApiRequestError(
        `resolveDestinationCoordinates: Google Geocoding reported OVER_QUERY_LIMIT${body.error_message !== undefined ? `: ${body.error_message}` : ""}`,
        true,
      );
    case "REQUEST_DENIED":
    case "OVER_DAILY_LIMIT":
      // Live-verified real shape for REQUEST_DENIED (an invalid API key):
      // {"error_message":"This API key is not authorized to use this
      // service or API...","results":[],"status":"REQUEST_DENIED"}.
      // OVER_DAILY_LIMIT covers the same real family of causes per
      // Google's own docs (missing/invalid key, billing disabled, usage
      // cap, invalid payment method) -- both signal OUR infrastructure
      // misconfigured, never the caller's fault, so both are
      // non-retryable here.
      throw new GoogleApiRequestError(
        `resolveDestinationCoordinates: Google Geocoding denied the request (${body.status})${body.error_message !== undefined ? `: ${body.error_message}` : ""} -- likely a misconfigured or unauthorized API key, not a caller error`,
        false,
      );
    case "INVALID_REQUEST":
      // Documented as generally meaning the query (here, `place_id`) is
      // missing -- should be unreachable given this module's own caller
      // always supplies a real placeId from a prior Autocomplete response.
      throw new GoogleApiRequestError(
        "resolveDestinationCoordinates: Google Geocoding rejected the request as invalid -- should be unreachable given this module's own caller's validation",
        false,
      );
    case "UNKNOWN_ERROR":
      // Documented explicitly as a transient server-side error -- retryable.
      throw new GoogleApiRequestError('resolveDestinationCoordinates: Google Geocoding reported UNKNOWN_ERROR (documented as a transient server error)', true);
    default:
      throw new Error(`resolveDestinationCoordinates: unexpected Google Geocoding status "${String(body.status)}"`);
  }
}

async function fetchGeocodeWithRetry(placeId: string, apiKey: string): Promise<ResolveDestinationResult> {
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      return await fetchGeocodeOnce(placeId, apiKey);
    } catch (err) {
      const retryable = !(err instanceof GoogleApiRequestError) || err.retryable;
      const isLastAttempt = attempt === MAX_FETCH_ATTEMPTS;
      if (!retryable || isLastAttempt) {
        throw err;
      }

      const baseDelayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      const jitterMs = Math.random() * RETRY_JITTER_MAX_MS;
      const delayMs = baseDelayMs + jitterMs;
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `resolveDestinationCoordinates: attempt ${attempt}/${MAX_FETCH_ATTEMPTS} failed (${reason}); retrying in ${delayMs.toFixed(0)}ms`,
      );
      await sleep(delayMs);
    }
  }

  throw new Error("resolveDestinationCoordinates: unreachable -- fetchGeocodeWithRetry exhausted retries without a resolved result");
}

// `apiKey` is an explicit parameter, not read internally, matching every
// other geocoding module's runtime-agnosticism convention in this project.
export async function resolveDestinationCoordinates(apiKey: string, placeId: string): Promise<ResolveDestinationResult> {
  return fetchGeocodeWithRetry(placeId, apiKey);
}
