-- Fixes a real production incident: nearby_blockfaces, nearby_off_street_
-- facilities (migrations/017), and search_local_addresses (migrations/019,
-- revised in migrations/020) all started throwing
-- `ERROR: 42704: type "geography"/"geometry" does not exist` on every real
-- invocation, taking down parking-search and destination search entirely
-- (every request returned status: "internal_error", HTTP 500).
--
-- Root cause, live-verified directly against the production database: an
-- automated security remediation (Lovable's "Try to fix all" tool,
-- responding to Supabase's real "Function Search Path Mutable" linter
-- advisory) pinned `search_path=public, pg_catalog` on exactly these three
-- user-defined functions -- confirmed by scanning every function in the
-- public schema's pg_proc: these three were the ONLY ones with a non-null
-- proconfig; every PostGIS/pg_trgm system function was untouched, ruling
-- out a manual or unrelated cause.
--
-- That pinned search_path is a reasonable-looking fix in general (pinning
-- search_path is the correct, real remediation for that advisory), but
-- wrong for THIS project specifically: PostGIS lives in the `extensions`
-- schema here, not `public` (confirmed via pg_extension), so `geography`/
-- `geometry` type names used inside these functions' bodies (e.g.
-- `DECLARE center geography(Point, 4326);` in nearby_blockfaces;
-- `b.location::geometry` in search_local_addresses) could no longer
-- resolve once `extensions` was excluded from these functions' own pinned
-- search_path. A plain ad hoc session's default search_path
-- (`"$user", public, extensions`, confirmed via `show search_path`)
-- includes extensions and was never affected -- only these three
-- functions, which carry their own independently-pinned search_path, were
-- broken. See CLAUDE.md's "Known open questions" for the general trap this
-- represents for any future function here.
--
-- This migration re-applies, as tracked, reviewable history, the exact fix
-- already applied live and verified against the real production database
-- and a real end-to-end parking-search request on 2026-09-09: add
-- `extensions` back into each function's pinned search_path, ahead of
-- pg_catalog so PostGIS/pg_trgm types and operators resolve correctly
-- regardless of the calling role's own session-level search_path. Function
-- bodies are unchanged -- this is a config-only fix, not a logic change,
-- which is why it's a plain ALTER FUNCTION rather than a CREATE OR REPLACE
-- FUNCTION redefinition.
ALTER FUNCTION nearby_blockfaces(double precision, double precision, double precision)
  SET search_path = public, extensions, pg_catalog;

ALTER FUNCTION nearby_off_street_facilities(double precision, double precision, double precision)
  SET search_path = public, extensions, pg_catalog;

ALTER FUNCTION search_local_addresses(text, integer)
  SET search_path = public, extensions, pg_catalog;
