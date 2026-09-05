-- Adds reverse_geocode_cache, a persistent cache for LocationIQ reverse-
-- geocoding results (src/geocoding/reverseGeocodeCoordinates.ts), used when
-- a pin gets manually moved/dragged to show an honest, current description
-- of the new location. Mirrors geocode_cache's (migrations/018) shape and
-- reasoning almost exactly -- see that migration's own comment for the
-- full ToS discussion -- with the one real structural difference a
-- coordinate-keyed cache requires instead of a query-text-keyed one.
--
-- coordinate_key is a single text column ("lat,lon", each rounded to 5
-- decimal places, e.g. "47.60978,-122.34222"), not two separate numeric
-- columns with a composite unique constraint -- simpler to upsert
-- (onConflict: "coordinate_key", the exact same pattern geocode_cache's
-- query_text already uses) and avoids float equality-comparison pitfalls
-- on the lookup key. 5 decimal places is ~1.1 meters at this latitude --
-- fine-grained enough that two genuinely different real addresses won't
-- collide, coarse enough to get real cache hits for "roughly the same
-- spot" repeated queries (e.g. a pin dragged back close to a
-- previously-resolved point). Reverse geocoding is inherently street/
-- rooftop-level precision, not sub-meter, so rounding to this precision
-- should not change which address a coordinate resolves to -- confirmed
-- as part of this migration's own live verification (see reverseGeocode
-- Coordinates.test.ts and this PR's description for the real cache-hit
-- test).
--
-- matched = false rows are cached under the same 48-hour rule as
-- geocode_cache, for the same reason (avoid repeat quota spend on a
-- coordinate already known not to resolve) -- though live investigation
-- while building this feature found a genuine no-match is rare in
-- practice: LocationIQ's reverse endpoint falls back to a coarse
-- enclosing city/county boundary for most points within a populated
-- region (even genuine water points -- a real Puget Sound coordinate and
-- a real Lake Washington coordinate both returned ordinary 200 matches,
-- just coarse ones), live-confirmed to only return a genuine 404
-- "Unable to geocode" for a point with no enclosing administrative area
-- at all (e.g. open ocean). matched = false is still handled and cached
-- identically to geocode_cache regardless, since it's a real, valid
-- LocationIQ outcome even if triggered less often here than for forward
-- search.
CREATE TABLE reverse_geocode_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  coordinate_key text NOT NULL UNIQUE,

  matched boolean NOT NULL,

  lat double precision,
  lon double precision,
  display_name text,
  place_id text,
  osm_type text,
  osm_id text,
  raw_response jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  -- Same freshness-governing role and same "must be explicitly set on
  -- every upsert" caveat as geocode_cache.updated_at -- see that table's
  -- own comment (migrations/018).
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT reverse_geocode_cache_matched_requires_result CHECK (
    (matched AND lat IS NOT NULL AND lon IS NOT NULL AND display_name IS NOT NULL AND place_id IS NOT NULL AND raw_response IS NOT NULL)
    OR
    (NOT matched AND lat IS NULL AND lon IS NULL AND display_name IS NULL AND place_id IS NULL AND raw_response IS NULL)
  )
);

COMMENT ON TABLE reverse_geocode_cache IS
  'Persistent cache of LocationIQ reverse-geocoding results, keyed by coordinate_key (lat,lon each rounded to 5 decimal places -- see this table''s own migration comment). Same 48-hour cache-freshness rule and "store forever, never delete for staleness" design as geocode_cache (migrations/018), for the same LocationIQ ToS reasons.';
COMMENT ON COLUMN reverse_geocode_cache.coordinate_key IS
  'Rounded "lat,lon" string (5 decimal places, ~1.1m precision) -- the cache key. A single text column, not two numeric columns, for simple onConflict upserts and to avoid float equality-comparison pitfalls.';
COMMENT ON COLUMN reverse_geocode_cache.place_id IS
  'LocationIQ''s place_id, stored as text -- same real string-typed field as geocode_cache.place_id (live-verified, both forward and reverse endpoints).';
COMMENT ON COLUMN reverse_geocode_cache.updated_at IS
  'Last time this row was (re)fetched from LocationIQ. Governs the 48-hour cache-freshness rule -- must be explicitly set on every upsert, same as geocode_cache.updated_at.';
COMMENT ON COLUMN reverse_geocode_cache.raw_response IS
  'The full, unmodified LocationIQ reverse-geocoding response object (a single JSON object, not an array like forward search''s response), preserved as-is. Null when matched = false.';

CREATE INDEX idx_reverse_geocode_cache_updated_at ON reverse_geocode_cache (updated_at);

ALTER TABLE reverse_geocode_cache ENABLE ROW LEVEL SECURITY;
-- No CREATE POLICY statements, intentionally: same reasoning as
-- geocode_cache -- internal server-side caching infrastructure that only
-- the reverse-geocode Edge Function itself reads/writes (via
-- reverseGeocodeCoordinates.ts, using the service-role key); an anon/
-- frontend client never queries this table directly.
