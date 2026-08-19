import { normalizeReading, type RawReading } from "./blockfaceLookup.ts";
import { calculateRecencyWeight } from "../scoring/recencyWeight.ts";
import type { WeightedReading } from "./weightedStats.ts";

export interface GroupReadingsResult {
  grouped: Map<string, WeightedReading[]>;
  unmatchedCount: number;
}

// Normalizes a batch of raw readings for one Socrata query (see CLAUDE.md's
// Architecture section -- one blockface/day-of-week/hour bucket's full year
// of readings) and groups them by blockface, ready for
// calculateWeightedStats per blockface. A reading that doesn't match any
// real blockface (see normalizeReading's own comment -- a legitimate,
// expected gap, e.g. one of the 48 ELMNTKEYs import-blockfaces.ts skipped)
// is counted rather than silently dropped, so the caller can log a real,
// honest number instead of readings quietly vanishing with no trace.
export function groupReadingsByBlockface(
  readings: RawReading[],
  lookup: Map<string, string>,
  now: Date,
): GroupReadingsResult {
  const grouped = new Map<string, WeightedReading[]>();
  let unmatchedCount = 0;

  for (const reading of readings) {
    const result = normalizeReading(reading, lookup, now);

    if (!result.matched) {
      unmatchedCount += 1;
      continue;
    }

    const weightedReading: WeightedReading = {
      value: result.occupancyRatio,
      weight: calculateRecencyWeight(result.ageInDays),
    };

    const existing = grouped.get(result.blockfaceId);
    if (existing === undefined) {
      grouped.set(result.blockfaceId, [weightedReading]);
    } else {
      existing.push(weightedReading);
    }
  }

  return { grouped, unmatchedCount };
}
