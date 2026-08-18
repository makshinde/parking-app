const MAX_OCCUPANCY_RATIO = 1;

// parkingSpaceCount is continuous/estimated in the sense that it's a real
// count, not a fixed category -- but a value of 0 or less has no meaningful
// "nearest valid" capacity to clamp toward (there's no such thing as a
// blockface with slightly-negative capacity), so this throws rather than
// clamping, the same reasoning reprojectCoordinates.ts uses for a
// structurally invalid coordinate. This also doubles as the check for a
// non-finite parkingSpaceCount (NaN/Infinity both fail `> 0`).
function assertValidParkingSpaceCount(parkingSpaceCount: number): void {
  if (!Number.isFinite(parkingSpaceCount) || parkingSpaceCount <= 0) {
    throw new RangeError(
      `calculateOccupancyRatio: parkingSpaceCount must be a positive number, got ${parkingSpaceCount}`,
    );
  }
}

// paidOccupancy is a raw sensor/administrative count, prone to the same kind
// of real-world noise recordings elsewhere in this project already clamp
// rather than reject -- see recencyWeight.ts's clampAgeInDays, which clamps
// a negative age to 0 instead of throwing, on the reasoning that a negative
// value there still likely reflects real (if imprecise or glitchy) intent,
// not a structurally meaningless input. A negative occupancy reading is the
// same kind of thing: it can't reflect a real physical count, but 0 is a
// clear, meaningful "nearest valid" value to fall back to, unlike
// parkingSpaceCount <= 0 above (no such value exists for capacity) or a
// NaN/Infinity reading (no direction to clamp in at all). NaN/Infinity are
// still rejected here, since -- unlike "negative" -- there's no nearest
// valid value to clamp either of those toward either.
function clampNegativeOccupancy(paidOccupancy: number): number {
  if (!Number.isFinite(paidOccupancy)) {
    throw new RangeError(`calculateOccupancyRatio: paidOccupancy must be a finite number, got ${paidOccupancy}`);
  }
  if (paidOccupancy < 0) {
    console.warn(`calculateOccupancyRatio: paidOccupancy ${paidOccupancy} is negative, clamping to 0`);
    return 0;
  }
  return paidOccupancy;
}

// paidOccupancy and parkingSpaceCount must come from the same raw reading
// (row), never a cached or separately-joined parkingSpaceCount -- see
// CLAUDE.md's "parkingspacecount ... is not stable across years" note.
// Occupancy reported higher than capacity (ratio > 1) is plausible
// real-world messiness (e.g. a miscount, a temporarily over-capacity block),
// not a structural error -- clamped to 1.0 and logged, not rejected. Exactly
// 1.0 (a fully occupied block) is a legitimate, expected outcome on its own
// and is returned as-is, without a warning.
export function calculateOccupancyRatio(paidOccupancy: number, parkingSpaceCount: number): number {
  assertValidParkingSpaceCount(parkingSpaceCount);
  const safePaidOccupancy = clampNegativeOccupancy(paidOccupancy);

  const ratio = safePaidOccupancy / parkingSpaceCount;

  if (ratio > MAX_OCCUPANCY_RATIO) {
    console.warn(
      `calculateOccupancyRatio: paidOccupancy=${paidOccupancy}, parkingSpaceCount=${parkingSpaceCount} produced a ratio of ${ratio}, exceeding 1.0 -- clamping to 1.0`,
    );
    return MAX_OCCUPANCY_RATIO;
  }

  return ratio;
}
