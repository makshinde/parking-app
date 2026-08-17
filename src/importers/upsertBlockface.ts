import type { AssembledBlockface, AssembledRateTier } from "./assembleBlockface";
import { formatLineForPostgis } from "./formatLineForPostgis";

// Minimal structural subset of the @supabase/supabase-js client used here --
// deliberately not the real library's types, so this module (and its tests)
// don't require an actual Supabase project or the real dependency. Any
// client exposing this shape (the real one included) can be passed in.
//
// Builder methods are typed as PromiseLike, not Promise: the real client's
// query builders (PostgrestBuilder) are thenable/awaitable but don't declare
// the full Promise interface (.catch()/.finally()/etc.), which this module
// never calls directly -- only ever `await`s. Typing these as Promise (as
// an earlier version of this file did) is stricter than what's actually
// used and made the real client fail to structurally satisfy this interface
// the first time it was actually plugged in (import-blockfaces.ts).
export interface SupabaseQueryResult<T = unknown> {
  data: T | null;
  error: { message: string } | null;
}

export interface SupabaseUpsertBuilder {
  select(columns: string): {
    single(): PromiseLike<SupabaseQueryResult<{ id: string }>>;
  };
}

export interface SupabaseDeleteBuilder {
  eq(column: string, value: unknown): PromiseLike<SupabaseQueryResult>;
}

export interface SupabaseTableBuilder {
  upsert(values: Record<string, unknown>, options: { onConflict: string }): SupabaseUpsertBuilder;
  delete(): SupabaseDeleteBuilder;
  insert(values: Record<string, unknown>[]): PromiseLike<SupabaseQueryResult>;
}

export interface SupabaseClientLike {
  from(table: string): SupabaseTableBuilder;
}

export interface UpsertBlockfaceResult {
  blockfaceId: string;
}

// Used in every thrown error so a batch import (hundreds of blockfaces) can
// be grepped for exactly which source row a failure belongs to.
// source_element_key/side_of_street are the source's own identifiers, known
// before any DB round-trip; the Supabase id is only available once the
// blockfaces upsert itself has succeeded.
function describeBlockface(
  blockface: { source_element_key: number; side_of_street: string },
  blockfaceId?: string,
): string {
  const idPart = blockfaceId !== undefined ? `, id=${blockfaceId}` : "";
  return `source_element_key=${blockface.source_element_key}, side_of_street=${blockface.side_of_street}${idPart}`;
}

// blockfaces.location is a PostGIS geography column (NOT NULL), not a raw
// coordinates array -- AssembledBlockface.raw_line_coordinates (unprojected
// SRID 2926) is reprojected and formatted as SRID=4326 WKT via
// formatLineForPostgis before being sent, closing the gap flagged in PR #16
// where this field was previously omitted entirely.
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
    location: formatLineForPostgis(blockface.raw_line_coordinates),
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
      `upsertBlockface: blockfaces upsert failed for ${describeBlockface(blockface)}: ${blockfaceError?.message ?? "no row returned"}`,
    );
  }

  const blockfaceId = upsertedBlockface.id;

  const { error: deleteError } = await supabaseClient.from("rate_tiers").delete().eq("blockface_id", blockfaceId);

  if (deleteError !== null) {
    throw new Error(
      `upsertBlockface: blockfaces upsert succeeded (${describeBlockface(blockface, blockfaceId)}) but deleting its existing rate_tiers failed: ${deleteError.message}. Partial failure -- the blockfaces row was written but rate_tiers may still hold stale data; re-run the import for this blockface.`,
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
      `upsertBlockface: blockfaces upsert succeeded (${describeBlockface(blockface, blockfaceId)}) and its old rate_tiers were deleted, but inserting the new rate_tiers failed: ${insertError.message}. Partial failure -- the blockfaces row now has zero rate_tiers; re-run the import for this blockface.`,
    );
  }

  return { blockfaceId };
}
