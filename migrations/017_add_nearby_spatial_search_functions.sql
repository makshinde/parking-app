-- Adds two spatial-search RPC functions for the future Edge Function's
-- "find real parking options near this geocoded point" request path:
-- nearby_blockfaces and nearby_off_street_facilities. Both are read-only,
-- SECURITY INVOKER (the plpgsql default -- deliberately not specified as
-- SECURITY DEFINER), so each runs under the calling role's own RLS
-- context rather than bypassing it; safe to run on its own against the
-- live Supabase project.
--
-- Both tables' location columns are already `geography(..., 4326)` with a
-- GiST index (see schema.sql) -- geography's distance/proximity functions
-- (ST_DWithin, ST_Distance, the <-> KNN operator) operate in plain meters
-- by design, so no unit conversion is needed anywhere in these functions.
--
-- ST_DWithin against blockfaces.location (a LineString) matches on "any
-- point along the line is within the radius" -- the minimum distance from
-- the center point to the closest point on the line, not a requirement
-- that an endpoint or the whole line be inside. This was live-verified
-- (not just assumed from the PostGIS docs) against a real blockface with
-- meaningfully asymmetric endpoint distances -- see this PR's description
-- for the real numbers. off_street_facilities.location (a Point) is
-- handled by the exact same ST_DWithin/ST_Distance calls: a point's
-- "closest point to itself" is trivially itself, so no separate function
-- or special-casing is needed for the simpler case.
--
-- radius_meters rejects outright (RAISE EXCEPTION) outside (0, 1000],
-- rather than clamping -- this value comes from the app's own UI controls
-- (a fixed default of 200m, adjustable up to a stated max of 1000m), not
-- free-form user input, so an out-of-range value signals a real bug in
-- the caller, not imprecise-but-real intent. Same reject-don't-clamp
-- reasoning resolveRequestTime.ts (src/scoring/) already uses for the
-- app's 7-day request-time horizon.
--
-- Both functions return the full rate_tiers / off_street_rate_tiers
-- schedule as a nested JSON array (via a LEFT JOIN LATERAL + jsonb_agg,
-- coalesced to '[]'::jsonb when a blockface/facility has no tiers), not
-- just blockfaces.starting_rate_usd. CLAUDE.md's Pricing data section is
-- explicit that starting_rate_usd alone must never be shown to an end
-- user as "the" rate -- since this RPC is the frontend's actual pricing
-- data source, it needs the full schedule inline, not a follow-up
-- per-blockface query. off_street_facilities never had a summary rate
-- column at all (see its own schema.sql comment), so off_street_rate_tiers
-- is the only source of pricing there regardless.
--
-- Results are ordered nearest-first via the `<->` KNN distance operator
-- (not `ORDER BY ST_Distance(...)`), so the existing GiST index can assist
-- the ordering in addition to the ST_DWithin filter.
--
-- IMPORTANT, live-confirmed prerequisite NOT fixed by this migration:
-- off_street_rate_tiers currently has RLS enabled but NO public-read
-- policy -- live-verified directly against the anon key: blockfaces (2792
-- rows), off_street_facilities (685 rows), and rate_tiers (8566 rows) are
-- all readable via the anon key as expected, but off_street_rate_tiers
-- returns 0 rows via the anon key despite genuinely holding 101 real rows
-- (confirmed via the service-role key). Under nearby_off_street_facilities'
-- SECURITY INVOKER execution, an anon caller would therefore silently get
-- an empty rate_tiers array for every facility, even ones with real pricing
-- data, until this is fixed. Per this project's established convention
-- (see schema.sql's "No CREATE POLICY statements" comments on the
-- internal-bookkeeping tables), public-read policies are added manually
-- via the Supabase dashboard, outside these tracked migration files, so
-- this migration deliberately does not add one here either -- it must be
-- added manually before nearby_off_street_facilities' pricing data will
-- work for anon callers:
--   CREATE POLICY "Public read access" ON off_street_rate_tiers
--     FOR SELECT TO anon, authenticated USING (true);

CREATE OR REPLACE FUNCTION nearby_blockfaces(
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
  distance_meters double precision
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
      ST_Distance(b.location, center) AS distance_meters
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
  'Finds blockfaces within radius_meters (plain meters, default 200, capped at 1000 -- out-of-range rejects rather than clamps) of the given center point, nearest first. ST_DWithin against the LineString geography column matches on the closest point along the line, not requiring the whole line or an endpoint to be inside. Returns the full rate_tiers schedule as nested JSON (never just starting_rate_usd -- see CLAUDE.md''s Pricing data section) plus the line geometry as GeoJSON for rendering and the real computed distance in meters. SECURITY INVOKER (the default): runs under the calling role''s own RLS context.';

REVOKE ALL ON FUNCTION nearby_blockfaces(double precision, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nearby_blockfaces(double precision, double precision, double precision) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION nearby_off_street_facilities(
  center_lon double precision,
  center_lat double precision,
  radius_meters double precision DEFAULT 200
)
RETURNS TABLE (
  id uuid,
  name text,
  address text,
  capacity integer,
  facility_type text,
  operator_name text,
  rate_tiers jsonb,
  location_geojson json,
  distance_meters double precision
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  center geography(Point, 4326);
BEGIN
  IF radius_meters <= 0 OR radius_meters > 1000 THEN
    RAISE EXCEPTION 'nearby_off_street_facilities: radius_meters must be greater than 0 and at most 1000, got %', radius_meters;
  END IF;

  center := ST_SetSRID(ST_MakePoint(center_lon, center_lat), 4326)::geography;

  RETURN QUERY
    SELECT
      f.id,
      f.name,
      f.address,
      f.capacity,
      f.facility_type,
      f.operator_name,
      COALESCE(rt_agg.tiers, '[]'::jsonb) AS rate_tiers,
      ST_AsGeoJSON(f.location)::json AS location_geojson,
      ST_Distance(f.location, center) AS distance_meters
    FROM off_street_facilities f
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_build_object(
          'duration_type', rt.duration_type,
          'rate_usd', rt.rate_usd,
          'rate_note', rt.rate_note
        )
        ORDER BY rt.duration_type
      ) AS tiers
      FROM off_street_rate_tiers rt
      WHERE rt.facility_id = f.id
    ) rt_agg ON true
    WHERE ST_DWithin(f.location, center, radius_meters)
    ORDER BY f.location <-> center;
END;
$$;

COMMENT ON FUNCTION nearby_off_street_facilities(double precision, double precision, double precision) IS
  'Finds off_street_facilities within radius_meters (plain meters, default 200, capped at 1000 -- out-of-range rejects rather than clamps) of the given center point, nearest first. Same ST_DWithin/ST_Distance calls as nearby_blockfaces, applied to a Point geography column instead of a LineString -- a point''s closest point to itself is trivially itself, so no special-casing is needed. Returns the full off_street_rate_tiers schedule as nested JSON (this table never had a single summary rate column -- see its own schema.sql comment) plus the point geometry as GeoJSON and the real computed distance in meters. SECURITY INVOKER (the default): runs under the calling role''s own RLS context -- see this migration''s header comment for a live-confirmed missing RLS policy on off_street_rate_tiers that must be added manually before this function''s pricing data will be visible to anon callers.';

REVOKE ALL ON FUNCTION nearby_off_street_facilities(double precision, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nearby_off_street_facilities(double precision, double precision, double precision) TO anon, authenticated, service_role;
