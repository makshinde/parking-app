-- Adds paidparkingarea/paidparkingsubarea to nearby_blockfaces' output so
-- the live parking-search Edge Function can apply the area-aware
-- occupancy correction (area_occupancy_corrections) per candidate
-- blockface -- the RPC previously had no way to tell the caller which
-- area/subarea (if any) a blockface belongs to. Adding two new, nullable
-- output columns is additive and backward-compatible with every existing
-- caller (see CLAUDE.md's DB-change policy: replacing a function's
-- definition is a safe, cleanly reversible change) -- but Postgres
-- rejects changing a function's RETURNS TABLE column set via a plain
-- CREATE OR REPLACE (42P13: "cannot change return type of existing
-- function... Row type defined by OUT parameters is different"),
-- live-confirmed running this migration, so the old signature must be
-- dropped first.

DROP FUNCTION IF EXISTS nearby_blockfaces(double precision, double precision, double precision);

CREATE FUNCTION nearby_blockfaces(
  center_lon double precision,
  center_lat double precision,
  radius_meters double precision DEFAULT 200
)
RETURNS TABLE (
  id uuid,
  street_name text,
  cross_street_from text,
  cross_street_to text,
  side_of_street text,
  is_paid boolean,
  starting_rate_usd numeric(6, 2),
  operating_days smallint[],
  operating_hours_start time,
  operating_hours_end time,
  rate_tiers jsonb,
  location_geojson json,
  distance_meters double precision,
  paidparkingarea text,
  paidparkingsubarea text
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  center geography(Point, 4326);
BEGIN
  IF radius_meters <= 0 OR radius_meters > 1000 THEN
    RAISE EXCEPTION 'nearby_blockfaces: radius_meters must be greater than 0 and at most 1000, got %', radius_meters;
  END IF;

  center := ST_SetSRID(ST_MakePoint(center_lon, center_lat), 4326)::geography;

  RETURN QUERY
    SELECT
      b.id,
      b.street_name,
      b.cross_street_from,
      b.cross_street_to,
      b.side_of_street,
      b.is_paid,
      b.starting_rate_usd,
      b.operating_days,
      b.operating_hours_start,
      b.operating_hours_end,
      COALESCE(rt_agg.tiers, '[]'::jsonb) AS rate_tiers,
      ST_AsGeoJSON(b.location)::json AS location_geojson,
      ST_Distance(b.location, center) AS distance_meters,
      b.paidparkingarea,
      b.paidparkingsubarea
    FROM blockfaces b
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_build_object(
          'day_type', rt.day_type,
          'tier_number', rt.tier_number,
          'start_time', rt.start_time,
          'end_time', rt.end_time,
          'rate_usd', rt.rate_usd
        )
        ORDER BY rt.day_type, rt.tier_number
      ) AS tiers
      FROM rate_tiers rt
      WHERE rt.blockface_id = b.id
    ) rt_agg ON true
    WHERE ST_DWithin(b.location, center, radius_meters)
    ORDER BY b.location <-> center;
END;
$$;

COMMENT ON FUNCTION nearby_blockfaces(double precision, double precision, double precision) IS
  'Finds blockfaces within radius_meters (plain meters, default 200, capped at 1000 -- out-of-range rejects rather than clamps) of the given center point, nearest first. ST_DWithin against the LineString geography column matches on the closest point along the line, not requiring the whole line or an endpoint to be inside. Returns the full rate_tiers schedule as nested JSON (never just starting_rate_usd -- see CLAUDE.md''s Pricing data section) plus the line geometry as GeoJSON for rendering, the real computed distance in meters, and paidparkingarea/paidparkingsubarea (both nullable -- most blockfaces have no SDOT-designated area) so the caller can apply the area-aware occupancy correction. SECURITY INVOKER (the default): runs under the calling role''s own RLS context.';

REVOKE ALL ON FUNCTION nearby_blockfaces(double precision, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nearby_blockfaces(double precision, double precision, double precision) TO anon, authenticated, service_role;
