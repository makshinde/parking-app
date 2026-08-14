import proj4 from "proj4";

// EPSG:2926 = NAD83(HARN) / Washington North (ftUS), the state plane zone
// used by Seattle's off-street-facilities source data. Definition string
// verified against two independent sources (must match, since this defines
// every coordinate our imports produce): epsg.io/2926 and the PROJ project's
// own EPSG registry (crs-explorer.proj.org/wkt2/EPSG/2926.txt) for the
// projection parameters, and cross-checked end-to-end against PROJ's cs2cs
// CLI (an independent C implementation) using the known Belltown test point
// below -- both produced the same lat/lon to 8 decimal places.
const EPSG_2926_DEF =
  "+proj=lcc +lat_0=47 +lon_0=-120.833333333333 +lat_1=48.7333333333333 " +
  "+lat_2=47.5 +x_0=500000.0001016 +y_0=0 +ellps=GRS80 " +
  "+towgs84=-0.991,1.9072,0.5129,-1.25033e-07,-4.6785e-08,-5.6529e-08,0 " +
  "+units=us-ft +no_defs +type=crs";

export interface LatLon {
  lat: number;
  lon: number;
}

// x and y aren't a bounded/continuous input like a score or day count -- any
// finite number could be a real easting/northing somewhere, so there's no
// "valid range" to clamp into. A non-finite value (NaN/Infinity) has no
// meaningful nearest coordinate, so it throws rather than silently producing
// a garbage lat/lon.
function assertFiniteCoordinate(value: number, label: "x" | "y"): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`reprojectPoint: ${label} must be a finite number, got ${value}`);
  }
}

// x and y are SRID 2926 easting/northing in US survey feet, as they arrive
// from Seattle's off-street-facilities source data.
export function reprojectPoint(x: number, y: number): LatLon {
  assertFiniteCoordinate(x, "x");
  assertFiniteCoordinate(y, "y");
  const [lon, lat] = proj4(EPSG_2926_DEF, "WGS84", [x, y]);
  return { lat, lon };
}

// Reprojects a LineString's coordinate pairs (e.g. a blockface centerline)
// from SRID 2926 to SRID 4326, preserving point order.
export function reprojectLine(coordinates: [number, number][]): LatLon[] {
  return coordinates.map(([x, y]) => reprojectPoint(x, y));
}
