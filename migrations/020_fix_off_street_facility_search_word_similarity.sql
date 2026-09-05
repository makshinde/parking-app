-- Fixes a real gap in search_local_addresses (migrations/019), found via
-- live verification: a deliberately misspelled real facility name
-- ("westlke garag" for the real "2200 WESTLAKE GARAGE 81236") returned
-- zero suggestions. Live-verified root cause: off_street_facilities'
-- search_text concatenates name with the FULL street address, including
-- city/state/zip (e.g. "2200 westlake garage 81236 2200 westlake ave,
-- seattle, wa 98121-2713") -- that boilerplate tail dilutes whole-string
-- similarity() far more than blockfaces' much shorter search_text, so the
-- real match (confirmed live to rank #1 in raw KNN order -- the overfetch
-- factor was never the problem) scored only 0.2075, below the 0.25 floor.
--
-- First attempt at a fix (also live-verified, and also rejected): simply
-- switching off_street_facilities to word_similarity() -- which scores the
-- best-matching CONTINUOUS SUBSTRING rather than diluting across the whole
-- string -- correctly admitted the westlke-garag case (0.647059) but
-- introduced a genuine NEW regression, caught only by re-running the
-- blockfaces regression tests as part of this same live verification pass:
-- word_similarity() saturates at 1.0 for ANY exact contiguous-substring
-- match, and this isn't facility-specific -- live-confirmed several real
-- blockfaces also hit word_similarity = 1.0 for a plain "pike st" query.
-- Once rows from both kinds tie at the ceiling, ORDER BY on that same
-- column becomes an arbitrary tiebreak among ties -- live-confirmed a
-- plain "pike st" query returned ONLY off_street_facility rows in the
-- top 3, silently pushing out blockfaces that were equally strong,
-- correct matches under the original design.
--
-- Actual fix: decouple INCLUSION from RANKING for off_street_facilities.
-- word_similarity() decides whether a facility row is even eligible (the
-- floor check, `gate_score`) -- lenient enough to admit westlke-garag-
-- style matches that plain similarity() unfairly rejects. But the value
-- actually used for cross-kind RANKING and returned to the caller
-- (`rank_score`, aliased as `similarity`) is always plain similarity() for
-- BOTH kinds -- one consistent, non-saturating scale, so blockfaces'
-- genuinely strong matches (0.28-0.44 for real "pike st"/"pike"/
-- "3rd avenu" queries) correctly outrank a facility match that only
-- passed the more lenient word_similarity gate (e.g. westlke-garag's own
-- real similarity() is 0.208 -- displayed honestly as that, not as an
-- inflated 1.0 substring score). blockfaces don't need this two-metric
-- split themselves -- their search_text is short enough that plain
-- similarity() already both gates and ranks them correctly, live-verified
-- in migrations/019's own testing.
--
-- KNN ordering is unaffected by this gate/rank split -- off_street_
-- facilities' ORDER BY still uses `<->>` (word_similarity-based distance,
-- needed only to make sure enough real candidates survive the
-- overfetch*4 cut before the gate/rank logic runs); blockfaces still use
-- `<->`. Both live-reconfirmed (EXPLAIN ANALYZE) to use the same GiST
-- index (idx_off_street_facilities_search_text_trgm /
-- idx_blockfaces_search_text_trgm, gist_trgm_ops) as before -- this
-- revision changes only the scoring/filtering logic downstream of the
-- already-indexed KNN fetch, not the indexes or the KNN operators
-- themselves.
CREATE OR REPLACE FUNCTION search_local_addresses(
  query_text text,
  match_limit integer DEFAULT 5
)
RETURNS TABLE (
  kind text,
  id uuid,
  display_text text,
  lat double precision,
  lon double precision,
  similarity real
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  normalized_query text := lower(query_text);
  overfetch_limit integer := match_limit * 4;
BEGIN
  IF match_limit <= 0 OR match_limit > 10 THEN
    RAISE EXCEPTION 'search_local_addresses: match_limit must be greater than 0 and at most 10, got %', match_limit;
  END IF;

  RETURN QUERY
    WITH nearest AS (
      (
        SELECT
          'blockface' AS kind,
          b.id,
          b.street_name || ' between ' || b.cross_street_from || ' and ' || b.cross_street_to
            || ' (' || b.side_of_street || ' side)' AS display_text,
          ST_Y(ST_LineInterpolatePoint(b.location::geometry, 0.5)) AS lat,
          ST_X(ST_LineInterpolatePoint(b.location::geometry, 0.5)) AS lon,
          similarity(b.search_text, normalized_query) AS gate_score,
          similarity(b.search_text, normalized_query) AS rank_score
        FROM blockfaces b
        ORDER BY b.search_text <-> normalized_query
        LIMIT overfetch_limit
      )
      UNION ALL
      (
        SELECT
          'off_street_facility' AS kind,
          f.id,
          CASE WHEN f.address IS NOT NULL THEN f.name || ', ' || f.address ELSE f.name END AS display_text,
          ST_Y(f.location::geometry) AS lat,
          ST_X(f.location::geometry) AS lon,
          word_similarity(normalized_query, f.search_text) AS gate_score,
          similarity(f.search_text, normalized_query) AS rank_score
        FROM off_street_facilities f
        ORDER BY f.search_text <->> normalized_query
        LIMIT overfetch_limit
      )
    )
    SELECT
      n.kind,
      n.id,
      n.display_text,
      n.lat,
      n.lon,
      n.rank_score AS similarity
    FROM nearest n
    WHERE n.gate_score > 0.25
    ORDER BY n.rank_score DESC
    LIMIT match_limit;
END;
$$;

COMMENT ON FUNCTION search_local_addresses(text, integer) IS
  'Trigram-fuzzy-matches query_text against blockfaces and off_street_facilities, returning up to match_limit (default 5, capped at 10 -- out-of-range rejects rather than clamps) top matches ranked by similarity across both kinds combined. Inclusion and ranking are deliberately decoupled for off_street_facilities (migrations/020): word_similarity() decides eligibility (lenient enough to admit a real match otherwise diluted by its long address/city/state/zip tail), but plain similarity() -- the same metric blockfaces use throughout -- decides ranking and the returned similarity value, since word_similarity() saturates at 1.0 for any exact contiguous-substring match (live-confirmed to affect both kinds, not just facilities) and would otherwise let substring ties arbitrarily crowd out genuinely-strong blockface matches from the combined ranking. Each table''s own GiST-indexed top-(match_limit*4) nearest rows (via `<->` for blockfaces, `<->>` for off_street_facilities -- both live-confirmed to use the same GiST gist_trgm_ops index) are combined before this gate/rank logic runs. Deliberately not pg_trgm''s `%`/`<%` operators or set_limit()/word_similarity_threshold, which rely on session-level GUCs unsafe under PostgREST''s pooled connections. Used both directly by the frontend for live-typing autocomplete and by handleParkingSearchRequest.ts for the "did you mean" fallback on a failed geocode. SECURITY INVOKER (the default): runs under the calling role''s own RLS context.';
