import type { AssembledBlockface, AssembledRateTier } from "./assembleBlockface";

// Minimal structural subset of the @supabase/supabase-js client used here --
// deliberately not the real library's types, so this module (and its tests)
// don't require an actual Supabase project or the real dependency. Any
// client exposing this shape (the real one included) can be passed in.
export interface SupabaseQueryResult<T = unknown> {
  data: T | null;
  error: { message: string } | null;
}

export interface SupabaseUpsertBuilder {
  select(columns: string): {
    single(): Promise<SupabaseQueryResult<{ id: string }>>;
  };
}

export interface SupabaseDeleteBuilder {
  eq(column: string, value: unknown): Promise<SupabaseQueryResult>;
}

export interface SupabaseTableBuilder {
  upsert(values: Record<string, unknown>, options: { onConflict: string }): SupabaseUpsertBuilder;
  delete(): SupabaseDeleteBuilder;
  insert(values: Record<string, unknown>[]): Promise<SupabaseQueryResult>;
}

export interface SupabaseClientLike {
  from(table: string): SupabaseTableBuilder;
}

export interface UpsertBlockfaceResult {
  blockfaceId: string;
}

// blockfaces.location (PostGIS geography, NOT NULL) isn't included here.
// AssembledBlockface.raw_line_coordinates is unprojected SRID 2926 data, not
// a real column -- reprojecting it into a location value is
// reprojectCoordinates.ts's job and isn't wired up yet. Omitting it here
// (rather than sending it as a bogus field) means a real upsert fails
// clearly on the NOT NULL constraint instead of erroring on an unknown
// column or silently inserting a row with no geometry.
function buildBlockfaceRow(blockface: AssembledBlockface & { source_element_key: number }): Record<string, unknown> {
  return {
    source_element_key: blockface.source_element_key,
    street_name: blockface.street_name,
    cross_street_from: blockface.cross_street_from,
    cross_street_to: blockface.cross_street_to,
    side_of_street: blockface.side_of_street,
    is_paid: blockface.is_paid,
    hourly_rate_usd: blockface.hourly_rate_usd,
    operating_days: blockface.operating_days,
    operating_hours_start: blockface.operating_hours_start,
    operating_hours_end: blockface.operating_hours_end,
  };
}

// Writes one blockface and its full rate-tier schedule to Supabase.
//
// blockfaces is upserted on (source_element_key, side_of_street) -- the same
// pair migrations/005_add_source_element_key.sql makes unique -- so
// re-running an import updates the existing row instead of duplicating it.
//
// rate_tiers has no natural per-tier unique key to upsert against
// individually (a tier can move to a different time window or rate between
// import runs with nothing stable to match old-to-new), so this replaces the
// full set instead: delete every existing rate_tiers row for this
// blockface_id, then insert the freshly assembled ones. Simpler and safer
// than diffing old vs new tiers, at the cost of a brief window with zero
// rate_tiers for this blockface if the process is interrupted mid-write.
//
// The two operations aren't wrapped in a database transaction (this client
// interface doesn't expose one), so a rate_tiers failure after a successful
// blockfaces upsert leaves real partial state behind -- the blockfaces row
// is written, but its rate_tiers may be empty or stale. That's thrown as an
// explicit error identifying the blockface, rather than swallowed or
// reported the same way as a total failure, so the caller knows this
// specific row needs re-running rather than the whole import being clean.
export async function upsertBlockface(
  supabaseClient: SupabaseClientLike,
  blockface: AssembledBlockface & { source_element_key: number },
  rateTiers: AssembledRateTier[],
): Promise<UpsertBlockfaceResult> {
  const { data: upsertedBlockface, error: blockfaceError } = await supabaseClient
    .from("blockfaces")
    .upsert(buildBlockfaceRow(blockface), { onConflict: "source_element_key,side_of_street" })
    .select("id")
    .single();

  if (blockfaceError !== null || upsertedBlockface === null) {
    throw new Error(
      `upsertBlockface: blockfaces upsert failed for source_element_key=${blockface.source_element_key}, side_of_street=${blockface.side_of_street}: ${blockfaceError?.message ?? "no row returned"}`,
    );
  }

  const blockfaceId = upsertedBlockface.id;

  const { error: deleteError } = await supabaseClient.from("rate_tiers").delete().eq("blockface_id", blockfaceId);

  if (deleteError !== null) {
    throw new Error(
      `upsertBlockface: blockfaces upsert succeeded (id=${blockfaceId}) but deleting its existing rate_tiers failed: ${deleteError.message}. Partial failure -- the blockfaces row was written but rate_tiers may still hold stale data; re-run the import for this blockface.`,
    );
  }

  if (rateTiers.length === 0) {
    return { blockfaceId };
  }

  const { error: insertError } = await supabaseClient
    .from("rate_tiers")
    .insert(rateTiers.map((tier) => ({ ...tier, blockface_id: blockfaceId })));

  if (insertError !== null) {
    throw new Error(
      `upsertBlockface: blockfaces upsert succeeded (id=${blockfaceId}) and its old rate_tiers were deleted, but inserting the new rate_tiers failed: ${insertError.message}. Partial failure -- the blockfaces row now has zero rate_tiers; re-run the import for this blockface.`,
    );
  }

  return { blockfaceId };
}
