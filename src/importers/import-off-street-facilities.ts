import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import type { ArcGisFeature } from "../utils/fetchArcGisFeatures.ts";
import { fetchArcGisFeatures } from "../utils/fetchArcGisFeatures.ts";
import { formatPointForPostgis } from "./formatPointForPostgis.ts";
import { parseRateValue } from "./parseRateValue.ts";
import type { SupabaseQueryResult, SupabaseTableBuilder } from "./upsertBlockface.ts";

// Live-verified live FeatureServer endpoint (see CLAUDE.md's Known open
// questions -- field names were cross-checked against this directly before
// this script was written). Layer 1, not 0: unlike the blockfaces sources,
// this FeatureServer's only feature layer is registered at id 1.
const FEATURE_SERVER_URL =
  "https://services.arcgis.com/ZOyb2t4B0UYuYNYH/ArcGIS/rest/services/Public_Garages_and_Parking_Lots/FeatureServer";
const LAYER_ID = 1;

type DurationType = "1HR" | "2HR" | "3HR" | "ALLDAY";

// Maps each duration_type to the source field carrying its raw rate text.
// Live-verified against a 700-record pull of the real FeatureServer: each
// field is independently populated for only ~3-4% of records (consistent
// with CLAUDE.md's existing "~2-4% coverage on rate" note) and they're 4
// genuinely separate values, not 4 readings of one -- e.g. one real record
// has RTE_1HR="3", RTE_2HR="6", RTE_3HR="9", RTE_ALLDAY=null. This is what
// motivated off_street_rate_tiers (migrations/008) over a single rate column.
const RATE_FIELDS: ReadonlyArray<{ durationType: DurationType; sourceField: string }> = [
  { durationType: "1HR", sourceField: "RTE_1HR" },
  { durationType: "2HR", sourceField: "RTE_2HR" },
  { durationType: "3HR", sourceField: "RTE_3HR" },
  { durationType: "ALLDAY", sourceField: "RTE_ALLDAY" },
];

function createSupabaseClient(url: string, serviceRoleKey: string) {
  return createClient(url, serviceRoleKey);
}

// Same DI pattern as import-blockfaces.ts's ImportSupabaseClient: extends
// upsertBlockface.ts's minimal, table-name-generic SupabaseClientLike with
// the one extra read (.select().eq().maybeSingle()) this file needs for its
// own created-vs-updated bookkeeping. Only a single .eq() here, not the two
// chained ones import-blockfaces.ts needs -- off_street_facilities upserts
// on the single column source_facility_id, not a composite key.
export interface ImportSupabaseTableBuilder extends SupabaseTableBuilder {
  select(columns: string): {
    eq(column: string, value: unknown): {
      maybeSingle(): PromiseLike<SupabaseQueryResult<{ id: string }>>;
    };
  };
}

export interface ImportSupabaseClient {
  from(table: string): ImportSupabaseTableBuilder;
}

const DEFAULT_LIMIT = 5;

export interface CliOptions {
  limit: number | null;
}

export function parseCliOptions(argv: string[]): CliOptions {
  let limit: number | null = DEFAULT_LIMIT;

  for (const arg of argv) {
    if (arg === "--all") {
      limit = null;
      continue;
    }

    const match = /^--limit=(.+)$/.exec(arg);
    if (match === null) {
      continue;
    }
    const [, rawLimit] = match;
    if (rawLimit === undefined) {
      throw new Error("import-off-street-facilities: unreachable -- --limit regex matched without a capture group");
    }

    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`import-off-street-facilities: --limit must be a positive integer, got "${rawLimit}"`);
    }
    limit = parsed;
  }

  return { limit };
}

function getRequiredEnvVar(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`import-off-street-facilities: missing required environment variable ${name} (see .env.example)`);
  }
  return value;
}

function getRequiredNumberAttribute(feature: ArcGisFeature, key: string, context: string): number {
  const value = feature.attributes[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`import-off-street-facilities: ${context} -- expected a finite number for "${key}", got ${JSON.stringify(value)}`);
  }
  return value;
}

function getOptionalNumberAttribute(feature: ArcGisFeature, key: string, context: string): number | null {
  const value = feature.attributes[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`import-off-street-facilities: ${context} -- expected a finite number for "${key}", got ${JSON.stringify(value)}`);
  }
  return value;
}

// Empty string is treated the same as null/undefined (not a distinct "set
// but blank" value) -- source records use both inconsistently for "no data".
function getOptionalStringAttribute(feature: ArcGisFeature, key: string, context: string): string | null {
  const value = feature.attributes[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`import-off-street-facilities: ${context} -- expected a string for "${key}", got ${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function getRequiredGeometryCoordinate(feature: ArcGisFeature, axis: "x" | "y", context: string): number {
  const value = feature.geometry?.[axis];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`import-off-street-facilities: ${context} -- expected a finite number for geometry.${axis}, got ${JSON.stringify(value)}`);
  }
  return value;
}

export interface OffStreetFacilityRow {
  source_facility_id: string;
  name: string;
  location: string;
  address: string | null;
  capacity: number | null;
  facility_type: string | null;
  operator_name: string | null;
}

export interface OffStreetRateTierRow {
  duration_type: DurationType;
  rate_usd: number | null;
  rate_note: string | null;
}

export interface MappedFacility {
  facility: OffStreetFacilityRow;
  rateTiers: OffStreetRateTierRow[];
}

// Pure mapping from one raw ArcGIS feature to the rows this script writes --
// no network/DB calls, so this is exercised directly by tests without a
// mock Supabase client, same separation import-blockfaces.ts keeps between
// assembleBlockface (pure) and processElement (I/O).
export function mapFeatureToFacility(feature: ArcGisFeature, context: string): MappedFacility {
  // BUSLIC_LOCATION_ID, not BUSLIC_ID: matches schema.sql's own description
  // of source_facility_id ("e.g. its business-license location ID").
  // Live-verified: 100% populated in a 700-record sample, but not always
  // unique (685/700 distinct) -- every duplicate found was byte-for-byte the
  // same facility (same name/address/geometry, different OBJECTID/GlobalID),
  // so re-upserting a duplicate under the same key just overwrites with
  // identical data. Harmless under ON CONFLICT, not worth deduplicating here.
  const sourceFacilityId = String(getRequiredNumberAttribute(feature, "BUSLIC_LOCATION_ID", context));

  // DEA_FACILITY_NAME preferred over FAC_NAME: live-verified both are
  // populated for nearly every record (99.7% vs 98.9% in the same sample,
  // with zero records missing both), but where they differ, DEA_FACILITY_NAME
  // reads as the more canonical business-license name (e.g. "AMAZON PHASE 1B
  // - 81866" vs FAC_NAME's "AMAZON PHASE 1B #81866" -- same facility,
  // DEA_FACILITY_NAME's formatting matches the license record). FAC_NAME is
  // only a fallback for the rare record missing DEA_FACILITY_NAME.
  const name =
    getOptionalStringAttribute(feature, "DEA_FACILITY_NAME", context) ??
    getOptionalStringAttribute(feature, "FAC_NAME", context);
  if (name === null) {
    throw new Error(`import-off-street-facilities: ${context} -- missing both DEA_FACILITY_NAME and FAC_NAME`);
  }

  const x = getRequiredGeometryCoordinate(feature, "x", context);
  const y = getRequiredGeometryCoordinate(feature, "y", context);
  const location = formatPointForPostgis(x, y);

  const address = getOptionalStringAttribute(feature, "DEA_FACILITY_ADDRESS", context);
  const capacity = getOptionalNumberAttribute(feature, "DEA_STALLS", context);
  // FAC_TYPE's only observed non-null values ('GARAGE', 'SURFACE LOT') match
  // off_street_facilities.facility_type's CHECK constraint exactly, so this
  // is passed through as-is; the database enforces the constraint on write,
  // and any future unexpected value surfaces there as a clear failure rather
  // than a second, easy-to-drift validation copied into this file.
  const facility_type = getOptionalStringAttribute(feature, "FAC_TYPE", context);
  const operator_name = getOptionalStringAttribute(feature, "OP_NAME", context);

  const rateTiers: OffStreetRateTierRow[] = [];
  for (const { durationType, sourceField } of RATE_FIELDS) {
    const raw = getOptionalStringAttribute(feature, sourceField, context);
    const parsed = parseRateValue(raw);
    // Skip entirely, don't write a rate/note-null row -- a null source field
    // means "this duration type isn't offered here," not "offered at an
    // unknown rate," so there's nothing meaningful to record for it.
    if (parsed.rate === null && parsed.note === null) {
      continue;
    }
    rateTiers.push({ duration_type: durationType, rate_usd: parsed.rate, rate_note: parsed.note });
  }

  return {
    facility: { source_facility_id: sourceFacilityId, name, location, address, capacity, facility_type, operator_name },
    rateTiers,
  };
}

export interface UpsertOffStreetFacilityResult {
  facilityId: string;
}

function describeFacility(facility: { source_facility_id: string }, facilityId?: string): string {
  const idPart = facilityId !== undefined ? `, id=${facilityId}` : "";
  return `source_facility_id=${facility.source_facility_id}${idPart}`;
}

function buildFacilityRow(facility: OffStreetFacilityRow): Record<string, unknown> {
  return {
    source_facility_id: facility.source_facility_id,
    name: facility.name,
    location: facility.location,
    address: facility.address,
    capacity: facility.capacity,
    facility_type: facility.facility_type,
    operator_name: facility.operator_name,
  };
}

// Writes one facility and its full rate-tier set to Supabase. Same
// upsert-then-replace-all pattern as upsertBlockface.ts, for the same
// reason: off_street_rate_tiers has no natural per-tier key to diff old vs
// new individually (a duration type's rate can change or disappear between
// import runs), so this deletes every existing off_street_rate_tiers row
// for this facility_id, then inserts the freshly parsed set. The two
// operations aren't transactional (this client interface exposes none), so
// a rate_tiers failure after a successful facilities upsert leaves real
// partial state behind -- thrown as an explicit, identified error rather
// than swallowed, so the caller knows this specific facility needs re-running.
export async function upsertOffStreetFacility(
  supabaseClient: ImportSupabaseClient,
  facility: OffStreetFacilityRow,
  rateTiers: OffStreetRateTierRow[],
): Promise<UpsertOffStreetFacilityResult> {
  const { data: upsertedFacility, error: facilityError } = await supabaseClient
    .from("off_street_facilities")
    .upsert(buildFacilityRow(facility), { onConflict: "source_facility_id" })
    .select("id")
    .single();

  if (facilityError !== null || upsertedFacility === null) {
    throw new Error(
      `upsertOffStreetFacility: off_street_facilities upsert failed for ${describeFacility(facility)}: ${facilityError?.message ?? "no row returned"}`,
    );
  }

  const facilityId = upsertedFacility.id;

  const { error: deleteError } = await supabaseClient
    .from("off_street_rate_tiers")
    .delete()
    .eq("facility_id", facilityId);

  if (deleteError !== null) {
    throw new Error(
      `upsertOffStreetFacility: off_street_facilities upsert succeeded (${describeFacility(facility, facilityId)}) but deleting its existing off_street_rate_tiers failed: ${deleteError.message}. Partial failure -- the facility row was written but off_street_rate_tiers may still hold stale data; re-run the import for this facility.`,
    );
  }

  if (rateTiers.length === 0) {
    return { facilityId };
  }

  const { error: insertError } = await supabaseClient
    .from("off_street_rate_tiers")
    .insert(rateTiers.map((tier) => ({ ...tier, facility_id: facilityId })));

  if (insertError !== null) {
    throw new Error(
      `upsertOffStreetFacility: off_street_facilities upsert succeeded (${describeFacility(facility, facilityId)}) and its old off_street_rate_tiers were deleted, but inserting the new set failed: ${insertError.message}. Partial failure -- the facility now has zero off_street_rate_tiers; re-run the import for this facility.`,
    );
  }

  return { facilityId };
}

export interface FacilityOutcome {
  sourceFacilityId: string;
}

export interface SkippedRecord {
  sourceFacilityId: string | null;
  reason: string;
}

export interface ImportSummary {
  created: FacilityOutcome[];
  updated: FacilityOutcome[];
  skipped: SkippedRecord[];
  failed: SkippedRecord[];
}

export function createEmptySummary(): ImportSummary {
  return { created: [], updated: [], skipped: [], failed: [] };
}

// Mirrors import-blockfaces.ts's blockfaceAlreadyExists: ON CONFLICT DO
// UPDATE doesn't expose insert-vs-update on its own, so this checks first,
// purely for the run summary -- it doesn't touch upsertOffStreetFacility's
// own contract.
export async function facilityAlreadyExists(
  supabaseClient: ImportSupabaseClient,
  sourceFacilityId: string,
): Promise<boolean> {
  const { data, error } = await supabaseClient
    .from("off_street_facilities")
    .select("id")
    .eq("source_facility_id", sourceFacilityId)
    .maybeSingle();

  if (error !== null) {
    throw new Error(
      `import-off-street-facilities: checking for an existing off_street_facilities row failed for source_facility_id=${sourceFacilityId}: ${error.message}`,
    );
  }

  return data !== null;
}

function featureContext(feature: ArcGisFeature): string {
  const objectId = feature.attributes.OBJECTID;
  return `OBJECTID ${typeof objectId === "number" ? objectId : "unknown"}`;
}

export async function processFeature(
  supabaseClient: ImportSupabaseClient,
  feature: ArcGisFeature,
  summary: ImportSummary,
): Promise<void> {
  let mapped: MappedFacility;
  try {
    mapped = mapFeatureToFacility(feature, featureContext(feature));
  } catch (error) {
    summary.skipped.push({
      sourceFacilityId: null,
      reason: `mapFeatureToFacility failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }

  try {
    const alreadyExisted = await facilityAlreadyExists(supabaseClient, mapped.facility.source_facility_id);
    await upsertOffStreetFacility(supabaseClient, mapped.facility, mapped.rateTiers);
    const outcome: FacilityOutcome = { sourceFacilityId: mapped.facility.source_facility_id };
    if (alreadyExisted) {
      summary.updated.push(outcome);
    } else {
      summary.created.push(outcome);
    }
  } catch (error) {
    summary.failed.push({
      sourceFacilityId: mapped.facility.source_facility_id,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function logSummary(summary: ImportSummary): void {
  console.log("\n=== import-off-street-facilities summary ===");
  console.log(`Created:     ${summary.created.length}`);
  console.log(`Updated:     ${summary.updated.length}`);
  console.log(`Skipped:     ${summary.skipped.length}`);
  for (const skip of summary.skipped) {
    console.log(`  - ${skip.sourceFacilityId ?? "(unmapped)"}: ${skip.reason}`);
  }
  console.log(`Failed:      ${summary.failed.length}`);
  for (const failure of summary.failed) {
    console.log(`  - ${failure.sourceFacilityId ?? "(unmapped)"}: ${failure.reason}`);
  }
  console.log("==============================================\n");
}

export async function main(): Promise<void> {
  const { limit } = parseCliOptions(process.argv.slice(2));
  console.log(limit === null ? "Running with no limit (--all)." : `Running with limit=${limit} (default is ${DEFAULT_LIMIT}; pass --limit=<n> or --all to override).`);

  const supabaseUrl = getRequiredEnvVar("SUPABASE_URL");
  const supabaseServiceRoleKey = getRequiredEnvVar("SUPABASE_SERVICE_ROLE_KEY");
  // Same unavoidable cast as import-blockfaces.ts, same reason: TS2589
  // "excessively deep" generic recursion against the real client's types,
  // not a real structural mismatch -- the method chains used here
  // (.from().upsert().select().single(), .from().delete().eq(),
  // .from().insert(), .from().select().eq().maybeSingle()) are all
  // standard, stable parts of the PostgREST client.
  const supabaseClient = createSupabaseClient(supabaseUrl, supabaseServiceRoleKey) as unknown as ImportSupabaseClient;

  console.log("Fetching Public Garages and Parking Lots records...");
  const features = await fetchArcGisFeatures(FEATURE_SERVER_URL, LAYER_ID, "1=1", "*");
  console.log(`Fetched ${features.length} records.`);

  const featuresToProcess = limit === null ? features : features.slice(0, limit);
  console.log(`Processing ${featuresToProcess.length} of ${features.length} total records.`);

  const summary = createEmptySummary();
  for (const feature of featuresToProcess) {
    await processFeature(supabaseClient, feature, summary);
  }

  logSummary(summary);
}

// Same pathToFileURL-based direct-execution guard as import-blockfaces.ts --
// see that file's comment for why a naive `file://${path}` template string
// doesn't work (this repo's own path contains a space).
const isRunDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isRunDirectly) {
  main().catch((error: unknown) => {
    console.error("import-off-street-facilities: fatal error:", error);
    process.exitCode = 1;
  });
}
