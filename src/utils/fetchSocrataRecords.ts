export type SocrataRecord = Record<string, unknown>;

// Socrata's SODA API caps most datasets at 50000 rows per request; batching
// at that size keeps every request comfortably within the platform's limit
// regardless of the specific dataset being queried.
export const SOCRATA_PAGE_LIMIT = 50000;

// Keyset (:id-based) pagination, not $offset -- see streamArchiveWithResume.ts
// for the same approach, already proven against the yearly archive
// datasets. This module used to paginate via $offset, which was a real,
// live-confirmed bug against rke9-rsvs (the rolling window dataset, used by
// initializeAccumulators): rke9-rsvs is continuously growing, and an
// $offset position isn't anchored to anything -- if a page's request
// failed mid-stream and was retried (this module's own retry-with-backoff
// below), new rows inserted into the dataset in the meantime could shift
// what "offset N" now points to, causing the retry to return a different
// row set than the original attempt would have -- some rows counted twice,
// some skipped. A real production run hit exactly this: two mid-fetch
// retries during the rolling-window phase correlated with a confirmed 1-3%
// sample-count overcount in occupancy_stats, independently verified against
// direct Socrata queries. Keyset pagination is immune to this by
// construction: :id > cursor is anchored to a specific, already-seen row,
// so retrying the identical request always resolves to the same rows
// regardless of what else has been inserted elsewhere in the dataset.
// Live-verified against rke9-rsvs directly (not assumed to work just
// because the archive datasets support it): it exposes the same :id system
// field, in the same "row-xxxx" format, and $where=:id > cursor&$order=:id
// pagination behaves identically.
function buildQueryUrl(datasetUrl: string, whereClause: string, cursorId: string | null): string {
  const url = new URL(datasetUrl);
  // SoQL requires a star selection to come first in the select-list --
  // live-verified against the real API (see streamArchiveWithResume.ts):
  // "*,:id" succeeds, ":id,*" fails with query.compiler.malformed.
  url.searchParams.set("$select", "*,:id");
  url.searchParams.set("$order", ":id");
  url.searchParams.set("$limit", String(SOCRATA_PAGE_LIMIT));
  // Parenthesized so an AND'd :id condition can't have its precedence
  // changed by whatever the caller's own whereClause contains (e.g. an OR).
  const combinedWhere = cursorId !== null ? `(${whereClause}) AND :id > '${cursorId}'` : whereClause;
  url.searchParams.set("$where", combinedWhere);
  return url.toString();
}

// Socrata's own per-row system identifier (e.g. "row-km8v~rgdh.iue6"),
// requested via $select above. Every row genuinely has one, so a missing or
// malformed value here signals a real problem with the response, not an
// expected case to handle gracefully -- same reasoning
// streamArchiveWithResume.ts's getRecordId uses.
function getRecordId(record: SocrataRecord): string {
  const id = record[":id"];
  if (typeof id !== "string" || id.trim() === "") {
    throw new Error(`fetchSocrataRecords: row missing a valid :id field, got ${JSON.stringify(id)}`);
  }
  return id;
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

// Marks the one kind of failure this module can identify with certainty as
// non-transient: a successfully-received response carrying a 4xx status.
// The request itself is wrong (bad $where clause, bad URL) -- retrying it
// will fail identically every time, so it should fail immediately instead
// of wasting time on doomed retries. Every other failure mode (fetch()
// failing to connect, response.json() failing to read/parse the body, or
// anything else not explicitly classified here) is left to propagate as
// whatever error it naturally is and defaults to retryable in fetchPage's
// catch block below -- see that function's comment for why.
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
  const response = await fetch(url, { headers: buildRequestHeaders() });

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

  return (await response.json()) as SocrataRecord[];
}

async function fetchPage(datasetUrl: string, whereClause: string, cursorId: string | null): Promise<SocrataRecord[]> {
  const url = buildQueryUrl(datasetUrl, whereClause, cursorId);

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      return await fetchPageOnce(url);
    } catch (err) {
      // The one deliberate non-transient case is a SocrataRequestError
      // explicitly marked non-retryable (a successfully-received 4xx --
      // see fetchPageOnce and SocrataRequestError's comment). Everything
      // else defaults to retryable: fetch() failing to connect,
      // response.json() failing to read/parse the body (live-observed:
      // undici's "TypeError: terminated" wrapping an ECONNRESET mid-stream,
      // well after fetch() itself already resolved with response.ok ===
      // true), or any other exception this sequence isn't specifically
      // anticipating. A network-layer failure is far more likely to be
      // transient than to be a bug that retrying will just repeat, so an
      // unrecognized failure is safer to retry than to give up on
      // immediately.
      const retryable = !(err instanceof SocrataRequestError) || err.retryable;
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
// automatically following :id-keyset pagination (no $offset -- see
// buildQueryUrl's comment for why).
export async function fetchSocrataRecords(datasetUrl: string, whereClause: string): Promise<SocrataRecord[]> {
  const allRecords: SocrataRecord[] = [];
  let cursorId: string | null = null;

  while (true) {
    const page = await fetchPage(datasetUrl, whereClause, cursorId);
    allRecords.push(...page);

    // A page with fewer rows than the limit is necessarily the last page.
    // A page with exactly SOCRATA_PAGE_LIMIT rows might still be the last
    // page -- a dataset can happen to have a row count that's an exact
    // multiple of the page size -- and row count alone can't distinguish
    // that from "there's more." So this always requests the next page
    // after a full page and relies on an empty (or short) page to stop,
    // rather than assuming either a full page always means more, or that
    // a full page is necessarily the end.
    if (page.length < SOCRATA_PAGE_LIMIT) {
      break;
    }

    cursorId = getRecordId(page[page.length - 1] as SocrataRecord);
  }

  return allRecords;
}

// Same $where/:id-keyset pagination as fetchSocrataRecords, but hands each
// page to onPage as soon as it arrives instead of accumulating every page
// into one array -- for datasets too large to hold entirely in memory at
// once (live-verified: fetchSocrataRecords itself OOM'd, ~2GB heap,
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
  let cursorId: string | null = null;

  while (true) {
    const page = await fetchPage(datasetUrl, whereClause, cursorId);
    await onPage(page);

    // Same short-page stopping rule as fetchSocrataRecords -- see its own
    // comment for why an exact-SOCRATA_PAGE_LIMIT page still gets one more
    // (possibly empty) request rather than assuming it's the last page.
    if (page.length < SOCRATA_PAGE_LIMIT) {
      break;
    }

    cursorId = getRecordId(page[page.length - 1] as SocrataRecord);
  }
}
