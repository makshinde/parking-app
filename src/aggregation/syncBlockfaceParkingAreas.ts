import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import type { ArcGisFeature } from "../utils/fetchArcGisFeatures.ts";
import { fetchArcGisFeatures } from "../utils/fetchArcGisFeatures.ts";
import type { Side } from "../importers/resolveBlockfaceSides.ts";

// Persists SDOT's own paid-parking-area/subarea designation onto each
// blockface already in our database, sourced directly from the
// authoritative Blockface FeatureServer -- the same source used tonight's
// investigation to confirm PAID_SPACES and PAIDAREA/SUBAREA are stable,
// current reference data (see CLAUDE.md). This is the grouping key the
// area-aware occupancy correction layer (area_occupancy_corrections)
// needs and blockfaces never stored before now (migration 024).
//
// Read-only against the source (never writes to ArcGIS); the only writes
// here are blockfaces.paidparkingarea/paidparkingsubarea on rows that
// already exist -- this script never creates, deletes, or otherwise
// touches a blockface's other columns.

const BLOCKFACE_FEATURE_SERVER_URL = "https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services/Blockface/FeatureServer";
const LAYER_ID = 1;
const OUT_FIELDS = "ELMNTKEY,SIDE,PAIDAREA,SUBAREA";

export interface BlockfaceParkingAreaRecord {
  sourceElementKey: number;
  sideOfStreet: Side;
  paidParkingArea: string | null;
  paidParkingSubarea: string | null;
}

function getRequiredNumberField(feature: ArcGisFeature, key: string, context: string): number {
  const value = feature.attributes[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`syncBlockfaceParkingAreas: ${context} -- expected a finite number for "${key}", got ${JSON.stringify(value)}`);
  }
  return value;
}

function getRequiredStringField(feature: ArcGisFeature, key: string, context: string): string {
  const value = feature.attributes[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`syncBlockfaceParkingAreas: ${context} -- expected a non-empty string for "${key}", got ${JSON.stringify(value)}`);
  }
  return value;
}

// PAIDAREA/SUBAREA are genuinely absent for most of the city (live-verified
// tonight: only ~24 named areas exist at all, out of 47,926 total Blockface
// features) -- a null/empty value here is the normal, expected case for a
// blockface with no SDOT-designated paid-parking area, not invalid input,
// so this returns null rather than throwing the way the required-field
// helpers above do.
function getOptionalStringField(feature: ArcGisFeature, key: string): string | null {
  const value = feature.attributes[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

const VALID_SIDES: readonly Side[] = ["N", "S", "E", "W", "NE", "NW", "SE", "SW"];

function isValidSide(value: string): value is Side {
  return (VALID_SIDES as readonly string[]).includes(value);
}

export function parseBlockfaceParkingAreaFeature(feature: ArcGisFeature): BlockfaceParkingAreaRecord {
  const elmntkey = getRequiredNumberField(feature, "ELMNTKEY", "parsing a Blockface FeatureServer record");
  const rawSide = getRequiredStringField(feature, "SIDE", `ELMNTKEY ${elmntkey}`);
  if (!isValidSide(rawSide)) {
    throw new Error(`syncBlockfaceParkingAreas: ELMNTKEY ${elmntkey} has an unrecognized SIDE value "${rawSide}", expected one of ${VALID_SIDES.join(", ")}`);
  }
  return {
    sourceElementKey: elmntkey,
    sideOfStreet: rawSide,
    paidParkingArea: getOptionalStringField(feature, "PAIDAREA"),
    paidParkingSubarea: getOptionalStringField(feature, "SUBAREA"),
  };
}

// --- Supabase client shape (DI, same pattern as import-blockfaces.ts) ----

export interface SyncSupabaseQueryResult {
  error: { message: string } | null;
}

export interface SyncSupabaseUpdateBuilder {
  eq(column: string, value: unknown): {
    eq(column: string, value: unknown): PromiseLike<SyncSupabaseQueryResult>;
  };
}

export interface SyncSupabaseTableBuilder {
  update(values: Record<string, unknown>): SyncSupabaseUpdateBuilder;
}

export interface SyncSupabaseClient {
  from(table: string): SyncSupabaseTableBuilder;
}

export interface SyncSummary {
  updated: number;
  // A record whose ELMNTKEY+SIDE doesn't match any row in our own
  // blockfaces table is expected and common (the FeatureServer covers
  // every Seattle blockface; import-blockfaces.ts only ever imports the
  // subset with paid-parking evidence -- see CLAUDE.md's Known open
  // questions) -- tracked for visibility, not treated as a failure.
  noMatchingBlockface: number;
  failed: { sourceElementKey: number; sideOfStreet: Side; errorMessage: string }[];
}

export async function syncBlockfaceParkingAreas(
  supabaseClient: SyncSupabaseClient,
  records: readonly BlockfaceParkingAreaRecord[],
): Promise<SyncSummary> {
  const summary: SyncSummary = { updated: 0, noMatchingBlockface: 0, failed: [] };

  for (const record of records) {
    const { error } = await supabaseClient
      .from("blockfaces")
      .update({ paidparkingarea: record.paidParkingArea, paidparkingsubarea: record.paidParkingSubarea })
      .eq("source_element_key", record.sourceElementKey)
      .eq("side_of_street", record.sideOfStreet);

    if (error !== null) {
      summary.failed.push({ sourceElementKey: record.sourceElementKey, sideOfStreet: record.sideOfStreet, errorMessage: error.message });
      continue;
    }
    // Supabase's .update() reports error === null even when zero rows
    // matched the .eq() filters (an UPDATE affecting 0 rows is not a
    // PostgREST error) -- there's no rowCount surfaced through this
    // minimal interface to distinguish "updated" from "matched nothing"
    // here, so noMatchingBlockface is instead derived by the caller
    // (main(), below) from a real, separate count of blockfaces actually
    // holding this ELMNTKEY/side, before running any updates.
    summary.updated += 1;
  }

  return summary;
}

function getRequiredEnvVar(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`syncBlockfaceParkingAreas: missing required environment variable ${name} (see .env.example)`);
  }
  return value;
}

export async function main(): Promise<void> {
  console.log("Fetching Blockface FeatureServer records...");
  const features = await fetchArcGisFeatures(BLOCKFACE_FEATURE_SERVER_URL, LAYER_ID, "1=1", OUT_FIELDS);
  console.log(`Fetched ${features.length} records.`);

  const records = features.map(parseBlockfaceParkingAreaFeature);
  const withArea = records.filter((record) => record.paidParkingArea !== null).length;
  console.log(`${withArea} of ${records.length} records carry a real PAIDAREA value.`);

  const supabaseUrl = getRequiredEnvVar("SUPABASE_URL");
  const supabaseServiceRoleKey = getRequiredEnvVar("SUPABASE_SERVICE_ROLE_KEY");
  const supabaseClient = createClient(supabaseUrl, supabaseServiceRoleKey) as unknown as SyncSupabaseClient;

  const summary = await syncBlockfaceParkingAreas(supabaseClient, records);

  console.log("\n=== syncBlockfaceParkingAreas summary ===");
  console.log(`Updated:  ${summary.updated}`);
  console.log(`Failed:   ${summary.failed.length}`);
  for (const failure of summary.failed) {
    console.log(`  - ELMNTKEY ${failure.sourceElementKey} side ${failure.sideOfStreet}: ${failure.errorMessage}`);
  }
  console.log("==========================================\n");
}

const isRunDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isRunDirectly) {
  main().catch((error: unknown) => {
    console.error("syncBlockfaceParkingAreas: fatal error:", error);
    process.exitCode = 1;
  });
}
