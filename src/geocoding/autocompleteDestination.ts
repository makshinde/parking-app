import { LocationIQRequestError } from "./geocodeAddress.ts";

// Proxies LocationIQ's real Autocomplete endpoint (live-verified: same API
// key, same viewbox/bounded biasing mechanism as forward search, but its
// own distinct response shape -- display_place/display_address fields
// forward search doesn't return, useful for a two-line "name, then
// address" suggestion row).
//
// Deliberately stateless -- no cache read/write, no Supabase client at
// all. Live-checked directly against LocationIQ's own ToS and pricing
// pages before this was built: Autocomplete is NOT a separately metered
// product or governed by separate terms ("A single request credit allows
// access to one Map View or one call to any of our APIs (Search, Reverse
// geocoding, Autocomplete, etc)" -- LocationIQ's own pricing page), so the
// same 48-hour-cache-or-forever-storage ToS clause technically covers it
// too. But a persistent cache isn't worth building here regardless: unlike
// a complete address or a coordinate (which many different real users
// genuinely converge on), a partial autocomplete query is an ephemeral,
// per-keystroke artifact ("p", "pi", "pik", "pike"...) that almost nobody
// else will ever type character-for-character. A persistent table would
// grow unbounded for a hit rate close to zero. The real request-volume
// control is the frontend's own debounce (fire only after a pause in
// typing) plus an in-memory, per-session Map on the frontend itself (no
// backend involvement) for the one realistic repeat case: backspacing
// back to a fragment already seen in the same typing session.
const LOCATIONIQ_AUTOCOMPLETE_URL = "https://us1.locationiq.com/v1/autocomplete";

// Same fixed Seattle viewbox as geocodeAddress.ts's forward search --
// live-verified this project's own investigation that bounded=1 is what
// actually restricts results to the area (viewbox alone is only a soft
// preference), reused verbatim here rather than re-deriving.
const SEATTLE_VIEWBOX = "-122.46,47.49,-122.22,47.73";

function buildAutocompleteUrl(query: string, limit: number, apiKey: string): string {
  const url = new URL(LOCATIONIQ_AUTOCOMPLETE_URL);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("viewbox", SEATTLE_VIEWBOX);
  url.searchParams.set("bounded", "1");
  return url.toString();
}

// Live-verified real shape of LocationIQ's autocomplete response: an array
// (like forward search, unlike reverse's single object), with
// display_place/display_address present alongside the same display_name/
// place_id/lat/lon fields forward search also returns.
interface LocationIQAutocompleteResult {
  place_id: string;
  lat: string;
  lon: string;
  display_name: string;
  display_place?: string;
  display_address?: string;
  [key: string]: unknown;
}

export interface DestinationSuggestion {
  placeId: string;
  displayName: string;
  displayPlace: string;
  displayAddress: string | null;
  lat: number;
  lon: number;
}

// Shortened retry budget -- deliberately 2 attempts (1 retry), not
// geocodeAddress.ts's MAX_FETCH_ATTEMPTS=4. This is an interactive,
// low-latency, ephemeral request (fired on a debounced keystroke pause):
// unlike a submitted search, a slow response here is worse than a missing
// one -- by the time a full 4-attempt exponential backoff finished (up to
// ~7s), the user has likely typed further and the response would already
// be stale. The very next debounced keystroke naturally retries anyway,
// so this endpoint doesn't need to work as hard to recover from a
// transient failure.
const MAX_FETCH_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_JITTER_MAX_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

// Live-confirmed real shape of LocationIQ's "no results" response for
// autocomplete: HTTP 404, {"error":"Unable to geocode"} -- the same shape
// forward/reverse search use. A genuine, valid outcome (an empty
// suggestion list), never retried or thrown.
function isNoMatchBody(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as Record<string, unknown>).error === "Unable to geocode";
}

// Live-confirmed real shape of LocationIQ's rejection of a structurally
// invalid request (tested directly against an empty query): HTTP 400,
// {"error":"Invalid Request"} -- distinct from the no-match shape above.
// This module's own caller (handleDestinationAutocompleteRequest.ts)
// enforces a 2-character minimum before ever reaching here, so this
// should be unreachable in practice -- treated as non-retryable (retrying
// an invalid request would just fail the same way again) and classified
// upstream as our own bug, not LocationIQ's fault, via this message.
function isInvalidRequestBody(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as Record<string, unknown>).error === "Invalid Request";
}

async function fetchAutocompleteOnce(url: string): Promise<LocationIQAutocompleteResult[]> {
  const response = await fetch(url);

  if (!response.ok) {
    if (response.status === 404) {
      const body: unknown = await response.json().catch(() => null);
      if (isNoMatchBody(body)) {
        return [];
      }
    }
    if (response.status === 400) {
      const body: unknown = await response.json().catch(() => null);
      if (isInvalidRequestBody(body)) {
        throw new LocationIQRequestError(
          "autocompleteDestination: LocationIQ rejected the request as invalid -- should be unreachable given this module's own caller's minimum-length validation",
          false,
        );
      }
    }
    throw new LocationIQRequestError(
      `autocompleteDestination: LocationIQ request failed with status ${response.status} ${response.statusText}`,
      isRetryableStatus(response.status),
    );
  }

  const body: unknown = await response.json();
  if (!Array.isArray(body)) {
    throw new Error(`autocompleteDestination: unexpected LocationIQ response shape (expected a JSON array), got ${JSON.stringify(body)}`);
  }
  return body as LocationIQAutocompleteResult[];
}

async function fetchAutocompleteWithRetry(url: string): Promise<LocationIQAutocompleteResult[]> {
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      return await fetchAutocompleteOnce(url);
    } catch (err) {
      const retryable = !(err instanceof LocationIQRequestError) || err.retryable;
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

function parseCoordinate(value: string, label: "lat" | "lon"): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new RangeError(`autocompleteDestination: LocationIQ returned a non-numeric ${label} ("${value}")`);
  }
  return parsed;
}

function toDestinationSuggestion(result: LocationIQAutocompleteResult): DestinationSuggestion {
  return {
    placeId: result.place_id,
    displayName: result.display_name,
    // Live-observed present on every real result tested, but typed
    // defensively (a plain string, falling back to display_name) rather
    // than assumed guaranteed by LocationIQ for every possible place type.
    displayPlace: result.display_place ?? result.display_name,
    displayAddress: result.display_address ?? null,
    lat: parseCoordinate(result.lat, "lat"),
    lon: parseCoordinate(result.lon, "lon"),
  };
}

// Resolves a partial destination query to a list of general place/address
// suggestions via LocationIQ's Autocomplete endpoint. No cache, no
// Supabase client -- a stateless proxy (see this file's own header
// comment for why). `apiKey` is an explicit parameter, not read
// internally, matching geocodeAddress.ts's runtime-agnosticism
// convention.
export async function autocompleteDestination(apiKey: string, query: string, limit: number): Promise<DestinationSuggestion[]> {
  const url = buildAutocompleteUrl(query, limit, apiKey);
  const results = await fetchAutocompleteWithRetry(url);
  return results.map(toDestinationSuggestion);
}
