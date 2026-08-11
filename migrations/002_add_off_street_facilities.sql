-- Adds off_street_facilities to an existing database that already has
-- blockfaces and occupancy_stats (see schema.sql for the full schema).
-- Safe to run on its own against the live Supabase project.

-- Privately-operated garages and lots that are open to the public (Seattle's
-- "Public Garages and Parking Lots" dataset). Kept separate from blockfaces
-- since these are off-street facilities, not curbside blockfaces, and the
-- source data has a very different (much sparser) shape.
CREATE TABLE off_street_facilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Source dataset's own identifier, so re-imports can upsert instead of
  -- accumulating duplicate rows.
  source_facility_id text NOT NULL UNIQUE,

  name text NOT NULL,

  -- Source data (Seattle's Public Garages and Parking Lots dataset) arrives in
  -- SRID 2926 (Washington State Plane North) and must be reprojected to 4326
  -- at import time; this column is WGS84 to match blockfaces.location.
  location geography(Point, 4326) NOT NULL,

  address text,
  capacity integer,

  facility_type text CHECK (facility_type IN ('GARAGE', 'SURFACE LOT')),

  -- Only set when the source rate value parses as a clean dollar amount (e.g.
  -- "3" or "4.9"); non-numeric source values like "Permit only" go to
  -- rate_note instead so that information isn't silently discarded.
  hourly_rate_usd numeric(6, 2),
  rate_note text,

  operator_name text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE off_street_facilities IS
  'Privately-operated, publicly-accessible garages and lots, imported from Seattle''s Public Garages and Parking Lots dataset. In that source data, only capacity and address are populated for nearly all records (~99% and ~97% respectively) — facility_type, hourly_rate_usd, rate_note, and operator_name are each populated for only a few percent of records, so nulls in those columns are expected and normal, not a sign of a broken import.';
COMMENT ON COLUMN off_street_facilities.source_facility_id IS
  'Identifier from the source dataset (e.g. its business-license location ID), used to upsert on re-import rather than duplicate rows.';
COMMENT ON COLUMN off_street_facilities.location IS
  'Facility location as a point, reprojected from the source SRID (2926) to WGS84 (4326) at import time.';
COMMENT ON COLUMN off_street_facilities.hourly_rate_usd IS
  'Parsed hourly rate in USD, set only when the source rate value is a clean dollar amount.';
COMMENT ON COLUMN off_street_facilities.rate_note IS
  'Raw source rate text when it did not parse as a dollar amount (e.g. "Permit only"), preserved instead of discarded.';

-- Spatial index (GiST) so proximity queries against off-street facilities
-- stay fast, matching the index on blockfaces.location.
CREATE INDEX idx_off_street_facilities_location ON off_street_facilities USING GIST (location);

ALTER TABLE off_street_facilities ENABLE ROW LEVEL SECURITY;
