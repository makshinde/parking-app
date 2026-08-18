import { reprojectPoint } from "../utils/reprojectCoordinates.ts";

// Reprojects a raw SRID 2926 point (as produced by off-street-facilities
// source data) to SRID 4326 and formats the result as PostGIS-compatible
// WKT with an explicit SRID prefix, e.g. "SRID=4326;POINT(-122.35 47.62)".
//
// Sibling to formatLineForPostgis.ts, same lon/lat ordering care: WKT/PostGIS
// coordinate order is (x y), i.e. (longitude latitude) --
// reprojectCoordinates.reprojectPoint instead returns a {lat, lon} object,
// the opposite order, so building the string as `${lon} ${lat}` (not `${lat}
// ${lon}`) is deliberate, not incidental key order.
export function formatPointForPostgis(x: number, y: number): string {
  const { lat, lon } = reprojectPoint(x, y);
  return `SRID=4326;POINT(${lon} ${lat})`;
}
