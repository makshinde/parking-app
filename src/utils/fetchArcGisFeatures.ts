export interface ArcGisFeature {
  attributes: Record<string, unknown>;
  geometry?: Record<string, unknown>;
}

interface ArcGisQueryResponse {
  features: ArcGisFeature[];
  exceededTransferLimit?: boolean;
}

// ArcGIS FeatureServer layers commonly cap a single query response well
// below this, so requesting a fixed page size keeps every request under
// that cap regardless of the specific server's configured limit.
const PAGE_SIZE = 1000;

function buildQueryUrl(
  featureServerUrl: string,
  layerId: number,
  whereClause: string,
  outFields: string,
  resultOffset: number,
): string {
  const url = new URL(`${featureServerUrl.replace(/\/+$/, "")}/${layerId}/query`);
  url.searchParams.set("where", whereClause);
  url.searchParams.set("outFields", outFields);
  url.searchParams.set("f", "json");
  url.searchParams.set("resultRecordCount", String(PAGE_SIZE));
  url.searchParams.set("resultOffset", String(resultOffset));
  return url.toString();
}

async function fetchPage(
  featureServerUrl: string,
  layerId: number,
  whereClause: string,
  outFields: string,
  resultOffset: number,
): Promise<ArcGisQueryResponse> {
  const url = buildQueryUrl(featureServerUrl, layerId, whereClause, outFields, resultOffset);
  const response = await fetch(url);

  // A partial result set here would be silently wrong data, not a usable
  // best-effort answer -- there's no meaningful "partial success" to return,
  // so this fails loudly instead of returning whichever pages happened to
  // succeed before the failure.
  if (!response.ok) {
    throw new Error(
      `fetchArcGisFeatures: request to ${url} failed with status ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as ArcGisQueryResponse;
}

// layerId identifies one specific layer within the FeatureServer; there's no
// meaningful "nearest valid" layer for a negative or non-integer id, so this
// throws rather than clamping (same reasoning as jsDayToIsoDay).
function assertValidLayerId(layerId: number): void {
  if (!Number.isInteger(layerId) || layerId < 0) {
    throw new RangeError(`fetchArcGisFeatures: layerId must be a non-negative integer, got ${layerId}`);
  }
}

// Queries an ArcGIS FeatureServer layer and returns every matching feature,
// automatically following pagination until the server stops reporting
// exceededTransferLimit (or a page comes back with no features, as a
// defensive stop in case a server omits the flag on its final page).
export async function fetchArcGisFeatures(
  featureServerUrl: string,
  layerId: number,
  whereClause: string,
  outFields: string,
): Promise<ArcGisFeature[]> {
  assertValidLayerId(layerId);

  const allFeatures: ArcGisFeature[] = [];
  let resultOffset = 0;

  while (true) {
    const page = await fetchPage(featureServerUrl, layerId, whereClause, outFields, resultOffset);
    allFeatures.push(...page.features);

    if (!page.exceededTransferLimit || page.features.length === 0) {
      break;
    }

    resultOffset += page.features.length;
  }

  return allFeatures;
}
