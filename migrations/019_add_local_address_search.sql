-- Adds search_local_addresses, a trigram-fuzzy-match RPC over blockfaces
-- and off_street_facilities, for two real uses: (1) live-typing address
-- autocomplete against this project's own already-known locations, called
-- directly by the frontend (no Edge Function wrapper -- this is a
-- read-only, SECURITY INVOKER lookup with no external API or secret
-- involved, so wrapping it would only add latency to an interactive-typing
-- path), and (2) the "did you mean X, Y, Z" fallback inside the
-- parking-search Edge Function when a typed address matches no local
-- suggestion and also fails real LocationIQ geocoding (see
-- handleParkingSearchRequest.ts).
--
-- search_text is a lowercased, STORED generated column on each table --
-- not computed inline per query -- so the trigram index below can actually
-- index it. Lowercased specifically because pg_trgm's similarity is
-- case-sensitive (character trigrams, not word-aware): source data is
-- stored uppercase (e.g. "3RD AVE"), but a typed query could be any case,
-- and comparing "3RD AVE" against "3rd ave" without normalizing would
-- silently score every real match too low.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE blockfaces
  ADD COLUMN search_text text GENERATED ALWAYS AS (
    lower(street_name || ' ' || cross_street_from || ' ' || cross_street_to || ' ' || side_of_street)
  ) STORED;

COMMENT ON COLUMN blockfaces.search_text IS
  'Lowercased, generated concatenation of street_name/cross_street_from/cross_street_to/side_of_street, used only as the trigram-match target for search_local_addresses -- never displayed directly (display text is built from the real columns).';

-- GiST, not GIN: GIN only accelerates pg_trgm's `%` operator, whose
-- threshold comes from the session-level pg_trgm.similarity_threshold GUC
-- (or set_limit()) -- a real footgun under PostgREST's pooled connections,
-- since a session-level mutation could leak onto a later, unrelated query
-- sharing the same pooled connection. GiST instead supports the `<->`
-- trigram-distance operator for index-assisted KNN ordering (the same
-- pattern migrations/017's nearby_blockfaces/nearby_off_street_facilities
-- already use for spatial proximity via `location <->`, applied here to
-- text proximity instead), with no global state touched at all.
CREATE INDEX idx_blockfaces_search_text_trgm ON blockfaces USING gist (search_text gist_trgm_ops);

ALTER TABLE off_street_facilities
  ADD COLUMN search_text text GENERATED ALWAYS AS (
    lower(name || COALESCE(' ' || address, ''))
  ) STORED;

COMMENT ON COLUMN off_street_facilities.search_text IS
  'Lowercased, generated concatenation of name and address (address is nullable -- see this table''s own schema.sql comment), used only as the trigram-match target for search_local_addresses.';

CREATE INDEX idx_off_street_facilities_search_text_trgm ON off_street_facilities USING gist (search_text gist_trgm_ops);

-- match_limit rejects (RAISE EXCEPTION) outside (0, 10], not clamped --
-- same "UI control, not free user input" reasoning as
-- nearby_blockfaces/nearby_off_street_facilities' own radius_meters bound.
--
-- Ranking: each table's own nearest-by-trigram-distance top-(match_limit*4)
-- rows are pulled via the GiST-indexed `<->` KNN ordering (cheap, index-
-- assisted), combined, then filtered down with an explicit
-- similarity(...) > 0.25 floor -- applied only to that small combined set,
-- not the whole table -- and only then sorted/capped to match_limit. This
-- keeps a real similarity floor (so a genuinely unrelated query can
-- legitimately return zero suggestions) without ever touching the
-- session-level GUC/set_limit() footgun described above. 0.25 and the x4
-- overfetch factor are starting points, confirmed against real
-- misspelled/partial input in this migration's own live verification, not
-- values with any deeper theoretical justification.
--
-- Results are ranked as one single combined list across both kinds
-- (ORDER BY similarity DESC LIMIT match_limit over the union), not
-- top-N-per-kind -- "a small number of top matches" means one ranked list.
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
          b.search_text
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
          f.search_text
        FROM off_street_facilities f
        ORDER BY f.search_text <-> normalized_query
        LIMIT overfetch_limit
      )
    )
    SELECT
      n.kind,
      n.id,
      n.display_text,
      n.lat,
      n.lon,
      similarity(n.search_text, normalized_query) AS similarity
    FROM nearest n
    WHERE similarity(n.search_text, normalized_query) > 0.25
    ORDER BY similarity DESC
    LIMIT match_limit;
END;
$$;

COMMENT ON FUNCTION search_local_addresses(text, integer) IS
  'Trigram-fuzzy-matches query_text against blockfaces and off_street_facilities, returning up to match_limit (default 5, capped at 10 -- out-of-range rejects rather than clamps) top matches ranked by similarity across both kinds combined. Each table''s own GiST-indexed top-(match_limit*4) nearest-by-trigram-distance rows are combined, then filtered by an explicit similarity > 0.25 floor and re-ranked -- deliberately not pg_trgm''s `%` operator/set_limit(), which rely on a session-level GUC unsafe under PostgREST''s pooled connections. Used both directly by the frontend for live-typing autocomplete and by handleParkingSearchRequest.ts for the "did you mean" fallback on a failed geocode. SECURITY INVOKER (the default): runs under the calling role''s own RLS context.';

REVOKE ALL ON FUNCTION search_local_addresses(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_local_addresses(text, integer) TO anon, authenticated, service_role;
