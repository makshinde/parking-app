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

async function fetchPage(datasetUrl: string, whereClause: string, offset: number): Promise<SocrataRecord[]> {
  const url = buildQueryUrl(datasetUrl, whereClause, offset);
  const response = await fetch(url);

  // A partial result set here would be silently wrong data, not a usable
  // best-effort answer -- there's no meaningful "partial success" to return,
  // so this fails loudly instead of returning whichever pages happened to
  // succeed before the failure.
  if (!response.ok) {
    throw new Error(
      `fetchSocrataRecords: request to ${url} failed with status ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as SocrataRecord[];
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
