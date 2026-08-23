export type SocrataRecord = Record<string, unknown>;

// Socrata's SODA API caps most datasets at 50000 rows per request; batching
// at that size keeps every request comfortably within the platform's limit
// regardless of the specific dataset being queried.
export const SOCRATA_PAGE_LIMIT = 50000;

function buildQueryUrl(datasetUrl: string, whereClause: string, offset: number): string {
  const url = new URL(datasetUrl);
  url.searchParams.set("$where", whereClause);
  url.searchParams.set("$limit", String(SOCRATA_PAGE_LIMIT));
  url.searchParams.set("$offset", String(offset));
  return url.toString();
}

// Socrata heavily rate-limits unauthenticated requests, shared across every
// anonymous caller hitting their API at once -- fine for occasional
// one-off imports, but not for the volume of requests the occupancy batch
// aggregation job makes (see CLAUDE.md's Architecture section). An app
// token is free (register at data.seattle.gov) and moves requests onto
// their own per-token limit instead of the shared anonymous one. Entirely
// optional: requests still succeed without one, just against that lower,
// shared limit -- so this returns an empty headers object rather than
// throwing when the env var isn't set.
export function buildRequestHeaders(): HeadersInit {
  const token = process.env.SOCRATA_APP_TOKEN;
  if (token === undefined || token.trim() === "") {
    return {};
  }
  return { "X-App-Token": token };
}

// A page can fail for reasons that have nothing to do with the request
// itself -- a dropped connection, or a transient 502/503 from Socrata (both
// live-observed during real multi-million-row runs). Those are worth
// retrying. A 4xx, on the other hand, means the request itself is wrong
// (bad $where clause, bad URL) -- retrying it will fail identically every
// time, so it should fail immediately instead of wasting time on doomed
// retries.
class SocrataRequestError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "SocrataRequestError";
    this.retryable = retryable;
  }
}

// One initial attempt plus up to 3 retries.
export const MAX_FETCH_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 && status < 600;
}

async function fetchPageOnce(url: string): Promise<SocrataRecord[]> {
  let response: Response;
  try {
    response = await fetch(url, { headers: buildRequestHeaders() });
  } catch (err) {
    // A thrown fetch (network failure, DNS error, connection reset) is
    // always transient -- there's no status code to inspect, but there's
    // also no reason to believe retrying won't work.
    const message = err instanceof Error ? err.message : String(err);
    throw new SocrataRequestError(`fetchSocrataRecords: request to ${url} failed: ${message}`, true);
  }

  // A partial result set here would be silently wrong data, not a usable
  // best-effort answer -- there's no meaningful "partial success" to return,
  // so this fails loudly instead of returning whichever pages happened to
  // succeed before the failure.
  if (!response.ok) {
    throw new SocrataRequestError(
      `fetchSocrataRecords: request to ${url} failed with status ${response.status} ${response.statusText}`,
      isRetryableStatus(response.status),
    );
  }

  try {
    return (await response.json()) as SocrataRecord[];
  } catch (err) {
    // The connection can drop mid-body-read even after a successful status
    // line -- live-verified: undici throws "TypeError: terminated" (wrapping
    // an ECONNRESET) while streaming/parsing the body, well after fetch()
    // itself already resolved with response.ok === true. Just as transient
    // as a connection failure before the request even went out, so it's
    // retried the same way rather than being left unclassified.
    const message = err instanceof Error ? err.message : String(err);
    throw new SocrataRequestError(
      `fetchSocrataRecords: request to ${url} failed while reading the response body: ${message}`,
      true,
    );
  }
}

async function fetchPage(datasetUrl: string, whereClause: string, offset: number): Promise<SocrataRecord[]> {
  const url = buildQueryUrl(datasetUrl, whereClause, offset);

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      return await fetchPageOnce(url);
    } catch (err) {
      const retryable = err instanceof SocrataRequestError ? err.retryable : false;
      const isLastAttempt = attempt === MAX_FETCH_ATTEMPTS;
      if (!retryable || isLastAttempt) {
        throw err;
      }

      // Exponential backoff (1s, 2s, 4s) rather than a fixed delay, so a
      // sustained outage backs off instead of hammering an already-struggling
      // server at a constant rate.
      const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `fetchSocrataRecords: attempt ${attempt}/${MAX_FETCH_ATTEMPTS} failed (${reason}); retrying in ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }

  // Unreachable: the loop above always either returns a page or throws on
  // its final iteration.
  throw new Error("fetchSocrataRecords: fetchPage exhausted retries without a resolved result");
}

// Queries a Socrata (SODA) API dataset and returns every matching record,
// automatically following $limit/$offset pagination.
export async function fetchSocrataRecords(datasetUrl: string, whereClause: string): Promise<SocrataRecord[]> {
  const allRecords: SocrataRecord[] = [];
  let offset = 0;

  while (true) {
    const page = await fetchPage(datasetUrl, whereClause, offset);
    allRecords.push(...page);

    // A page with fewer rows than the limit is necessarily the last page.
    // A page with exactly SOCRATA_PAGE_LIMIT rows might still be the last
    // page -- a dataset can happen to have a row count that's an exact
    // multiple of the page size -- and row count alone can't distinguish
    // that from "there's more." So this always requests the next offset
    // after a full page and relies on an empty (or short) page to stop,
    // rather than assuming either a full page always means more, or that
    // a full page is necessarily the end.
    if (page.length < SOCRATA_PAGE_LIMIT) {
      break;
    }

    offset += SOCRATA_PAGE_LIMIT;
  }

  return allRecords;
}

// Same $where/$limit/$offset pagination as fetchSocrataRecords, but hands
// each page to onPage as soon as it arrives instead of accumulating every
// page into one array -- for datasets too large to hold entirely in memory
// at once (live-verified: fetchSocrataRecords itself OOM'd, ~2GB heap,
// wholesale-fetching the 27,080,827-row rolling window dataset -- see
// CLAUDE.md's Architecture section). onPage is awaited before the next
// page is fetched, so at most one page's worth of raw records is ever held
// in memory at a time, on top of whatever the caller's own onPage does with
// each page (e.g. fold it into a running accumulator and discard it).
export async function fetchSocrataRecordsPaginated(
  datasetUrl: string,
  whereClause: string,
  onPage: (page: SocrataRecord[]) => Promise<void> | void,
): Promise<void> {
  let offset = 0;

  while (true) {
    const page = await fetchPage(datasetUrl, whereClause, offset);
    await onPage(page);

    // Same short-page stopping rule as fetchSocrataRecords -- see its own
    // comment for why an exact-SOCRATA_PAGE_LIMIT page still gets one more
    // (possibly empty) request rather than assuming it's the last page.
    if (page.length < SOCRATA_PAGE_LIMIT) {
      break;
    }

    offset += SOCRATA_PAGE_LIMIT;
  }
}
