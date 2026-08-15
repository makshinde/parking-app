import type { ArcGisFeature } from "../utils/fetchArcGisFeatures";
import type { BlockfaceSideResolution, Side } from "./resolveBlockfaceSides";

// Pure assembly: takes already-fetched real-source records for one side of
// one block segment and shapes them into a blockfaces row (plus its
// rate_tiers rows). Deliberately does NOT reproject the line geometry
// (reprojectCoordinates.ts's job, called separately downstream) or fetch
// anything -- this only assembles what it's given.

type DayType = "WKD" | "SAT" | "SUN";
const DAY_TYPES: readonly DayType[] = ["WKD", "SAT", "SUN"];
const TIER_NUMBERS = [1, 2, 3] as const;
type TierNumber = (typeof TIER_NUMBERS)[number];

const ISO_DAYS_WEEKDAY: readonly number[] = [1, 2, 3, 4, 5];
const ISO_DAY_SATURDAY = 6;
const ISO_DAY_SUNDAY = 7;

// blockfaces.operating_hours_start/end are NOT NULL columns (DEFAULT
// '00:00'/'23:59' in schema.sql), so a genuine null isn't a valid value even
// when the hours truly aren't known -- unlike hourly_rate_usd, which IS
// nullable and stays genuinely null in that case. This sentinel represents
// "applies all day" as the closest honest stand-in for "unknown."
const UNKNOWN_HOURS_START = "00:00:00";
const UNKNOWN_HOURS_END = "23:59:00";

export interface AssembledBlockface {
  street_name: string;
  cross_street_from: string;
  cross_street_to: string;
  side_of_street: Side;
  is_paid: boolean;
  hourly_rate_usd: number | null;
  operating_days: number[];
  operating_hours_start: string;
  operating_hours_end: string;
  // SRID 2926 (Washington State Plane North), same units as the source
  // Streets geometry -- NOT reprojected. Reprojection is a separate step.
  raw_line_coordinates: [number, number][];
}

export interface AssembledRateTier {
  day_type: DayType;
  tier_number: TierNumber;
  start_time: string;
  end_time: string;
  rate_usd: number;
}

export interface AssembledBlockfaceResult {
  blockface: AssembledBlockface;
  rateTiers: AssembledRateTier[];
}

function getStringAttribute(feature: ArcGisFeature, key: string): string {
  const value = feature.attributes[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`assembleBlockface: expected a non-empty string for "${key}", got ${JSON.stringify(value)}`);
  }
  return value;
}

function getOptionalNumberAttribute(feature: ArcGisFeature, key: string): number | null {
  const value = feature.attributes[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`assembleBlockface: expected a finite number for "${key}", got ${JSON.stringify(value)}`);
  }
  return value;
}

function minutesToTimeString(minutesSinceMidnight: number): string {
  const hours = Math.floor(minutesSinceMidnight / 60);
  const minutes = minutesSinceMidnight % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`;
}

function extractLineCoordinates(streetsRecord: ArcGisFeature): [number, number][] {
  const paths = streetsRecord.geometry?.paths;
  if (!Array.isArray(paths)) {
    throw new Error("assembleBlockface: streets record is missing usable LineString geometry (paths)");
  }
  const [firstPath] = paths;
  if (!Array.isArray(firstPath) || firstPath.length === 0) {
    throw new Error("assembleBlockface: streets record's first path has no coordinates");
  }

  // A street segment can technically have multiple paths (e.g. a split
  // segment); this project only models a single centerline per blockface,
  // so only the first path is used.
  return firstPath.map((point) => {
    if (!Array.isArray(point) || point.length < 2 || typeof point[0] !== "number" || typeof point[1] !== "number") {
      throw new Error(`assembleBlockface: malformed coordinate in streets geometry: ${JSON.stringify(point)}`);
    }
    return [point[0], point[1]] as [number, number];
  });
}

// The curb-spaces group's stated precondition is "records sharing the same
// ELMNTKEY" for one side; this checks that precondition rather than trusting
// it, since a caller passing a mismatched group is a bug worth catching
// loudly, not silently assembling a blockface from the wrong evidence.
function assertCurbSpacesMatchSide(curbSpaces: ArcGisFeature[], side: Side): void {
  const elmntkeys = new Set<unknown>();
  for (const record of curbSpaces) {
    const recordSide = record.attributes.SIDE;
    if (recordSide !== side) {
      throw new Error(`assembleBlockface: curb-spaces record has SIDE "${String(recordSide)}", expected "${side}"`);
    }
    elmntkeys.add(record.attributes.ELMNTKEY);
  }
  if (elmntkeys.size > 1) {
    throw new Error("assembleBlockface: curb-spaces group spans more than one ELMNTKEY");
  }
}

function earliestTime(times: string[]): string | null {
  let result: string | null = null;
  for (const time of times) {
    if (result === null || time < result) {
      result = time;
    }
  }
  return result;
}

function latestTime(times: string[]): string | null {
  let result: string | null = null;
  for (const time of times) {
    if (result === null || time > result) {
      result = time;
    }
  }
  return result;
}

// Reads WKD_RATE1..3/WKD_START1..3/WKD_END1..3 and the SAT_*/SUN_* siblings.
// A null rate means that tier doesn't apply here (e.g. SUN_RATE1-3 are all
// null at a location with no Sunday paid parking) -- not a data problem,
// just "this tier doesn't exist for this day-type at this pay station."
function extractRateTiers(payStationRecord: ArcGisFeature): AssembledRateTier[] {
  const tiers: AssembledRateTier[] = [];

  for (const dayType of DAY_TYPES) {
    for (const tierNumber of TIER_NUMBERS) {
      const rate = getOptionalNumberAttribute(payStationRecord, `${dayType}_RATE${tierNumber}`);
      if (rate === null) {
        continue;
      }

      const startMinutes = getOptionalNumberAttribute(payStationRecord, `${dayType}_START${tierNumber}`);
      const endMinutes = getOptionalNumberAttribute(payStationRecord, `${dayType}_END${tierNumber}`);
      if (startMinutes === null || endMinutes === null) {
        throw new Error(
          `assembleBlockface: ${dayType}_RATE${tierNumber} is set but ${dayType}_START${tierNumber}/${dayType}_END${tierNumber} is missing`,
        );
      }

      tiers.push({
        day_type: dayType,
        tier_number: tierNumber,
        start_time: minutesToTimeString(startMinutes),
        end_time: minutesToTimeString(endMinutes),
        rate_usd: rate,
      });
    }
  }

  return tiers;
}

function deriveOperatingDays(rateTiers: AssembledRateTier[]): number[] {
  const days = new Set<number>();
  for (const tier of rateTiers) {
    if (tier.day_type === "WKD") {
      for (const day of ISO_DAYS_WEEKDAY) {
        days.add(day);
      }
    } else if (tier.day_type === "SAT") {
      days.add(ISO_DAY_SATURDAY);
    } else {
      days.add(ISO_DAY_SUNDAY);
    }
  }
  return Array.from(days).sort((a, b) => a - b);
}

export function assembleBlockface(
  curbSpaces: ArcGisFeature[],
  streetsRecord: ArcGisFeature,
  payStationRecord: ArcGisFeature | null,
  sideResolution: BlockfaceSideResolution,
): AssembledBlockfaceResult {
  assertCurbSpacesMatchSide(curbSpaces, sideResolution.side);

  const street_name = getStringAttribute(streetsRecord, "STNAME_ORD");
  const cross_street_from = getStringAttribute(streetsRecord, "XSTRLO");
  const cross_street_to = getStringAttribute(streetsRecord, "XSTRHI");
  const raw_line_coordinates = extractLineCoordinates(streetsRecord);

  if (sideResolution.status === "PAID") {
    if (payStationRecord === null) {
      throw new Error("assembleBlockface: side is classified PAID but no payStationRecord was provided");
    }

    const rateTiers = extractRateTiers(payStationRecord);
    const firstWeekdayTier = rateTiers.find((tier) => tier.day_type === "WKD" && tier.tier_number === 1);
    const startTime = earliestTime(rateTiers.map((tier) => tier.start_time));
    const endTime = latestTime(rateTiers.map((tier) => tier.end_time));

    return {
      blockface: {
        street_name,
        cross_street_from,
        cross_street_to,
        side_of_street: sideResolution.side,
        is_paid: true,
        // Only the first weekday tier's rate is surfaced as a single
        // representative number for quick display/filtering; the full
        // multi-tier/multi-day-type schedule lives in rateTiers, not
        // squeezed into one column (see rate_tiers in schema.sql).
        hourly_rate_usd: firstWeekdayTier?.rate_usd ?? null,
        operating_days: deriveOperatingDays(rateTiers),
        operating_hours_start: startTime ?? UNKNOWN_HOURS_START,
        operating_hours_end: endTime ?? UNKNOWN_HOURS_END,
        raw_line_coordinates,
      },
      rateTiers,
    };
  }

  if (payStationRecord !== null) {
    throw new Error(
      `assembleBlockface: side is classified ${sideResolution.status} but a payStationRecord was provided`,
    );
  }

  // UNPAID_CONFIRMED and DATA_GAP both have no pay-station record, so there's
  // no rate/hours data to assemble either way -- they differ only in
  // is_paid.
  return {
    blockface: {
      street_name,
      cross_street_from,
      cross_street_to,
      side_of_street: sideResolution.side,
      // DATA_GAP defaults is_paid to true. Reasoning: DATA_GAP means
      // curb-spaces has SPACETYPE='PS' rows for this side but the
      // pay-station record itself is missing -- i.e. there's real physical
      // evidence a pay station belongs here, we just don't have its current
      // record. Telling a user this spot is free when it's actually a paid
      // zone risks a ticket or tow (a concrete, asymmetric harm); telling
      // them it's paid but the rate is unknown is the more conservative,
      // safer default, and still prompts them to check the posted sign.
      // UNPAID_CONFIRMED, by contrast, reflects genuine confirmed evidence
      // (curb-spaces shows zero SPACETYPE='PS' rows for this side), not a
      // guess, so is_paid = false there is a real finding, not a default.
      is_paid: sideResolution.status === "DATA_GAP",
      hourly_rate_usd: null,
      operating_days: [...ISO_DAYS_WEEKDAY, ISO_DAY_SATURDAY, ISO_DAY_SUNDAY],
      operating_hours_start: UNKNOWN_HOURS_START,
      operating_hours_end: UNKNOWN_HOURS_END,
      raw_line_coordinates,
    },
    rateTiers: [],
  };
}
