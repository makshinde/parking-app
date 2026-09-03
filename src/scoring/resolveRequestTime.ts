import { jsDayToIsoDay } from "../utils/dateHelpers.ts";
import { MAX_DAYS_IN_FUTURE } from "./confidenceScore.ts";

// Same Pacific timezone as blockfaceLookup.ts's SOURCE_TIME_ZONE --
// predictions are always resolved in Pacific local time, DST-aware, the
// same reasoning that constant exists for.
const REQUEST_TIME_ZONE = "America/Los_Angeles";
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

export type QuickTimeOption = "right_now" | "in_10_minutes" | "in_30_minutes" | "in_1_hour";

// "right_now" is deliberately NOT offset 0 -- a prediction for the literal
// current instant would be stale by the time the response reaches the
// caller, and offset 0 also makes daysInFuture exactly 0, which reads as
// "no forecast horizon" rather than "as soon as possible." A 1-minute
// floor keeps it a genuine (if tiny) future request like every other
// quick option, with no special-casing needed downstream.
const QUICK_OPTION_OFFSET_MINUTES: Record<QuickTimeOption, number> = {
  right_now: 1,
  in_10_minutes: 10,
  in_30_minutes: 30,
  in_1_hour: 60,
};

// A request body arrives as parsed-but-untyped JSON at the Edge Function
// boundary, so QuickTimeOption's compile-time union doesn't actually
// protect this function from a malformed "option" value at runtime --
// isQuickTimeOption below re-validates it explicitly rather than trusting
// the type alone.
const QUICK_TIME_OPTIONS: readonly QuickTimeOption[] = ["right_now", "in_10_minutes", "in_30_minutes", "in_1_hour"];

function isQuickTimeOption(value: string): value is QuickTimeOption {
  return (QUICK_TIME_OPTIONS as readonly string[]).includes(value);
}

// The "specific" case takes an already-resolved absolute instant (a Date),
// not a raw wire-format string -- parsing whatever format the eventual
// request body actually uses (an offset-bearing ISO string, most likely)
// is a separate, request-parsing-layer concern, not this function's job.
// Keeping the boundary here is what keeps this module itself free of any
// wire-format assumptions.
export type PredictionTimeRequest = { type: "quick"; option: QuickTimeOption } | { type: "specific"; instant: Date };

export interface ResolvedRequestTime {
  isoDay: number;
  hour: number;
  daysInFuture: number;
}

interface PacificDateComponents {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
}

// Constructing an Intl.DateTimeFormat is expensive -- same caching
// discipline as blockfaceLookup.ts's getCachedDateTimeFormat/
// pacificYearFormatter, built to avoid the live-confirmed OOM crash
// documented there from constructing one fresh per call. A formatter's
// output only depends on its construction options and the instant handed
// to format()/formatToParts(), so one shared instance covers every call
// here.
let pacificComponentsFormatter: Intl.DateTimeFormat | undefined;

function getPacificComponentsFormatter(): Intl.DateTimeFormat {
  if (pacificComponentsFormatter === undefined) {
    // hourCycle: "h23" live-verified (this session) to format Pacific
    // midnight as "00", not "24" -- unlike the *default* hour cycle for
    // this locale/options shape, which live-verified renders midnight as
    // 12-hour "12 AM" instead of a plain 0-23 hour. Explicit hourCycle is
    // therefore required here, not just stylistic.
    pacificComponentsFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: REQUEST_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    });
  }
  return pacificComponentsFormatter;
}

// Resolves an absolute instant to its Pacific-local calendar date and
// clock hour, DST-aware -- the reverse direction of blockfaceLookup.ts's
// resolveOccupancyInstant (which goes from naive Pacific wall-clock
// components to an absolute instant; this goes from an absolute instant to
// Pacific wall-clock components). Because the input here is already an
// exact instant (not the approximate one resolveOccupancyInstant has to
// work from), formatToParts can be asked directly for the real Pacific
// components with no DST-transition-hour caveat to accept.
function resolvePacificComponents(instant: Date): PacificDateComponents {
  const parts = getPacificComponentsFormatter().formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (part === undefined) {
      throw new Error(
        `resolveRequestTime: could not extract "${type}" from Pacific-local formatting of ${instant.toISOString()}`,
      );
    }
    return Number(part.value);
  };
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") };
}

// Same UTC-midnight-then-getUTCDay() technique as blockfaceLookup.ts's
// getIsoDayOfWeek, reused rather than reinvented: once an instant is
// reduced to plain Y/M/D calendar components with no timezone attached,
// finding its day-of-week is a timezone-independent calendar computation.
function getIsoDayOfWeek(components: PacificDateComponents): number {
  const utcMidnightMillis = Date.UTC(components.year, components.month - 1, components.day);
  return jsDayToIsoDay(new Date(utcMidnightMillis).getUTCDay());
}

function resolveTargetInstant(request: PredictionTimeRequest, now: Date): Date {
  if (request.type === "specific") {
    return request.instant;
  }
  if (request.type === "quick") {
    if (!isQuickTimeOption(request.option)) {
      throw new Error(`resolveRequestTime: unrecognized quick option "${request.option}"`);
    }
    const offsetMinutes = QUICK_OPTION_OFFSET_MINUTES[request.option];
    return new Date(now.getTime() + offsetMinutes * MS_PER_MINUTE);
  }
  // request.type is a discrete, fixed-set discriminator ("quick" |
  // "specific") -- same reasoning as jsDayToIsoDay's invalid-day throw
  // (see CLAUDE.md's Handling invalid input section): a request body
  // parsed from untyped JSON could carry any string here, and an
  // unrecognized one signals a real bug upstream, not something with a
  // meaningful nearest-valid fallback.
  const unrecognizedType: string = (request as { type: string }).type;
  throw new Error(`resolveRequestTime: unrecognized request type "${unrecognizedType}"`);
}

// Resolves a prediction request (a quick relative option, or a specific
// future instant) to the Pacific-local ISO day-of-week and hour bucket to
// look up in occupancy_stats, plus how many days into the future the
// request represents (for calculateConfidenceScore's recency term). now is
// passed in explicitly, not read internally via `new Date()`, the same
// testability-driven pattern normalizeReading/foldReadingsIntoAccumulators
// already use for "the actual moment of request."
export function resolveRequestTime(request: PredictionTimeRequest, now: Date): ResolvedRequestTime {
  if (Number.isNaN(now.getTime())) {
    throw new RangeError("resolveRequestTime: now is an invalid Date");
  }
  const targetInstant = resolveTargetInstant(request, now);
  if (Number.isNaN(targetInstant.getTime())) {
    throw new RangeError("resolveRequestTime: resolved target instant is an invalid Date");
  }

  const daysInFuture = (targetInstant.getTime() - now.getTime()) / MS_PER_DAY;

  // "More than a week out" is a hard, discrete request-validation boundary
  // for this app -- the furthest horizon predictions are ever served for
  // (see confidenceScore.ts's MAX_DAYS_IN_FUTURE, reused directly here so
  // the two can never drift out of sync) -- not an estimated quantity with
  // a meaningful "nearest valid" fallback, so this rejects outright rather
  // than clamping, same reasoning CLAUDE.md's Handling invalid input
  // section gives for other discrete/structural boundaries in this
  // project.
  if (daysInFuture > MAX_DAYS_IN_FUTURE) {
    throw new RangeError(
      `resolveRequestTime: requested time is ${daysInFuture.toFixed(2)} days in the future, exceeding the ${MAX_DAYS_IN_FUTURE}-day limit`,
    );
  }
  // A "specific" request resolving to a past instant signals a real bug
  // upstream (the request-building UI should never construct one) rather
  // than imprecise-but-real intent -- same discrete-boundary reasoning as
  // the too-far-future case just above. Quick options can never trigger
  // this (every offset in QUICK_OPTION_OFFSET_MINUTES is positive).
  if (daysInFuture < 0) {
    throw new RangeError(
      `resolveRequestTime: requested time is ${Math.abs(daysInFuture).toFixed(2)} days in the past, not the future`,
    );
  }

  const components = resolvePacificComponents(targetInstant);
  return { isoDay: getIsoDayOfWeek(components), hour: components.hour, daysInFuture };
}
