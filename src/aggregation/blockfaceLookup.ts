import { jsDayToIsoDay } from "../utils/dateHelpers.ts";
import type { SupabaseQueryResult } from "../importers/upsertBlockface.ts";
import { calculateOccupancyRatio } from "./calculateOccupancyRatio.ts";

// --- Blockface lookup -------------------------------------------------

export interface BlockfaceLookupRow {
  id: string;
  source_element_key: number;
  side_of_street: string;
}

// Minimal, table-name-generic client shape, same DI pattern as
// upsertBlockface.ts/import-off-street-facilities.ts -- this is a plain
// read (select with no filters), not an upsert, so it gets its own small
// interface rather than reusing SupabaseTableBuilder's upsert-shaped one.
export interface BlockfaceLookupSupabaseTableBuilder {
  select(columns: string): PromiseLike<SupabaseQueryResult<BlockfaceLookupRow[]>>;
}

export interface BlockfaceLookupSupabaseClient {
  from(table: string): BlockfaceLookupSupabaseTableBuilder;
}

// Shared between buildBlockfaceLookup (writing keys) and normalizeReading
// (reading them) so the two can never drift out of sync with each other.
export function buildLookupKey(sourceElementKey: number, sideOfStreet: string): string {
  return `${sourceElementKey}:${sideOfStreet}`;
}

// Reads every blockfaces row's identity columns and builds an in-memory
// lookup from (source_element_key, side_of_street) to id, so normalizing a
// batch of raw readings doesn't need one DB round-trip per reading.
export async function buildBlockfaceLookup(supabaseClient: BlockfaceLookupSupabaseClient): Promise<Map<string, string>> {
  const { data, error } = await supabaseClient.from("blockfaces").select("id, source_element_key, side_of_street");

  if (error !== null) {
    throw new Error(`buildBlockfaceLookup: reading blockfaces failed: ${error.message}`);
  }

  const lookup = new Map<string, string>();
  for (const row of data ?? []) {
    lookup.set(buildLookupKey(row.source_element_key, row.side_of_street), row.id);
  }
  return lookup;
}

// --- Reading normalization ---------------------------------------------

export interface RawReading {
  sourceElementKey: number;
  sideOfStreet: string;
  occupancyDateTime: string;
  paidOccupancy: number;
  parkingSpaceCount: number;
}

export interface NormalizedReading {
  matched: true;
  blockfaceId: string;
  isoDay: number;
  hour: number;
  ageInDays: number;
  occupancyRatio: number;
}

export interface UnmatchedReading {
  matched: false;
  sourceElementKey: number;
  sideOfStreet: string;
}

export type NormalizeReadingResult = NormalizedReading | UnmatchedReading;

interface OccupancyDateTimeComponents {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
}

// occupancydatetime arrives from Socrata as e.g. "2026-07-30T17:38:00.000",
// with no timezone marker at all. Live-verified (full rke9-rsvs dataset,
// grouped by hour): readings cluster entirely between 8am and 9pm, matching
// Seattle's paid-parking operating hours -- confirming these are naive
// Pacific-local wall-clock timestamps, not UTC. This regex just extracts
// those numeric components; nothing here treats the string as UTC or as
// local-to-this-machine, both of which would be wrong.
const OCCUPANCY_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/;

function parseOccupancyDateTimeComponents(occupancyDateTime: string): OccupancyDateTimeComponents {
  const match = OCCUPANCY_DATETIME_PATTERN.exec(occupancyDateTime);
  if (match === null) {
    throw new Error(
      `normalizeReading: occupancyDateTime "${occupancyDateTime}" does not match the expected "YYYY-MM-DDTHH:mm:ss[.sss]" shape`,
    );
  }
  const [, year, month, day, hour, minute, second] = match;
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
  };
}

// isoDay and hour are read directly from the naive wall-clock components
// above -- no timezone conversion needed for either, since they're already
// the Pacific calendar date and clock hour as recorded, not an
// absolute-instant comparison. getUTCDay() (not getDay()) is deliberate:
// Date.UTC()+getUTCDay() reliably gives the calendar day-of-week for those
// Y/M/D numbers on every machine regardless of its local timezone, whereas
// getDay() on a Date built from ambiguous input would reintroduce the exact
// local-timezone dependence this function exists to avoid.
function getIsoDayOfWeek(components: OccupancyDateTimeComponents): number {
  const utcMidnightMillis = Date.UTC(components.year, components.month - 1, components.day);
  return jsDayToIsoDay(new Date(utcMidnightMillis).getUTCDay());
}

const SOURCE_TIME_ZONE = "America/Los_Angeles";
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

// Pacific time's UTC offset changes twice a year for DST (-7 in summer,
// -8 in winter), so it can't be hardcoded -- this asks the platform's own
// timezone database (via Intl, no new dependency) what offset applies at
// approximately the given instant, e.g. "GMT-7".
function getTimeZoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" }).formatToParts(instant);
  const offsetPart = parts.find((part) => part.type === "timeZoneName");
  const match = offsetPart ? /^GMT([+-]\d+)$/.exec(offsetPart.value) : null;
  if (match === null || match[1] === undefined) {
    throw new Error(`normalizeReading: could not determine the UTC offset for ${timeZone} near ${instant.toISOString()}`);
  }
  return Number(match[1]) * 60;
}

// ageInDays (unlike isoDay/hour) needs a true absolute instant, since it's
// computed against `now` -- so this resolves the naive Pacific-local
// components to the real UTC instant they represent, DST-aware.
//
// asIfUtcMillis reinterprets the naive Y/M/D/H/M/S numbers as if they were
// already UTC, purely to get a rough instant to ask Intl "what offset does
// Pacific observe around here" -- not treated as an actual UTC timestamp.
// This can only be wrong within the handful of hours immediately around a
// DST transition (rare, ~twice a year), an accepted limitation of this
// technique versus a full timezone library.
function resolveOccupancyInstant(components: OccupancyDateTimeComponents): Date {
  const asIfUtcMillis = Date.UTC(
    components.year,
    components.month - 1,
    components.day,
    components.hour,
    components.minute,
    components.second,
  );
  const offsetMinutes = getTimeZoneOffsetMinutes(new Date(asIfUtcMillis), SOURCE_TIME_ZONE);
  return new Date(asIfUtcMillis - offsetMinutes * MS_PER_MINUTE);
}

// Pure: no network/DB access, so this is fully testable without a mock
// Supabase client -- buildBlockfaceLookup does the one DB read up front,
// and its result is passed in here as a plain Map.
export function normalizeReading(reading: RawReading, lookup: Map<string, string>, now: Date): NormalizeReadingResult {
  const blockfaceId = lookup.get(buildLookupKey(reading.sourceElementKey, reading.sideOfStreet));
  if (blockfaceId === undefined) {
    // A reading can legitimately reference a blockface this project never
    // imported -- e.g. one of the 48 ELMNTKEYs import-blockfaces.ts
    // documented as skipped (see CLAUDE.md's Known open questions). That's
    // an expected, real gap, not a bug worth crashing the whole aggregation
    // run over, so this returns a clear unmatched result instead of throwing.
    return { matched: false, sourceElementKey: reading.sourceElementKey, sideOfStreet: reading.sideOfStreet };
  }

  const components = parseOccupancyDateTimeComponents(reading.occupancyDateTime);
  const isoDay = getIsoDayOfWeek(components);
  const hour = components.hour;

  const occupancyInstant = resolveOccupancyInstant(components);
  const ageInDays = (now.getTime() - occupancyInstant.getTime()) / MS_PER_DAY;

  const occupancyRatio = calculateOccupancyRatio(reading.paidOccupancy, reading.parkingSpaceCount);

  return { matched: true, blockfaceId, isoDay, hour, ageInDays, occupancyRatio };
}
