import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import type { ArcGisFeature } from "../utils/fetchArcGisFeatures.ts";
import { fetchArcGisFeatures } from "../utils/fetchArcGisFeatures.ts";
import { assembleBlockface } from "./assembleBlockface.ts";
import type { CurbSpaceRecord, PayStationRecord, Side } from "./resolveBlockfaceSides.ts";
import { resolveBlockfaceSides } from "./resolveBlockfaceSides.ts";
import type { SupabaseQueryResult, SupabaseTableBuilder } from "./upsertBlockface.ts";
import { upsertBlockface } from "./upsertBlockface.ts";

// Live-verified live FeatureServer endpoints (see CLAUDE.md's Known open
// questions -- field names and SIDE's real value set were cross-checked
// against these directly before this script was written).
const CURB_SPACES_URL =
  "https://services.arcgis.com/ZOyb2t4B0UYuYNYH/ArcGIS/rest/services/Paid_Area_Curb_Spaces/FeatureServer";
const PAY_STATIONS_URL = "https://services.arcgis.com/ZOyb2t4B0UYuYNYH/ArcGIS/rest/services/SDOT_Pay_Stations/FeatureServer";
const STREETS_URL = "https://services.arcgis.com/ZOyb2t4B0UYuYNYH/ArcGIS/rest/services/Seattle_Streets_1/FeatureServer";
const LAYER_ID = 0;

// createClient's return type is a bare type query (ReturnType<typeof
// createClient>) resolves to a different generic instantiation than an
// actual call with (string, string) arguments -- wrapping it in a concrete
// function makes ReturnType<typeof createSupabaseClient> consistent
// everywhere it's used below.
function createSupabaseClient(url: string, serviceRoleKey: string) {
  return createClient(url, serviceRoleKey);
}

// Extends upsertBlockface.ts's minimal SupabaseClientLike with the one extra
// read (.select().eq().eq().maybeSingle()) this file needs for its own
// created-vs-updated bookkeeping. Everything downstream of main() operates
// on this one small interface -- never the real SupabaseClient type -- so
// (a) tests can pass a plain mock object with no real Supabase dependency,
// same pattern as upsertBlockface.test.ts, and (b) the one unavoidable cast
// from the real client's excessively-deep generic type happens exactly once,
// in main(), instead of scattered across every function that touches it.
export interface ImportSupabaseTableBuilder extends SupabaseTableBuilder {
  select(columns: string): {
    eq(column: string, value: unknown): {
      eq(column: string, value: unknown): {
        maybeSingle(): PromiseLike<SupabaseQueryResult<{ id: string }>>;
      };
    };
  };
}

export interface ImportSupabaseClient {
  from(table: string): ImportSupabaseTableBuilder;
}

// A small default so a first run against live data is cheap to inspect and
// cheap to undo, before committing to the full ~1,500+ segment set. Must be
// explicitly overridden (--limit=<n> or --all) to run a larger batch.
const DEFAULT_LIMIT = 5;

export interface CliOptions {
  // Number of ELMNTKEYs to process, or null for no limit (--all).
  limit: number | null;
}

export function parseCliOptions(argv: string[]): CliOptions {
  let limit: number | null = DEFAULT_LIMIT;

  for (const arg of argv) {
    if (arg === "--all") {
      limit = null;
      continue;
    }

    // Captures everything after "--limit=" (not just \d+) so malformed
    // values like "-5" or "abc" reach the validation below and throw a
    // clear error, instead of silently falling through as an unrecognized
    // argument and leaving the default limit in place unnoticed.
    const match = /^--limit=(.+)$/.exec(arg);
    if (match === null) {
      continue;
    }
    const [, rawLimit] = match;
    if (rawLimit === undefined) {
      throw new Error("import-blockfaces: unreachable -- --limit regex matched without a capture group");
    }

    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`import-blockfaces: --limit must be a positive integer, got "${rawLimit}"`);
    }
    limit = parsed;
  }

  return { limit };
}

// Continuous/estimated input (a count), but SUPABASE_URL/KEY are more like
// discrete required configuration -- there's no meaningful "nearest valid"
// missing env var, so this throws rather than defaulting to some placeholder
// that would silently point the import at the wrong (or no) database.
function getRequiredEnvVar(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`import-blockfaces: missing required environment variable ${name} (see .env.example)`);
  }
  return value;
}

export function getStringAttribute(feature: ArcGisFeature, key: string, context: string): string {
  const value = feature.attributes[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`import-blockfaces: ${context} -- expected a non-empty string for "${key}", got ${JSON.stringify(value)}`);
  }
  return value;
}

export function getNumberAttribute(feature: ArcGisFeature, key: string, context: string): number {
  const value = feature.attributes[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`import-blockfaces: ${context} -- expected a finite number for "${key}", got ${JSON.stringify(value)}`);
  }
  return value;
}

// SIDE's actual valid values are resolveBlockfaceSides.ts's job to enforce
// (it throws on anything outside the 8 compass directions); this just reads
// the raw field as a string.
export function getSideAttribute(feature: ArcGisFeature, context: string): Side {
  return getStringAttribute(feature, "SIDE", context) as Side;
}

export function groupByElmntkey(features: ArcGisFeature[], context: string): Map<number, ArcGisFeature[]> {
  const groups = new Map<number, ArcGisFeature[]>();
  for (const feature of features) {
    const elmntkey = getNumberAttribute(feature, "ELMNTKEY", context);
    const existing = groups.get(elmntkey);
    if (existing) {
      existing.push(feature);
    } else {
      groups.set(elmntkey, [feature]);
    }
  }
  return groups;
}

export function indexStreetsByCompkey(features: ArcGisFeature[]): Map<number, ArcGisFeature> {
  const index = new Map<number, ArcGisFeature>();
  for (const feature of features) {
    const compkey = getNumberAttribute(feature, "COMPKEY", "indexing streets by COMPKEY");
    index.set(compkey, feature);
  }
  return index;
}

export type SegkeyLookup = { found: true; segkey: number } | { found: false; reason: string };

// Both curb-spaces and pay-station records carry their own SEGKEY (matching
// Streets.COMPKEY -- see CLAUDE.md), which is how the street name/cross
// streets/geometry for an ELMNTKEY's segment gets found. Every record for
// one ELMNTKEY should agree on a single SEGKEY; if they don't, that's a real
// data anomaly worth skipping and reporting, not silently picking one.
export function resolveSegkeyForElement(
  elmntkey: number,
  curbSpaces: ArcGisFeature[],
  payStations: ArcGisFeature[],
): SegkeyLookup {
  const segkeys = new Set<number>();
  for (const feature of [...curbSpaces, ...payStations]) {
    segkeys.add(getNumberAttribute(feature, "SEGKEY", `ELMNTKEY ${elmntkey}`));
  }

  if (segkeys.size === 0) {
    return { found: false, reason: `ELMNTKEY ${elmntkey}: no SEGKEY found on any curb-spaces or pay-station record` };
  }
  if (segkeys.size > 1) {
    return {
      found: false,
      reason: `ELMNTKEY ${elmntkey}: inconsistent SEGKEY values across records (${Array.from(segkeys).join(", ")})`,
    };
  }

  const [segkey] = segkeys;
  if (segkey === undefined) {
    throw new Error("import-blockfaces: unreachable -- segkeys.size === 1 but no value found");
  }
  return { found: true, segkey };
}

export interface SideOutcome {
  sourceElementKey: number;
  side: Side;
}

export interface SkippedRecord {
  sourceElementKey: number;
  side: Side | null;
  reason: string;
}

export interface ImportSummary {
  created: SideOutcome[];
  updated: SideOutcome[];
  skipped: SkippedRecord[];
  failed: SkippedRecord[];
  dataGapCount: number;
}

export function createEmptySummary(): ImportSummary {
  return { created: [], updated: [], skipped: [], failed: [], dataGapCount: 0 };
}

// upsertBlockface only needs to know whether the write succeeded, not
// whether it inserted or updated a row -- ON CONFLICT DO UPDATE doesn't
// expose that distinction on its own. This checks for an existing row
// before upserting, purely so the run summary can report created vs
// updated; it deliberately doesn't touch upsertBlockface.ts's contract.
export async function blockfaceAlreadyExists(
  supabaseClient: ImportSupabaseClient,
  sourceElementKey: number,
  side: Side,
): Promise<boolean> {
  const { data, error } = await supabaseClient
    .from("blockfaces")
    .select("id")
    .eq("source_element_key", sourceElementKey)
    .eq("side_of_street", side)
    .maybeSingle();

  if (error !== null) {
    throw new Error(
      `import-blockfaces: checking for an existing blockfaces row failed for source_element_key=${sourceElementKey}, side_of_street=${side}: ${error.message}`,
    );
  }

  return data !== null;
}

export async function processElement(
  supabaseClient: ImportSupabaseClient,
  elmntkey: number,
  curbSpacesForElement: ArcGisFeature[],
  payStationsForElement: ArcGisFeature[],
  streetsByCompkey: Map<number, ArcGisFeature>,
  summary: ImportSummary,
): Promise<void> {
  const segkeyLookup = resolveSegkeyForElement(elmntkey, curbSpacesForElement, payStationsForElement);
  if (!segkeyLookup.found) {
    summary.skipped.push({ sourceElementKey: elmntkey, side: null, reason: segkeyLookup.reason });
    return;
  }

  const streetsRecord = streetsByCompkey.get(segkeyLookup.segkey);
  if (streetsRecord === undefined) {
    summary.skipped.push({
      sourceElementKey: elmntkey,
      side: null,
      reason: `no Streets record found for COMPKEY ${segkeyLookup.segkey} (from SEGKEY)`,
    });
    return;
  }

  let resolutions;
  try {
    const paidStations: PayStationRecord[] = payStationsForElement.map((feature) => ({
      side: getSideAttribute(feature, `ELMNTKEY ${elmntkey} pay station`),
    }));
    const curbSpaceRecords: CurbSpaceRecord[] = curbSpacesForElement.map((feature) => ({
      side: getSideAttribute(feature, `ELMNTKEY ${elmntkey} curb space`),
      spaceType: getStringAttribute(feature, "SPACETYPE", `ELMNTKEY ${elmntkey} curb space`),
    }));
    resolutions = resolveBlockfaceSides(String(segkeyLookup.segkey), paidStations, curbSpaceRecords);
  } catch (error) {
    summary.skipped.push({
      sourceElementKey: elmntkey,
      side: null,
      reason: `resolveBlockfaceSides failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }

  for (const resolution of resolutions) {
    if (resolution.status === "DATA_GAP") {
      summary.dataGapCount += 1;
    }

    const curbSpacesForSide = curbSpacesForElement.filter(
      (feature) => getSideAttribute(feature, `ELMNTKEY ${elmntkey} curb space`) === resolution.side,
    );
    const payStationForSide =
      payStationsForElement.find(
        (feature) => getSideAttribute(feature, `ELMNTKEY ${elmntkey} pay station`) === resolution.side,
      ) ?? null;

    let assembled;
    try {
      assembled = assembleBlockface(curbSpacesForSide, streetsRecord, payStationForSide, resolution);
    } catch (error) {
      summary.skipped.push({
        sourceElementKey: elmntkey,
        side: resolution.side,
        reason: `assembleBlockface failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    try {
      const alreadyExisted = await blockfaceAlreadyExists(supabaseClient, elmntkey, resolution.side);
      await upsertBlockface(
        supabaseClient,
        { ...assembled.blockface, source_element_key: elmntkey },
        assembled.rateTiers,
      );
      const outcome: SideOutcome = { sourceElementKey: elmntkey, side: resolution.side };
      if (alreadyExisted) {
        summary.updated.push(outcome);
      } else {
        summary.created.push(outcome);
      }
    } catch (error) {
      summary.failed.push({
        sourceElementKey: elmntkey,
        side: resolution.side,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function logSummary(summary: ImportSummary): void {
  console.log("\n=== import-blockfaces summary ===");
  console.log(`Created:     ${summary.created.length}`);
  console.log(`Updated:     ${summary.updated.length}`);
  console.log(`DATA_GAP:    ${summary.dataGapCount} (paid assumed, rate unknown -- see CLAUDE.md)`);
  console.log(`Skipped:     ${summary.skipped.length}`);
  for (const skip of summary.skipped) {
    console.log(`  - ELMNTKEY ${skip.sourceElementKey}${skip.side ? ` side ${skip.side}` : ""}: ${skip.reason}`);
  }
  console.log(`Failed:      ${summary.failed.length}`);
  for (const failure of summary.failed) {
    console.log(`  - ELMNTKEY ${failure.sourceElementKey}${failure.side ? ` side ${failure.side}` : ""}: ${failure.reason}`);
  }
  console.log("==================================\n");
}

export async function main(): Promise<void> {
  const { limit } = parseCliOptions(process.argv.slice(2));
  console.log(limit === null ? "Running with no limit (--all)." : `Running with limit=${limit} (default is ${DEFAULT_LIMIT}; pass --limit=<n> or --all to override).`);

  const supabaseUrl = getRequiredEnvVar("SUPABASE_URL");
  const supabaseServiceRoleKey = getRequiredEnvVar("SUPABASE_SERVICE_ROLE_KEY");
  // The one unavoidable cast: TS can't structurally verify the real client
  // against ImportSupabaseClient (its generics recurse too deeply for the
  // checker -- "excessively deep" TS2589, not a real mismatch). The method
  // chains this file actually uses (.from().upsert().select().single(),
  // .from().delete().eq(), .from().insert(), .from().select().eq().eq()
  // .maybeSingle()) are all standard, stable parts of the PostgREST client.
  const supabaseClient = createSupabaseClient(supabaseUrl, supabaseServiceRoleKey) as unknown as ImportSupabaseClient;

  console.log("Fetching curb-spaces, streets, and pay-station records...");
  const [curbSpaces, payStations, streets] = await Promise.all([
    fetchArcGisFeatures(CURB_SPACES_URL, LAYER_ID, "1=1", "*"),
    fetchArcGisFeatures(PAY_STATIONS_URL, LAYER_ID, "1=1", "*"),
    fetchArcGisFeatures(STREETS_URL, LAYER_ID, "1=1", "*"),
  ]);
  console.log(`Fetched ${curbSpaces.length} curb-spaces, ${payStations.length} pay-stations, ${streets.length} streets records.`);

  const curbSpacesByElmntkey = groupByElmntkey(curbSpaces, "grouping curb-spaces by ELMNTKEY");
  const payStationsByElmntkey = groupByElmntkey(payStations, "grouping pay-stations by ELMNTKEY");
  const streetsByCompkey = indexStreetsByCompkey(streets);

  const allElmntkeys = Array.from(new Set([...curbSpacesByElmntkey.keys(), ...payStationsByElmntkey.keys()])).sort(
    (a, b) => a - b,
  );
  const elmntkeysToProcess = limit === null ? allElmntkeys : allElmntkeys.slice(0, limit);
  console.log(`Processing ${elmntkeysToProcess.length} of ${allElmntkeys.length} total ELMNTKEYs.`);

  const summary = createEmptySummary();
  for (const elmntkey of elmntkeysToProcess) {
    await processElement(
      supabaseClient,
      elmntkey,
      curbSpacesByElmntkey.get(elmntkey) ?? [],
      payStationsByElmntkey.get(elmntkey) ?? [],
      streetsByCompkey,
      summary,
    );
  }

  logSummary(summary);
}

// Only run main() when this file is executed directly (e.g. `node
// import-blockfaces.ts`), not when it's imported by test files -- otherwise
// every test run would try to read real env vars and hit live endpoints.
// Must go through pathToFileURL, not a naive `file://${path}` template
// string: import.meta.url percent-encodes special characters (this repo's
// own path contains a space -- ".../Parking App/..." becomes
// ".../Parking%20App/..."), so a plain string concatenation never matches
// and this guard would silently always evaluate false.
const isRunDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isRunDirectly) {
  main().catch((error: unknown) => {
    console.error("import-blockfaces: fatal error:", error);
    process.exitCode = 1;
  });
}
