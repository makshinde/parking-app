import { calculateWeightedStats, type WeightedReading } from "./weightedStats.ts";

// Minimum reading count for a blockface/day-of-week/hour bucket before its
// occupancy_stats row is written. Empirically grounded in the real bucket
// distribution (2025 archive, 7c2e-uany): buckets are bimodal, either 0
// (the blockface genuinely doesn't operate that day/hour) or >= 60 if it
// operates at all (rarer buckets still land >= 120). 30 sits in that
// observed 0/60+ gap as a safe noise-rejection line -- it is NOT verified
// protection for a specific partial-year-coverage scenario; that
// justification was checked directly against the archive and didn't hold
// up (see CLAUDE.md's Architecture section for the full reasoning and the
// real bucket numbers behind it).
export const MIN_READINGS_PER_BUCKET = 30;

export interface BucketStats {
  mean: number;
  stdDev: number;
  sampleCount: number;
}

// Decides whether one bucket has enough readings to write a trustworthy
// occupancy_stats row. Below MIN_READINGS_PER_BUCKET (including zero) this
// returns null -- an explicit "not enough data" skip signal, never a 0 or
// any other value that could be mistaken for a real, confident result. The
// threshold check happens before calculateWeightedStats is ever called,
// since that function throws on empty input rather than returning a
// meaningless mean/stdDev for zero readings.
export function decideBucketStats(readings: WeightedReading[]): BucketStats | null {
  if (readings.length < MIN_READINGS_PER_BUCKET) {
    return null;
  }

  const { mean, stdDev } = calculateWeightedStats(readings);
  return { mean, stdDev, sampleCount: readings.length };
}
