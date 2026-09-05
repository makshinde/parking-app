// Shared coordinate-bounds validation, used by both handleParkingSearchRequest.ts
// (the "coordinates" searchCenter variant) and handleReverseGeocodeRequest.ts.
// Originally inlined in handleReverseGeocodeRequest.ts (see that file's own
// git history) with a note that it would move here once a second caller
// needed the identical check -- this is that second caller.
//
// Reject (don't clamp) both non-finite and merely out-of-real-world-range
// values. Both call sites' coordinates come from a map widget (Leaflet),
// which cannot structurally produce an out-of-range value from a real
// drag -- so an out-of-range value here signals a bug or a malformed
// manual call, not imprecise-but-real intent, the same reasoning
// reprojectCoordinates.ts's RangeError uses for non-finite input (see
// CLAUDE.md's Handling invalid input section). Unlike a numeric count,
// there's no meaningful "nearest valid" clamp target for a coordinate
// either -- clamping lat=200 to 90 would silently search hundreds of
// miles from where the user actually pointed, which is worse than
// rejecting outright.
export function validateCoordinates(lat: unknown, lon: unknown): string | null {
  if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    return '"lat" must be a finite number between -90 and 90.';
  }
  if (typeof lon !== "number" || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    return '"lon" must be a finite number between -180 and 180.';
  }
  return null;
}
