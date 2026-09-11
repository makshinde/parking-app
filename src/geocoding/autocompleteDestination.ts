// Proxies Google's real Places API (New) Autocomplete endpoint
// (POST places.googleapis.com/v1/places:autocomplete) -- replacing the
// original LocationIQ-backed implementation. The swap was motivated by a
// real, confirmed, unfixable-on-our-side bug: LocationIQ's /v1/autocomplete
// endpoint returns different results to Deno's own fetch than to curl for
// byte-identical requests (client-level fingerprinting on LocationIQ's or
// an intermediary's side -- see CLAUDE.md's Known open questions for the
// full investigation). Google's endpoint was live-tested against the same
// two real queries that exposed the bug ("Pigott Building", "Larry's
// Tavern") and resolves both correctly.
//
// Deliberately NOT using session tokens, despite Google's documentation
// describing them as the mechanism that makes Autocomplete cheap at scale.
// Live-verified directly against Google's own session-pricing
// documentation before this was built: a session only gets discounted
// billing if it's explicitly closed by a Place Details (New) or Address
// Validation call using the SAME session token -- "If a session is
// abandoned, meaning not terminated by a call to Place Details (New) or
// Address Validation, Autocomplete (New) requests revert to the
// per-request pricing model." This project's frontend has no such
// closing call in its Autocomplete flow (see resolveDestinationContract.ts
// for how a SELECTED suggestion gets resolved instead -- a plain Geocoding
// API call, deliberately not Place Details, so it never closes a session
// either). Generating a session token here without ever closing a session
// would accomplish nothing but look like it does -- exactly the silent,
// costly failure mode to avoid. Billed under the plain "Autocomplete
// Requests" SKU instead: 10,000 requests/month free, ~$2.83/1,000 beyond
// that (live-verified against Google's real pricing page).
//
// Deliberately stateless -- no cache read/write, no Supabase client at
// all, same reasoning as the original LocationIQ implementation: a partial
// autocomplete query is an ephemeral, per-keystroke artifact, not
// something a persistent cache would get meaningful hit-rate from.
const GOOGLE_PLACES_AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";

// Same fixed Seattle area as the original LocationIQ viewbox+bounded=1 --
// live-verified equivalent here: locationRestriction.rectangle genuinely
// EXCLUDES out-of-area results (not just a ranking preference like
// locationBias would be). Confirmed directly: a real "Golden Gate Bridge"
// query returns Google's real empty-result shape (`{}`) when restricted to
// this box, vs. a real match without it.
const SEATTLE_RESTRICTION = {
  rectangle: {
    low: { latitude: 47.49, longitude: -122.46 },
    high: { latitude: 47.73, longitude: -122.22 },
  },
};

// Shared across every Google-backed module in this project (also reused by
// resolveDestinationCoordinates.ts, a different Google product --
// Geocoding API, not Places -- but the same generic "a Google API request
// failed" semantics apply), the same way LocationIQRequestError is defined
// once (geocodeAddress.ts) and reused across every LocationIQ-backed
// module rather than redefined per file.
export class GoogleApiRequestError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "GoogleApiRequestError";
    this.retryable = retryable;
  }
}

function buildAutocompleteRequestBody(query: string): Record<string, unknown> {
  return { input: query, locationRestriction: SEATTLE_RESTRICTION };
}

// Live-verified real shape of a Places API (New) Autocomplete prediction.
// Deliberately narrow -- only the fields this module actually uses.
// `queryPrediction` (Google's OTHER real suggestion kind, offered only
// when includeQueryPredictions is explicitly requested) is never produced
// here, since that request field is never set.
interface GooglePlacePrediction {
  placePrediction?: {
    placeId: string;
    text: { text: string };
    structuredFormat?: {
      mainText?: { text: string };
      secondaryText?: { text: string };
    };
  };
}

// Live-verified real shape of a successful Autocomplete (New) response.
// `suggestions` is genuinely OMITTED entirely (not an empty array) on a
// real no-match -- live-confirmed directly: a real, deliberately
// unmatchable query returns HTTP 200 with body `{}`.
interface GooglePlacesAutocompleteResponse {
  suggestions?: GooglePlacePrediction[];
}

export interface DestinationSuggestion {
  placeId: string;
  displayText: string;
  displayAddress: string | null;
}

// Same shortened retry budget as the original LocationIQ implementation --
// deliberately 2 attempts (1 retry), not this project's usual 4. This is
// an interactive, low-latency, ephemeral request (fired on a debounced
// keystroke pause): a slow response here is worse than a missing one, and
// the very next debounced keystroke naturally retries anyway.
const MAX_FETCH_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_JITTER_MAX_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Google's own standard REST error-code semantics (the same
// google.rpc.Code convention live-confirmed on this endpoint's real 400
// responses -- see the INVALID_ARGUMENT status seen directly below): 429
// (RESOURCE_EXHAUSTED) and 5xx (transient server-side failures) are the
// documented retryable cases. A real 429 was deliberately NOT triggered
// live here -- doing so would mean deliberately hammering Google's API
// past its rate limit, not a responsible way to verify this -- so this
// follows Google's own documented status-code convention rather than a
// live-reproduced example, unlike every other status branch below.
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

async function fetchAutocompleteOnce(query: string, apiKey: string): Promise<GooglePlacePrediction[]> {
  const response = await fetch(GOOGLE_PLACES_AUTOCOMPLETE_URL, {
    method: "POST",
    headers: { "X-Goog-Api-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(buildAutocompleteRequestBody(query)),
  });

  if (!response.ok) {
    if (response.status === 400) {
      // Live-verified real shape, both real causes of a 400 on this
      // endpoint: a structurally invalid request (empty/missing `input`)
      // --
      //   {"error":{"code":400,"message":"input must be non-empty.\n","status":"INVALID_ARGUMENT"}}
      // -- and an invalid API key --
      //   {"error":{"code":400,"message":"API key not valid...","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID",...}]}}
      // -- indistinguishable by HTTP status alone. Both should be
      // unreachable in practice: this module's own caller already
      // enforces a 2-character minimum before ever reaching here, and the
      // API key is a fixed secret, not user input -- so a real 400 here
      // signals OUR bug (a validation gap or a misconfigured key), never
      // the caller's fault, mirroring geocodeAddress.ts's own "Invalid
      // Request" classification for the equivalent LocationIQ case.
      throw new GoogleApiRequestError(
        "autocompleteDestination: Google Places rejected the request as invalid -- should be unreachable given this module's own caller's validation",
        false,
      );
    }
    throw new GoogleApiRequestError(
      `autocompleteDestination: Google Places request failed with status ${response.status} ${response.statusText}`,
      isRetryableStatus(response.status),
    );
  }

  const body = (await response.json()) as GooglePlacesAutocompleteResponse;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error(`autocompleteDestination: unexpected Google Places response shape (expected a JSON object), got ${JSON.stringify(body)}`);
  }
  // Live-verified: suggestions is genuinely absent (not []) on a real
  // no-match -- see this module's own header comment.
  return body.suggestions ?? [];
}

async function fetchAutocompleteWithRetry(query: string, apiKey: string): Promise<GooglePlacePrediction[]> {
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      return await fetchAutocompleteOnce(query, apiKey);
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
        `autocompleteDestination: attempt ${attempt}/${MAX_FETCH_ATTEMPTS} failed (${reason}); retrying in ${delayMs.toFixed(0)}ms`,
      );
      await sleep(delayMs);
    }
  }

  throw new Error("autocompleteDestination: unreachable -- fetchAutocompleteWithRetry exhausted retries without a resolved result");
}

// A real placePrediction is always expected to carry structuredFormat.
// mainText (live-observed on every real result tested) -- but typed
// defensively (falling back to the always-present raw `text.text`) rather
// than assumed guaranteed by Google for every possible place type, the
// same defensive-fallback posture the original LocationIQ implementation
// took for display_place.
function toDestinationSuggestion(prediction: GooglePlacePrediction): DestinationSuggestion | null {
  const placePrediction = prediction.placePrediction;
  if (placePrediction === undefined) {
    // Would only occur if includeQueryPredictions were ever set (it never
    // is here) and Google returned a queryPrediction instead -- defensive,
    // not expected to happen in practice given this module's own fixed
    // request shape.
    return null;
  }
  return {
    placeId: placePrediction.placeId,
    displayText: placePrediction.structuredFormat?.mainText?.text ?? placePrediction.text.text,
    displayAddress: placePrediction.structuredFormat?.secondaryText?.text ?? null,
  };
}

// Resolves a partial destination query to a list of general place
// suggestions via Google's Places Autocomplete (New) endpoint. No cache,
// no Supabase client, no session token (see this module's own header
// comment for why) -- a stateless proxy. `apiKey` is an explicit
// parameter, not read internally, matching geocodeAddress.ts's
// runtime-agnosticism convention. Deliberately NO lat/lon on the returned
// suggestions -- Google's Autocomplete (New) API structurally doesn't
// provide coordinates on a prediction; see resolveDestinationCoordinates.ts
// for the separate, explicit resolve-on-selection step that does.
export async function autocompleteDestination(apiKey: string, query: string, limit: number): Promise<DestinationSuggestion[]> {
  const predictions = await fetchAutocompleteWithRetry(query, apiKey);
  const suggestions = predictions.map(toDestinationSuggestion).filter((s): s is DestinationSuggestion => s !== null);
  // Google's Autocomplete (New) API has no request-level result-count
  // parameter at all (live-verified against Google's own request-body
  // schema reference -- no such field exists), unlike LocationIQ's own
  // `limit` query param -- so the cap is applied here instead, after the
  // fact, rather than requested from Google directly.
  return suggestions.slice(0, limit);
}
