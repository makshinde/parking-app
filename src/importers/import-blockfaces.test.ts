import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArcGisFeature } from "../utils/fetchArcGisFeatures";
import {
  blockfaceAlreadyExists,
  createEmptySummary,
  getNumberAttribute,
  getSideAttribute,
  getStringAttribute,
  groupByElmntkey,
  indexStreetsByCompkey,
  parseCliOptions,
  processElement,
  resolveSegkeyForElement,
} from "./import-blockfaces";
import type { ImportSupabaseClient } from "./import-blockfaces";

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

  it("uses the last recognized flag when multiple are given", () => {
    expect(parseCliOptions(["--limit=20", "--all"])).toEqual({ limit: null });
    expect(parseCliOptions(["--all", "--limit=20"])).toEqual({ limit: 20 });
  });

  it("ignores unrecognized arguments", () => {
    expect(parseCliOptions(["--verbose", "--limit=10"])).toEqual({ limit: 10 });
  });

  it("throws for a non-positive, non-numeric, or non-integer --limit", () => {
    expect(() => parseCliOptions(["--limit=0"])).toThrow(/positive integer/);
    expect(() => parseCliOptions(["--limit=-5"])).toThrow(/positive integer/);
    expect(() => parseCliOptions(["--limit=abc"])).toThrow(/positive integer/);
    expect(() => parseCliOptions(["--limit=3.5"])).toThrow(/positive integer/);
  });
});

describe("getStringAttribute / getNumberAttribute / getSideAttribute", () => {
  const feature: ArcGisFeature = { attributes: { NAME: "1ST AVE", COUNT: 5, EMPTY: "", SIDE: "NE" } };

  it("reads a valid string attribute", () => {
    expect(getStringAttribute(feature, "NAME", "test")).toBe("1ST AVE");
  });

  it("throws for a missing or empty string attribute", () => {
    expect(() => getStringAttribute(feature, "MISSING", "test")).toThrow(/MISSING/);
    expect(() => getStringAttribute(feature, "EMPTY", "test")).toThrow(/EMPTY/);
  });

  it("reads a valid number attribute", () => {
    expect(getNumberAttribute(feature, "COUNT", "test")).toBe(5);
  });

  it("throws for a missing or non-finite number attribute", () => {
    expect(() => getNumberAttribute(feature, "MISSING", "test")).toThrow(/MISSING/);
    expect(() => getNumberAttribute({ attributes: { X: NaN } }, "X", "test")).toThrow(/X/);
  });

  it("reads SIDE as-is, including intercardinal values, without validating it", () => {
    expect(getSideAttribute(feature, "test")).toBe("NE");
  });
});

describe("groupByElmntkey", () => {
  it("groups features sharing an ELMNTKEY together, preserving order", () => {
    const features: ArcGisFeature[] = [
      { attributes: { ELMNTKEY: 1, SIDE: "N" } },
      { attributes: { ELMNTKEY: 2, SIDE: "S" } },
      { attributes: { ELMNTKEY: 1, SIDE: "S" } },
    ];

    const groups = groupByElmntkey(features, "test");

    expect(groups.get(1)).toEqual([{ attributes: { ELMNTKEY: 1, SIDE: "N" } }, { attributes: { ELMNTKEY: 1, SIDE: "S" } }]);
    expect(groups.get(2)).toEqual([{ attributes: { ELMNTKEY: 2, SIDE: "S" } }]);
  });

  it("returns an empty map for an empty input", () => {
    expect(groupByElmntkey([], "test").size).toBe(0);
  });

  it("throws when a feature is missing ELMNTKEY", () => {
    expect(() => groupByElmntkey([{ attributes: {} }], "test context")).toThrow(/test context/);
  });
});

describe("indexStreetsByCompkey", () => {
  it("indexes features by COMPKEY", () => {
    const features: ArcGisFeature[] = [{ attributes: { COMPKEY: 1001, STNAME_ORD: "1ST AVE" } }];
    const index = indexStreetsByCompkey(features);
    expect(index.get(1001)).toEqual(features[0]);
  });

  it("throws when a feature is missing COMPKEY", () => {
    expect(() => indexStreetsByCompkey([{ attributes: {} }])).toThrow(/COMPKEY/);
  });
});

describe("resolveSegkeyForElement", () => {
  it("finds a single consistent SEGKEY across curb-spaces and pay-stations", () => {
    const curbSpaces: ArcGisFeature[] = [{ attributes: { SEGKEY: 1001 } }];
    const payStations: ArcGisFeature[] = [{ attributes: { SEGKEY: 1001 } }];

    expect(resolveSegkeyForElement(70501, curbSpaces, payStations)).toEqual({ found: true, segkey: 1001 });
  });

  it("reports not found when there are no records at all", () => {
    const result = resolveSegkeyForElement(70501, [], []);
    expect(result).toEqual({ found: false, reason: expect.stringContaining("no SEGKEY found") });
  });

  it("reports not found when records disagree on SEGKEY", () => {
    const curbSpaces: ArcGisFeature[] = [{ attributes: { SEGKEY: 1001 } }, { attributes: { SEGKEY: 1002 } }];

    const result = resolveSegkeyForElement(70501, curbSpaces, []);
    expect(result).toEqual({ found: false, reason: expect.stringContaining("inconsistent SEGKEY") });
  });
});

interface MockClientOptions {
  existingKeys?: Set<string>;
  failUpsertForKeys?: Set<string>;
}

function keyFor(sourceElementKey: number, side: string): string {
  return `${sourceElementKey}:${side}`;
}

function createMockImportClient(options: MockClientOptions = {}) {
  const existingKeys = options.existingKeys ?? new Set<string>();
  const failUpsertForKeys = options.failUpsertForKeys ?? new Set<string>();
  const upsertCalls: Record<string, unknown>[] = [];

  const maybeSingle = vi.fn(async (sourceElementKey: unknown, side: unknown) => {
    const key = keyFor(sourceElementKey as number, side as string);
    return existingKeys.has(key) ? { data: { id: `existing-${key}` }, error: null } : { data: null, error: null };
  });

  const blockfacesBuilder = {
    select: (_columns: string) => ({
      eq: (_col1: string, sourceElementKey: unknown) => ({
        eq: (_col2: string, side: unknown) => ({
          maybeSingle: () => maybeSingle(sourceElementKey, side),
        }),
      }),
    }),
    upsert: (row: Record<string, unknown>, _options: { onConflict: string }) => ({
      select: (_columns: string) => ({
        single: async () => {
          upsertCalls.push(row);
          const key = keyFor(row.source_element_key as number, row.side_of_street as string);
          if (failUpsertForKeys.has(key)) {
            return { data: null, error: { message: `simulated upsert failure for ${key}` } };
          }
          return { data: { id: `blockface-${key}` }, error: null };
        },
      }),
    }),
    delete: () => ({ eq: async () => ({ data: [], error: null }) }),
    insert: async () => ({ data: [], error: null }),
  };

  const unexpectedRateTiersCall = (method: string) => () => {
    throw new Error(`createMockImportClient: unexpected rate_tiers.${method}() call`);
  };
  const rateTiersBuilder = {
    select: unexpectedRateTiersCall("select"),
    upsert: unexpectedRateTiersCall("upsert"),
    delete: () => ({ eq: async () => ({ data: [], error: null }) }),
    insert: async () => ({ data: [], error: null }),
  };

  const from = vi.fn((table: string) => {
    if (table === "blockfaces") return blockfacesBuilder;
    if (table === "rate_tiers") return rateTiersBuilder;
    throw new Error(`createMockImportClient: unexpected table "${table}"`);
  });

  const client = { from } as unknown as ImportSupabaseClient;
  return { client, upsertCalls };
}

describe("blockfaceAlreadyExists", () => {
  it("returns false when no matching row exists", async () => {
    const { client } = createMockImportClient();
    expect(await blockfaceAlreadyExists(client, 70501, "W")).toBe(false);
  });

  it("returns true when a matching row exists", async () => {
    const { client } = createMockImportClient({ existingKeys: new Set([keyFor(70501, "W")]) });
    expect(await blockfaceAlreadyExists(client, 70501, "W")).toBe(true);
  });
});

// Real, verified street segment (1ST AVE between CHERRY ST and COLUMBIA ST,
// COMPKEY 1001), same fixture used in assembleBlockface.test.ts.
function makeStreetsRecord(): ArcGisFeature {
  return {
    attributes: { COMPKEY: 1001, STNAME_ORD: "1ST AVE", XSTRLO: "CHERRY ST", XSTRHI: "COLUMBIA ST" },
    geometry: {
      paths: [
        [
          [1270150.94814542, 223404.780440807],
          [1269994.83806525, 223668.036505073],
        ],
      ],
    },
  };
}

function makeCurbSpace(elmntkey: number, segkey: number, side: string, spaceType: string): ArcGisFeature {
  return { attributes: { ELMNTKEY: elmntkey, SEGKEY: segkey, SIDE: side, SPACETYPE: spaceType } };
}

function makePayStation(elmntkey: number, segkey: number, side: string): ArcGisFeature {
  return {
    attributes: {
      ELMNTKEY: elmntkey,
      SEGKEY: segkey,
      SIDE: side,
      WKD_RATE1: 2.5,
      WKD_START1: 480,
      WKD_END1: 1019,
      WKD_RATE2: null,
      WKD_START2: null,
      WKD_END2: null,
      WKD_RATE3: null,
      WKD_START3: null,
      WKD_END3: null,
      SAT_RATE1: null,
      SAT_START1: null,
      SAT_END1: null,
      SAT_RATE2: null,
      SAT_START2: null,
      SAT_END2: null,
      SAT_RATE3: null,
      SAT_START3: null,
      SAT_END3: null,
      SUN_RATE1: null,
      SUN_START1: null,
      SUN_END1: null,
      SUN_RATE2: null,
      SUN_START2: null,
      SUN_END2: null,
      SUN_RATE3: null,
      SUN_START3: null,
      SUN_END3: null,
    },
  };
}

describe("processElement", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("creates a new PAID blockface and records it as created", async () => {
    const { client, upsertCalls } = createMockImportClient();
    const summary = createEmptySummary();
    const streetsByCompkey = indexStreetsByCompkey([makeStreetsRecord()]);

    await processElement(
      client,
      70501,
      [makeCurbSpace(70501, 1001, "W", "PS")],
      [makePayStation(70501, 1001, "W")],
      streetsByCompkey,
      summary,
    );

    expect(summary.created).toEqual([{ sourceElementKey: 70501, side: "W" }]);
    expect(summary.updated).toEqual([]);
    expect(summary.failed).toEqual([]);
    expect(summary.skipped).toEqual([]);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toMatchObject({ source_element_key: 70501, side_of_street: "W", is_paid: true });
  });

  it("records a blockface as updated when a matching row already exists", async () => {
    const { client } = createMockImportClient({ existingKeys: new Set([keyFor(70501, "W")]) });
    const summary = createEmptySummary();
    const streetsByCompkey = indexStreetsByCompkey([makeStreetsRecord()]);

    await processElement(
      client,
      70501,
      [makeCurbSpace(70501, 1001, "W", "PS")],
      [makePayStation(70501, 1001, "W")],
      streetsByCompkey,
      summary,
    );

    expect(summary.updated).toEqual([{ sourceElementKey: 70501, side: "W" }]);
    expect(summary.created).toEqual([]);
  });

  it("counts a DATA_GAP side and still writes it", async () => {
    const { client, upsertCalls } = createMockImportClient();
    const summary = createEmptySummary();
    const streetsByCompkey = indexStreetsByCompkey([makeStreetsRecord()]);

    // No pay station on side W, but curb-spaces shows a PS-eligible space --
    // resolveBlockfaceSides resolves this as DATA_GAP, not UNPAID_CONFIRMED.
    await processElement(client, 70501, [makeCurbSpace(70501, 1001, "W", "PS")], [], streetsByCompkey, summary);

    expect(summary.dataGapCount).toBe(1);
    expect(summary.created).toEqual([{ sourceElementKey: 70501, side: "W" }]);
    expect(upsertCalls[0]).toMatchObject({ source_element_key: 70501, side_of_street: "W", is_paid: true, starting_rate_usd: null });
  });

  it("skips the element when no Streets record matches its SEGKEY", async () => {
    const summary = createEmptySummary();
    const { client } = createMockImportClient();

    await processElement(
      client,
      70501,
      [makeCurbSpace(70501, 9999, "W", "PS")],
      [],
      new Map(), // no streets indexed at all
      summary,
    );

    expect(summary.skipped).toEqual([
      { sourceElementKey: 70501, side: null, reason: expect.stringContaining("no Streets record found for COMPKEY 9999") },
    ]);
    expect(summary.created).toEqual([]);
  });

  it("skips the element when curb-spaces and pay-stations disagree on SEGKEY", async () => {
    const summary = createEmptySummary();
    const { client } = createMockImportClient();

    await processElement(
      client,
      70501,
      [makeCurbSpace(70501, 1001, "W", "PS")],
      [makePayStation(70501, 2002, "W")],
      indexStreetsByCompkey([makeStreetsRecord()]),
      summary,
    );

    expect(summary.skipped).toEqual([
      { sourceElementKey: 70501, side: null, reason: expect.stringContaining("inconsistent SEGKEY") },
    ]);
  });

  it("records a per-side skip when assembleBlockface rejects the data (e.g. a mismatched ELMNTKEY within one side's curb-spaces group)", async () => {
    const summary = createEmptySummary();
    const { client } = createMockImportClient();
    const mismatchedCurbSpace: ArcGisFeature = { attributes: { ELMNTKEY: 99999, SEGKEY: 1001, SIDE: "W", SPACETYPE: "PS" } };

    await processElement(
      client,
      70501,
      [makeCurbSpace(70501, 1001, "W", "PS"), mismatchedCurbSpace],
      [makePayStation(70501, 1001, "W")],
      indexStreetsByCompkey([makeStreetsRecord()]),
      summary,
    );

    expect(summary.skipped).toEqual([
      { sourceElementKey: 70501, side: "W", reason: expect.stringContaining("ELMNTKEY") },
    ]);
    expect(summary.created).toEqual([]);
  });

  it("records a per-side failure when the upsert itself fails, without stopping other sides", async () => {
    const summary = createEmptySummary();
    const { client } = createMockImportClient({ failUpsertForKeys: new Set([keyFor(70501, "W")]) });

    await processElement(
      client,
      70501,
      [makeCurbSpace(70501, 1001, "W", "PS"), makeCurbSpace(70501, 1001, "E", "RPZ")],
      [makePayStation(70501, 1001, "W")],
      indexStreetsByCompkey([makeStreetsRecord()]),
      summary,
    );

    expect(summary.failed).toEqual([
      { sourceElementKey: 70501, side: "W", reason: expect.stringContaining("simulated upsert failure") },
    ]);
    // Side E (UNPAID_CONFIRMED, no pay station) should still succeed
    // independently of side W's failure.
    expect(summary.created).toEqual([{ sourceElementKey: 70501, side: "E" }]);
  });
});
