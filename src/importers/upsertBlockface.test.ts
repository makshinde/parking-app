import { describe, expect, it, vi } from "vitest";
import type { AssembledBlockface, AssembledRateTier } from "./assembleBlockface";
import { formatLineForPostgis } from "./formatLineForPostgis";
import type { SupabaseClientLike, SupabaseQueryResult } from "./upsertBlockface";
import { upsertBlockface } from "./upsertBlockface";

function makeBlockface(overrides: Partial<AssembledBlockface> = {}): AssembledBlockface & { source_element_key: number } {
  return {
    street_name: "1ST AVE",
    cross_street_from: "CHERRY ST",
    cross_street_to: "COLUMBIA ST",
    side_of_street: "W",
    is_paid: true,
    starting_rate_usd: 2.5,
    operating_days: [1, 2, 3, 4, 5],
    operating_hours_start: "08:00:00",
    operating_hours_end: "18:00:00",
    raw_line_coordinates: [
      [1270150.94814542, 223404.780440807],
      [1269994.83806525, 223668.036505073],
    ],
    source_element_key: 70501,
    ...overrides,
  };
}

function makeRateTiers(): AssembledRateTier[] {
  return [
    { day_type: "WKD", tier_number: 1, start_time: "08:00:00", end_time: "18:00:00", rate_usd: 2.5 },
    { day_type: "SAT", tier_number: 1, start_time: "08:00:00", end_time: "18:00:00", rate_usd: 2.5 },
  ];
}

interface MockClient {
  client: SupabaseClientLike;
  upsert: ReturnType<typeof vi.fn>;
  blockfacesDelete: ReturnType<typeof vi.fn>;
  blockfacesEq: ReturnType<typeof vi.fn>;
  rateTiersDelete: ReturnType<typeof vi.fn>;
  rateTiersEq: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
}

function createMockClient(options: {
  blockfaceResult: SupabaseQueryResult<{ id: string }>;
  deleteResult?: SupabaseQueryResult;
  insertResult?: SupabaseQueryResult;
}): MockClient {
  const single = vi.fn(async () => options.blockfaceResult);
  const select = vi.fn(() => ({ single }));
  const upsert = vi.fn(() => ({ select }));

  const rateTiersEq = vi.fn(async () => options.deleteResult ?? { data: [], error: null });
  const rateTiersDelete = vi.fn(() => ({ eq: rateTiersEq }));
  const insert = vi.fn(async () => options.insertResult ?? { data: [], error: null });

  // blockfaces.delete()/insert() are never exercised by this function --
  // only rate_tiers uses delete/insert, and only blockfaces uses upsert --
  // but the interface requires all three per table, so these throw if
  // called, to catch a bug that calls the wrong operation on the wrong table.
  const blockfacesEq = vi.fn(async () => {
    throw new Error("unexpected: blockfaces.delete() should never be called");
  });
  const blockfacesDelete = vi.fn(() => ({ eq: blockfacesEq }));

  const blockfacesBuilder = {
    upsert,
    delete: blockfacesDelete,
    insert: vi.fn(async () => {
      throw new Error("unexpected: blockfaces.insert() should never be called");
    }),
  };
  const rateTiersBuilder = {
    upsert: vi.fn(() => {
      throw new Error("unexpected: rate_tiers.upsert() should never be called");
    }),
    delete: rateTiersDelete,
    insert,
  };

  const from = vi.fn((table: string) => {
    if (table === "blockfaces") return blockfacesBuilder;
    if (table === "rate_tiers") return rateTiersBuilder;
    throw new Error(`createMockClient: unexpected table "${table}"`);
  });

  return { client: { from }, upsert, blockfacesDelete, blockfacesEq, rateTiersDelete, rateTiersEq, insert };
}

describe("upsertBlockface", () => {
  it("upserts a new blockface and inserts its rate tiers", async () => {
    const mock = createMockClient({ blockfaceResult: { data: { id: "new-blockface-id" }, error: null } });
    const blockface = makeBlockface();
    const rateTiers = makeRateTiers();

    const result = await upsertBlockface(mock.client, blockface, rateTiers);

    expect(result).toEqual({ blockfaceId: "new-blockface-id" });
    expect(mock.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        source_element_key: 70501,
        side_of_street: "W",
        street_name: "1ST AVE",
        // location is the reprojected/WKT-formatted form of
        // raw_line_coordinates -- formatLineForPostgis is exercised in
        // detail in its own test file, so this just confirms upsertBlockface
        // actually calls it and sends the result under the right key.
        location: formatLineForPostgis(blockface.raw_line_coordinates),
      }),
      { onConflict: "source_element_key,side_of_street" },
    );
    // raw_line_coordinates itself isn't a real blockfaces column; only its
    // formatted `location` form should be sent to Supabase.
    expect(mock.upsert.mock.calls[0]?.[0]).not.toHaveProperty("raw_line_coordinates");
  });

  it("upserts an already-existing blockface (same code path, different returned id)", async () => {
    const mock = createMockClient({ blockfaceResult: { data: { id: "existing-blockface-id" }, error: null } });

    const result = await upsertBlockface(mock.client, makeBlockface(), makeRateTiers());

    expect(result).toEqual({ blockfaceId: "existing-blockface-id" });
    expect(mock.upsert).toHaveBeenCalledTimes(1);
  });

  it("replaces all rate tiers: deletes existing rows for the blockface, then inserts the fresh set", async () => {
    const mock = createMockClient({ blockfaceResult: { data: { id: "blockface-1" }, error: null } });
    const rateTiers = makeRateTiers();

    await upsertBlockface(mock.client, makeBlockface(), rateTiers);

    expect(mock.rateTiersDelete).toHaveBeenCalledTimes(1);
    expect(mock.rateTiersEq).toHaveBeenCalledWith("blockface_id", "blockface-1");
    expect(mock.insert).toHaveBeenCalledWith([
      { day_type: "WKD", tier_number: 1, start_time: "08:00:00", end_time: "18:00:00", rate_usd: 2.5, blockface_id: "blockface-1" },
      { day_type: "SAT", tier_number: 1, start_time: "08:00:00", end_time: "18:00:00", rate_usd: 2.5, blockface_id: "blockface-1" },
    ]);

    // Delete must happen before insert -- otherwise the fresh rows would be
    // wiped out along with the old ones.
    const deleteOrder = mock.rateTiersEq.mock.invocationCallOrder[0];
    const insertOrder = mock.insert.mock.invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(insertOrder as number);
  });

  it("skips the rate_tiers insert entirely when there are no tiers to write", async () => {
    const mock = createMockClient({ blockfaceResult: { data: { id: "blockface-1" }, error: null } });

    await upsertBlockface(mock.client, makeBlockface({ is_paid: false, starting_rate_usd: null }), []);

    expect(mock.rateTiersDelete).toHaveBeenCalledTimes(1);
    expect(mock.insert).not.toHaveBeenCalled();
  });

  it("throws a clear partial-failure error when the blockfaces upsert succeeds but the rate_tiers insert fails", async () => {
    const mock = createMockClient({
      blockfaceResult: { data: { id: "blockface-1" }, error: null },
      insertResult: { data: null, error: { message: "connection reset" } },
    });

    await expect(upsertBlockface(mock.client, makeBlockface(), makeRateTiers())).rejects.toThrow(
      /blockfaces upsert succeeded \(source_element_key=70501, side_of_street=W, id=blockface-1\).*rate_tiers.*connection reset/s,
    );
  });

  it("throws a clear partial-failure error when the blockfaces upsert succeeds but deleting old rate_tiers fails", async () => {
    const mock = createMockClient({
      blockfaceResult: { data: { id: "blockface-1" }, error: null },
      deleteResult: { data: null, error: { message: "permission denied" } },
    });

    await expect(upsertBlockface(mock.client, makeBlockface(), makeRateTiers())).rejects.toThrow(
      /blockfaces upsert succeeded \(source_element_key=70501, side_of_street=W, id=blockface-1\).*deleting.*permission denied/s,
    );
    // The failed delete must stop the flow before ever attempting insert.
    expect(mock.insert).not.toHaveBeenCalled();
  });

  it("throws clearly when the blockfaces upsert itself fails, without touching rate_tiers", async () => {
    const mock = createMockClient({
      blockfaceResult: { data: null, error: { message: "duplicate key value" } },
    });

    await expect(upsertBlockface(mock.client, makeBlockface(), makeRateTiers())).rejects.toThrow(
      /blockfaces upsert failed.*source_element_key=70501.*duplicate key value/s,
    );
    expect(mock.rateTiersDelete).not.toHaveBeenCalled();
    expect(mock.insert).not.toHaveBeenCalled();
  });
});
