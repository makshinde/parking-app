import { describe, expect, it, vi } from "vitest";
import type { ArcGisFeature } from "../utils/fetchArcGisFeatures";
import { formatPointForPostgis } from "./formatPointForPostgis";
import {
  createEmptySummary,
  facilityAlreadyExists,
  mapFeatureToFacility,
  parseCliOptions,
  processFeature,
} from "./import-off-street-facilities";
import type { ImportSupabaseClient } from "./import-off-street-facilities";

describe("parseCliOptions", () => {
  it("defaults to limit=5 when no flags are given", () => {
    expect(parseCliOptions([])).toEqual({ limit: 5 });
  });

  it("respects --limit=<n>", () => {
    expect(parseCliOptions(["--limit=20"])).toEqual({ limit: 20 });
  });

  it("returns limit=null for --all, overriding the default", () => {
    expect(parseCliOptions(["--all"])).toEqual({ limit: null });
  });

  it("throws for a non-positive, non-numeric, or non-integer --limit", () => {
    expect(() => parseCliOptions(["--limit=0"])).toThrow(/positive integer/);
    expect(() => parseCliOptions(["--limit=-5"])).toThrow(/positive integer/);
    expect(() => parseCliOptions(["--limit=abc"])).toThrow(/positive integer/);
  });
});

// Real, verified Belltown coordinate (SRID 2926), same fixture used
// elsewhere in this project (reprojectCoordinates.test.ts,
// formatPointForPostgis.test.ts).
const BELLTOWN_X = 1265813.38993298;
const BELLTOWN_Y = 228647.898526177;

function makeFeature(overrides: Record<string, unknown> = {}): ArcGisFeature {
  return {
    attributes: {
      OBJECTID: 1,
      BUSLIC_LOCATION_ID: 690564,
      DEA_FACILITY_NAME: "DIAMOND PARKING WX04",
      FAC_NAME: "DIAMOND PARKING WX04",
      DEA_FACILITY_ADDRESS: "4333 FREMONT AVE N, SEATTLE, WA 98103",
      DEA_STALLS: 13,
      FAC_TYPE: "SURFACE LOT",
      OP_NAME: "DIAMOND PARKING",
      RTE_1HR: null,
      RTE_2HR: null,
      RTE_3HR: null,
      RTE_ALLDAY: null,
      ...overrides,
    },
    geometry: { x: BELLTOWN_X, y: BELLTOWN_Y },
  };
}

describe("mapFeatureToFacility", () => {
  it("maps a fully-populated record to a facility row with no rate tiers when all rate fields are null", () => {
    const result = mapFeatureToFacility(makeFeature(), "test");

    expect(result.facility).toEqual({
      source_facility_id: "690564",
      name: "DIAMOND PARKING WX04",
      location: formatPointForPostgis(BELLTOWN_X, BELLTOWN_Y),
      address: "4333 FREMONT AVE N, SEATTLE, WA 98103",
      capacity: 13,
      facility_type: "SURFACE LOT",
      operator_name: "DIAMOND PARKING",
    });
    expect(result.rateTiers).toEqual([]);
  });

  it("builds up to 4 rate tiers, one per populated rate field, via parseRateValue", () => {
    const result = mapFeatureToFacility(
      makeFeature({ RTE_1HR: "3", RTE_2HR: "6", RTE_3HR: "9", RTE_ALLDAY: "Permit only" }),
      "test",
    );

    expect(result.rateTiers).toEqual([
      { duration_type: "1HR", rate_usd: 3, rate_note: null },
      { duration_type: "2HR", rate_usd: 6, rate_note: null },
      { duration_type: "3HR", rate_usd: 9, rate_note: null },
      { duration_type: "ALLDAY", rate_usd: null, rate_note: "Permit only" },
    ]);
  });

  it("skips a rate tier entirely when its source field is null, rather than writing a null/null row", () => {
    const result = mapFeatureToFacility(makeFeature({ RTE_1HR: "5" }), "test");

    expect(result.rateTiers).toEqual([{ duration_type: "1HR", rate_usd: 5, rate_note: null }]);
  });

  it("skips a rate tier entirely when its source field is an empty string", () => {
    const result = mapFeatureToFacility(makeFeature({ RTE_1HR: "" }), "test");

    expect(result.rateTiers).toEqual([]);
  });

  it("treats sparse optional fields (address, capacity, facility_type, operator_name) as nullable", () => {
    const result = mapFeatureToFacility(
      makeFeature({ DEA_FACILITY_ADDRESS: null, DEA_STALLS: null, FAC_TYPE: null, OP_NAME: null }),
      "test",
    );

    expect(result.facility).toMatchObject({
      address: null,
      capacity: null,
      facility_type: null,
      operator_name: null,
    });
  });

  it("falls back to FAC_NAME when DEA_FACILITY_NAME is missing", () => {
    const result = mapFeatureToFacility(makeFeature({ DEA_FACILITY_NAME: null, FAC_NAME: "Lot 28" }), "test");

    expect(result.facility.name).toBe("Lot 28");
  });

  it("throws when both DEA_FACILITY_NAME and FAC_NAME are missing", () => {
    expect(() => mapFeatureToFacility(makeFeature({ DEA_FACILITY_NAME: null, FAC_NAME: null }), "test context")).toThrow(
      /test context.*DEA_FACILITY_NAME.*FAC_NAME/s,
    );
  });

  it("throws when BUSLIC_LOCATION_ID is missing", () => {
    expect(() => mapFeatureToFacility(makeFeature({ BUSLIC_LOCATION_ID: null }), "test context")).toThrow(
      /test context.*BUSLIC_LOCATION_ID/s,
    );
  });

  it("throws when geometry is missing", () => {
    const feature = makeFeature();
    delete feature.geometry;
    expect(() => mapFeatureToFacility(feature, "test context")).toThrow(/test context.*geometry\.x/s);
  });
});

interface MockClientOptions {
  existingIds?: Set<string>;
  failUpsertForIds?: Set<string>;
}

function createMockImportClient(options: MockClientOptions = {}) {
  const existingIds = options.existingIds ?? new Set<string>();
  const failUpsertForIds = options.failUpsertForIds ?? new Set<string>();
  const upsertCalls: Record<string, unknown>[] = [];

  const maybeSingle = vi.fn(async (sourceFacilityId: unknown) => {
    return existingIds.has(sourceFacilityId as string)
      ? { data: { id: `existing-${sourceFacilityId}` }, error: null }
      : { data: null, error: null };
  });

  const facilitiesBuilder = {
    select: (_columns: string) => ({
      eq: (_col: string, sourceFacilityId: unknown) => ({
        maybeSingle: () => maybeSingle(sourceFacilityId),
      }),
    }),
    upsert: (row: Record<string, unknown>, _options: { onConflict: string }) => ({
      select: (_columns: string) => ({
        single: async () => {
          upsertCalls.push(row);
          const id = row.source_facility_id as string;
          if (failUpsertForIds.has(id)) {
            return { data: null, error: { message: `simulated upsert failure for ${id}` } };
          }
          return { data: { id: `facility-${id}` }, error: null };
        },
      }),
    }),
    delete: () => ({ eq: async () => ({ data: [], error: null }) }),
    insert: async () => ({ data: [], error: null }),
  };

  const unexpectedRateTiersCall = (method: string) => () => {
    throw new Error(`createMockImportClient: unexpected off_street_rate_tiers.${method}() call`);
  };
  const rateTiersBuilder = {
    select: unexpectedRateTiersCall("select"),
    upsert: unexpectedRateTiersCall("upsert"),
    delete: () => ({ eq: async () => ({ data: [], error: null }) }),
    insert: async () => ({ data: [], error: null }),
  };

  const from = vi.fn((table: string) => {
    if (table === "off_street_facilities") return facilitiesBuilder;
    if (table === "off_street_rate_tiers") return rateTiersBuilder;
    throw new Error(`createMockImportClient: unexpected table "${table}"`);
  });

  const client = { from } as unknown as ImportSupabaseClient;
  return { client, upsertCalls };
}

describe("facilityAlreadyExists", () => {
  it("returns false when no matching row exists", async () => {
    const { client } = createMockImportClient();
    expect(await facilityAlreadyExists(client, "690564")).toBe(false);
  });

  it("returns true when a matching row exists", async () => {
    const { client } = createMockImportClient({ existingIds: new Set(["690564"]) });
    expect(await facilityAlreadyExists(client, "690564")).toBe(true);
  });
});

describe("processFeature", () => {
  it("creates a new facility and records it as created", async () => {
    const { client, upsertCalls } = createMockImportClient();
    const summary = createEmptySummary();

    await processFeature(client, makeFeature(), summary);

    expect(summary.created).toEqual([{ sourceFacilityId: "690564" }]);
    expect(summary.updated).toEqual([]);
    expect(summary.failed).toEqual([]);
    expect(summary.skipped).toEqual([]);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toMatchObject({ source_facility_id: "690564", name: "DIAMOND PARKING WX04" });
  });

  it("records a facility as updated when a matching row already exists", async () => {
    const { client } = createMockImportClient({ existingIds: new Set(["690564"]) });
    const summary = createEmptySummary();

    await processFeature(client, makeFeature(), summary);

    expect(summary.updated).toEqual([{ sourceFacilityId: "690564" }]);
    expect(summary.created).toEqual([]);
  });

  it("records a skip (not a failure) when the record fails to map, without touching the database", async () => {
    const { client, upsertCalls } = createMockImportClient();
    const summary = createEmptySummary();
    const feature = makeFeature({ DEA_FACILITY_NAME: null, FAC_NAME: null });

    await processFeature(client, feature, summary);

    expect(summary.skipped).toEqual([
      { sourceFacilityId: null, reason: expect.stringContaining("DEA_FACILITY_NAME") },
    ]);
    expect(summary.created).toEqual([]);
    expect(upsertCalls).toEqual([]);
  });

  it("records a failure when the upsert itself fails, distinct from a mapping skip", async () => {
    const { client } = createMockImportClient({ failUpsertForIds: new Set(["690564"]) });
    const summary = createEmptySummary();

    await processFeature(client, makeFeature(), summary);

    expect(summary.failed).toEqual([
      { sourceFacilityId: "690564", reason: expect.stringContaining("simulated upsert failure") },
    ]);
    expect(summary.created).toEqual([]);
    expect(summary.skipped).toEqual([]);
  });

  it("processes independent records without one failure stopping the others", async () => {
    const { client } = createMockImportClient({ failUpsertForIds: new Set(["690564"]) });
    const summary = createEmptySummary();

    await processFeature(client, makeFeature({ BUSLIC_LOCATION_ID: 690564 }), summary);
    await processFeature(client, makeFeature({ BUSLIC_LOCATION_ID: 700000 }), summary);

    expect(summary.failed).toEqual([{ sourceFacilityId: "690564", reason: expect.stringContaining("simulated upsert failure") }]);
    expect(summary.created).toEqual([{ sourceFacilityId: "700000" }]);
  });
});
