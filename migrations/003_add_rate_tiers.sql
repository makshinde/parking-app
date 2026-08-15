-- Adds rate_tiers to an existing database that already has blockfaces (see
-- schema.sql for the full schema). Safe to run on its own against the live
-- Supabase project.

-- Detailed rate schedule for a paid blockface, one row per day-type/tier. A
-- single pay station can have up to 3 rate tiers per day-type (WKD/SAT/SUN),
-- each with its own time window and rate -- e.g. $2.50 8-11am, $1.50
-- 11am-5pm, $1 5-8pm on weekdays. blockfaces.hourly_rate_usd only holds a
-- single representative summary rate (the first weekday tier); this table
-- holds the full real schedule.
CREATE TABLE rate_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  blockface_id uuid NOT NULL REFERENCES blockfaces(id) ON DELETE CASCADE,

  -- Source data (SDOT Pay Stations) groups tiers by day-type, not individual
  -- day-of-week -- all weekdays share the same WKD schedule, so this matches
  -- the source's actual granularity instead of forcing a false per-day
  -- distinction the data doesn't have.
  day_type text NOT NULL CHECK (day_type IN ('WKD', 'SAT', 'SUN')),
  tier_number smallint NOT NULL CHECK (tier_number BETWEEN 1 AND 3),

  start_time time NOT NULL,
  end_time time NOT NULL,
  rate_usd numeric(6, 2) NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- One row per day-type/tier per blockface; re-aggregation updates the
  -- existing row instead of accumulating duplicates.
  UNIQUE (blockface_id, day_type, tier_number)
);

COMMENT ON TABLE rate_tiers IS
  'Detailed rate schedule for a paid blockface, one row per day-type (WKD/SAT/SUN) and tier (up to 3 per day-type), sourced from SDOT Pay Stations. blockfaces.hourly_rate_usd is only a representative summary; this table is the authoritative detail.';
COMMENT ON COLUMN rate_tiers.day_type IS
  'WKD (Monday-Friday), SAT, or SUN -- matches the source data''s own day-type grouping, not individual ISO days.';
COMMENT ON COLUMN rate_tiers.tier_number IS
  'Ordinal position of this tier within its day-type (1-3), matching the source''s WKD_RATE1/2/3-style fields. Not necessarily chronological across day-types.';

-- Postgres does not automatically index foreign key columns; without this,
-- every lookup of a blockface's rate schedule would force a sequential scan
-- of rate_tiers as it grows.
CREATE INDEX idx_rate_tiers_blockface_id ON rate_tiers (blockface_id);

ALTER TABLE rate_tiers ENABLE ROW LEVEL SECURITY;
