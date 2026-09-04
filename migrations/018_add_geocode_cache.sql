-- Adds geocode_cache, a persistent cache for LocationIQ forward-geocoding
-- results (src/geocoding/geocodeAddress.ts). Respects LocationIQ's real,
-- live-verified free-tier ToS terms (locationiq.com/static/tos.html):
-- "If you have a free account, you can cache request-response pairs from
-- the Service for upto 48 hours" -- but separately, "You can store
-- response data forever." This table's design keeps those two distinct:
-- updated_at governs whether a row is fresh enough to serve as a cache
-- hit (< 48 hours old, checked in application code -- see
-- geocodeAddress.ts -- not enforced by a database constraint); a stale
-- row is never deleted for being stale, only overwritten in place on
-- refresh, so rows may be retained indefinitely, consistent with the
-- "store forever" clause.
--
-- matched = false rows (a confirmed "Unable to geocode" result from
-- LocationIQ -- live-verified real shape: HTTP 404, body
-- {"error":"Unable to geocode"}) are cached too, under the same 48-hour
-- rule: a query already known not to resolve shouldn't keep burning
-- LocationIQ's 5,000-request/day free-tier quota on repeat attempts.
--
-- place_id and osm_id are TEXT, not integer/bigint -- live-verified
-- directly against the real API that LocationIQ returns both as JSON
-- strings (e.g. "place_id":"409547841"), unlike Nominatim's own
-- numeric-typed equivalents for the same fields (confirmed via a real,
-- direct side-by-side query against both APIs). Storing these as integer
-- would risk silently mismodeling the real response shape.
--
-- raw_response holds the full, unmodified LocationIQ response object for
-- whichever result was used (null when matched = false) -- a deliberate
-- divergence from this schema's usual structured-columns-only convention,
-- justified here because: (1) the ToS explicitly permits permanent
-- storage of response data, (2) the payload is small per row (a single
-- geocode result, not the accumulator-scale data that motivated moving
-- away from a JSONB blob elsewhere in this schema -- see migrations/016),
-- and (3) it avoids a future migration if the frontend ever wants a field
-- (e.g. the full address breakdown, boundingbox) not currently promoted
-- to its own column.
CREATE TABLE geocode_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Normalized (trimmed, whitespace-collapsed, lowercased) query text --
  -- the actual cache key. Normalizing before storage means trivial
  -- formatting differences in what a caller passes in don't cost a
  -- second, redundant LocationIQ call for what is really the same query.
  query_text text NOT NULL UNIQUE,

  matched boolean NOT NULL,

  lat double precision,
  lon double precision,
  display_name text,
  place_id text,
  osm_type text,
  osm_id text,
  raw_response jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  -- Last time this row was (re)fetched from LocationIQ -- see this
  -- table's own comment above for the 48-hour freshness rule this
  -- governs. Every upsert MUST explicitly set this column: Supabase/
  -- PostgREST's upsert only touches columns present in the payload, so
  -- omitting it here would freeze it at its original-insert value
  -- forever, breaking the freshness check silently.
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- A confirmed non-match has no coordinates or response to store; a
  -- match must have all of them. osm_type/osm_id are deliberately left
  -- out of this constraint -- only a handful of real queries have been
  -- live-tested, not enough to be certain LocationIQ always populates
  -- them on every possible match.
  CONSTRAINT geocode_cache_matched_requires_result CHECK (
    (matched AND lat IS NOT NULL AND lon IS NOT NULL AND display_name IS NOT NULL AND place_id IS NOT NULL AND raw_response IS NOT NULL)
    OR
    (NOT matched AND lat IS NULL AND lon IS NULL AND display_name IS NULL AND place_id IS NULL AND raw_response IS NULL)
  )
);

COMMENT ON TABLE geocode_cache IS
  'Persistent cache of LocationIQ forward-geocoding results, keyed by normalized query text. updated_at governs a 48-hour cache-freshness rule (checked in application code, see geocodeAddress.ts) matching LocationIQ''s free-tier ToS; rows are never deleted for being stale, only refreshed in place, since LocationIQ''s ToS separately permits storing response data forever. matched=false rows (a confirmed no-match) are cached too, under the same rule, to avoid repeat quota spend on a query already known not to resolve.';
COMMENT ON COLUMN geocode_cache.query_text IS
  'Normalized (trimmed, whitespace-collapsed, lowercased) query text -- the cache key.';
COMMENT ON COLUMN geocode_cache.place_id IS
  'LocationIQ''s place_id, stored as text -- live-verified this is a JSON string in LocationIQ''s actual response, not numeric like Nominatim''s own place_id.';
COMMENT ON COLUMN geocode_cache.updated_at IS
  'Last time this row was (re)fetched from LocationIQ. Governs the 48-hour cache-freshness rule -- must be explicitly set on every upsert (see this table''s own comment for why).';
COMMENT ON COLUMN geocode_cache.raw_response IS
  'The full, unmodified LocationIQ response object for the result used, preserved as-is (permitted by LocationIQ''s ToS: "You can store response data forever"). Null when matched = false.';

-- Supports the 48-hour freshness lookup/expiry sweep pattern; query_text's
-- own UNIQUE constraint already indexes the primary cache-key lookup.
CREATE INDEX idx_geocode_cache_updated_at ON geocode_cache (updated_at);

ALTER TABLE geocode_cache ENABLE ROW LEVEL SECURITY;
-- No CREATE POLICY statements, intentionally: this is internal server-side
-- caching infrastructure that only the Edge Function itself reads/writes
-- (via geocodeAddress.ts, using the service-role key); an anon/frontend
-- client never queries this table directly -- it only ever sees the final
-- geocoded result through the Edge Function's own response. Same
-- reasoning as archive_stream_checkpoint / occupancy_stats_backfill_progress.
