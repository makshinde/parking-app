import { reprojectLine } from "../utils/reprojectCoordinates.ts";

// A WKT LineString needs at least 2 points to be a valid line -- a single
// point or an empty list isn't a degraded-but-usable line, it's structurally
// not a line at all, so this throws rather than clamping or padding (same
// reasoning as reprojectCoordinates' non-finite-coordinate check).
function assertEnoughPointsForLine(coordinates: unknown[]): void {
  if (coordinates.length < 2) {
    throw new Error(`formatLineForPostgis: a LineString needs at least 2 points, got ${coordinates.length}`);
  }
}

// Reprojects raw SRID 2926 line coordinates (as produced by
// assembleBlockface.ts's raw_line_coordinates) to SRID 4326 and formats the
// result as PostGIS-compatible WKT with an explicit SRID prefix, e.g.
// "SRID=4326;LINESTRING(-122.35 47.62, -122.34 47.61)".
//
// WKT/PostGIS coordinate order is (x y), i.e. (longitude latitude) --
// reprojectCoordinates.reprojectLine instead returns {lat, lon} objects, the
// opposite order, so building the string as `${lon} ${lat}` (not `${lat}
// ${lon}`) is deliberate, not incidental key order.
export function formatLineForPostgis(rawLineCoordinates: [number, number][]): string {
  assertEnoughPointsForLine(rawLineCoordinates);

  const points = reprojectLine(rawLineCoordinates);
  const pointsWkt = points.map(({ lat, lon }) => `${lon} ${lat}`).join(", ");
  return `SRID=4326;LINESTRING(${pointsWkt})`;
}
