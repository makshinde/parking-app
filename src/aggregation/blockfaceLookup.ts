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
// read (select with no filters, but paginated via .range()), not an
// upsert, so it gets its own small interface rather than reusing
// SupabaseTableBuilder's upsert-shaped one.
export interface BlockfaceLookupSupabaseTableBuilder {
  select(columns: string): {
    range(from: number, to: number): PromiseLike<SupabaseQueryResult<BlockfaceLookupRow[]>>;
  };
}

export interface BlockfaceLookupSupabaseClient {
  from(table: string): BlockfaceLookupSupabaseTableBuilder;
}

// Shared between buildBlockfaceLookup (writing keys) and normalizeReading
// (reading them) so the two can never drift out of sync with each other.
export function buildLookupKey(sourceElementKey: number, sideOfStreet: string): string {
  return `${sourceElementKey}:${sideOfStreet}`;
}

// Supabase's PostgREST layer caps a single response at 1000 rows by
// default regardless of how many rows actually match, silently -- live-
// verified this session (blockfaces has 2792 real rows; an earlier,
// unpaginated version of this function returned only the first 1000 with
// no error or warning of any kind). Paginating via .range() keeps every
// request comfortably under that default regardless of table size, same
// page-then-stop-on-a-short-page pattern already used in
// fetchArcGisFeatures.ts and fetchSocrataRecords.ts.
const BLOCKFACE_LOOKUP_PAGE_SIZE = 1000;

async function fetchBlockfaceLookupPage(supabaseClient: BlockfaceLookupSupabaseClient, offset: number): Promise<BlockfaceLookupRow[]> {
  const { data, error } = await supabaseClient
    .from("blockfaces")
    .select("id, source_element_key, side_of_street")
    .range(offset, offset + BLOCKFACE_LOOKUP_PAGE_SIZE - 1);

  if (error !== null) {
    throw new Error(`buildBlockfaceLookup: reading blockfaces failed: ${error.message}`);
  }

  return data ?? [];
}

// Reads every blockfaces row's identity columns and builds an in-memory
// lookup from (source_element_key, side_of_street) to id, so normalizing a
// batch of raw readings doesn't need one DB round-trip per reading.
export async function buildBlockfaceLookup(supabaseClient: BlockfaceLookupSupabaseClient): Promise<Map<string, string>> {
  const lookup = new Map<string, string>();
  let offset = 0;

  while (true) {
    const page = await fetchBlockfaceLookupPage(supabaseClient, offset);
    for (const row of page) {
      lookup.set(buildLookupKey(row.source_element_key, row.side_of_street), row.id);
    }

    // A page with fewer rows than the page size is necessarily the last
    // page. A page with exactly BLOCKFACE_LOOKUP_PAGE_SIZE rows might still
    // be the last page (the table could happen to have a row count that's
    // an exact multiple of the page size) -- row count alone can't
    // distinguish that from "there's more," so this always requests the
    // next offset after a full page and relies on a short page to stop,
    // same reasoning as fetchSocrataRecords.ts's own pagination loop.
    if (page.length < BLOCKFACE_LOOKUP_PAGE_SIZE) {
      break;
    }
    offset += BLOCKFACE_LOOKUP_PAGE_SIZE;
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
  // The reading's own recorded calendar year, for calculateRecencyWeight's
  // current-calendar-year component (see that function's own comment).
  // Read directly off the naive Pacific wall-clock components already
  // parsed above -- no extra resolution needed, since (unlike ageInDays)
  // this doesn't involve comparing against an absolute instant, just the
  // year as recorded.
  readingYear: number;
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

// Lightweight companion to normalizeReading for callers that only need a
// reading's isoDay/hour bucket -- e.g. partitioning a large batch of raw
// readings by bucket before matching each one to a blockface -- without
// paying for blockface lookup or the DST-aware ageInDays resolution below.
// Reuses the same parsing/day-of-week logic normalizeReading itself uses,
// so the two can never drift out of sync with each other.
export function extractIsoDayAndHour(occupancyDateTime: string): { isoDay: number; hour: number } {
  const components = parseOccupancyDateTimeComponents(occupancyDateTime);
  return { isoDay: getIsoDayOfWeek(components), hour: components.hour };
}

const SOURCE_TIME_ZONE = "America/Los_Angeles";
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

// Constructing an Intl.DateTimeFormat is expensive (V8/ICU-backed, far
// costlier than a plain object) -- live-verified this session: calling
// `new Intl.DateTimeFormat(...)` fresh on every invocation of
// getTimeZoneOffsetMinutes (i.e. once per matched reading) OOM-crashed a
// single backfill combo after ~1 million calls and ~73 minutes, with the
// crash's own native stack trace terminating inside
// Intl.DateTimeFormat's formatToParts. A formatter's output only depends
// on its construction options and the instant passed to format() --
// nothing about it needs to vary per call here, so it's built once per
// distinct timeZone and reused for every instant after that. A Map keyed
// by timeZone rather than a single cached constant, in case this is ever
// used for more than SOURCE_TIME_ZONE later.
const dateTimeFormatCache = new Map<string, Intl.DateTimeFormat>();

function getCachedDateTimeFormat(timeZone: string): Intl.DateTimeFormat {
  const cached = dateTimeFormatCache.get(timeZone);
  if (cached !== undefined) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" });
  dateTimeFormatCache.set(timeZone, formatter);
  return formatter;
}

// Pacific time's UTC offset changes twice a year for DST (-7 in summer,
// -8 in winter), so it can't be hardcoded -- this asks the platform's own
// timezone database (via Intl, no new dependency) what offset applies at
// approximately the given instant, e.g. "GMT-7".
function getTimeZoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = getCachedDateTimeFormat(timeZone).formatToParts(instant);
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

  return { matched: true, blockfaceId, isoDay, hour, ageInDays, occupancyRatio, readingYear: components.year };
}

// Cached the same way getCachedDateTimeFormat's formatter is (built once,
// reused) -- a separate formatter/cache since this one extracts a plain
// calendar year, not a UTC offset, so it needs different Intl options and
// can't share that function's cache entry. Only ever called once per batch
// (by this project's own callers, e.g. groupReadingsByBlockface,
// foldReadingsIntoAccumulators -- "now" is loop-invariant across every
// reading in one run), not once per reading, so there's no risk of
// repeating the OOM-prone mistake documented above.
let pacificYearFormatter: Intl.DateTimeFormat | undefined;

// "now"'s calendar year, Pacific-local -- the counterpart to readingYear
// above, needed for calculateRecencyWeight's exact-year-match gate. "now"
// is an absolute instant (unlike a reading's own naive wall-clock string),
// so getting its Pacific calendar year genuinely requires this Intl
// resolution, the same reasoning resolveOccupancyInstant uses for ageInDays.
export function getPacificCalendarYear(instant: Date): number {
  if (pacificYearFormatter === undefined) {
    pacificYearFormatter = new Intl.DateTimeFormat("en-US", { timeZone: SOURCE_TIME_ZONE, year: "numeric" });
  }
  return Number(pacificYearFormatter.format(instant));
}
