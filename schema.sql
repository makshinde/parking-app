-- Parking Availability App — database schema
-- Requires PostGIS (spatial types/indexes) and pgcrypto (gen_random_uuid()).
-- Supabase Postgres has both available; CREATE EXTENSION is idempotent.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Static, slowly-changing facts about a single blockface (one side of one
-- street between two cross streets) — the unit we predict availability for.
CREATE TABLE blockfaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Centerline of the blockface as a LineString, not a Point, so we can
  -- measure proximity and eventually render/snap to the actual curb geometry.
  -- SRID 4326 (WGS84) matches GPS/OSM/Nominatim coordinates.
  location geography(LineString, 4326) NOT NULL,

  street_name text NOT NULL,
  cross_street_from text NOT NULL,
  cross_street_to text NOT NULL,

  -- Compass side of the street this blockface's curb is on. Distinguishes the
  -- two blockfaces that share the same street/cross-street pair. Includes
  -- intercardinal directions (NE/NW/SE/SW), not just the 4 cardinal ones --
  -- live-verified against the source data that roughly 40-50% of real
  -- records are on diagonal streets and report an intercardinal side (see
  -- resolveBlockfaceSides.ts).
  side_of_street text NOT NULL CHECK (side_of_street IN ('N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW')),

  -- ELMNTKEY of the source street segment this blockface was assembled from
  -- (see assembleBlockface.ts), matching the source_facility_id pattern on
  -- off_street_facilities. One ELMNTKEY covers both sides of a segment, so
  -- uniqueness is enforced on the pair with side_of_street below, not on
  -- this column alone.
  source_element_key integer NOT NULL,

  is_paid boolean NOT NULL DEFAULT false,
  -- Null when the block is free (is_paid = false), or when it's paid but the
  -- rate genuinely isn't known yet (a DATA_GAP side -- see
  -- resolveBlockfaceSides.ts -- where curb-spaces evidence says a pay
  -- station belongs here but its record is missing). Enforced below: a free
  -- block must never have a rate attached, but a paid block's rate may be
  -- temporarily unknown.
  --
  -- Named starting_rate_usd, not hourly_rate_usd: this is ONLY the first
  -- weekday morning tier's rate (see rate_tiers), not a representative or
  -- average price across the full posted schedule. See CLAUDE.md's
  -- Conventions section -- this must never be shown to an end user as "the"
  -- rate without also pulling the full schedule from rate_tiers.
  starting_rate_usd numeric(6, 2),

  -- Days the posted restrictions/rates apply, using ISO 8601 numbering
  -- (1 = Monday ... 7 = Sunday) so it lines up with occupancy_stats.day_of_week.
  operating_days smallint[] NOT NULL DEFAULT ARRAY[1, 2, 3, 4, 5, 6, 7],
  operating_hours_start time NOT NULL DEFAULT '00:00',
  operating_hours_end time NOT NULL DEFAULT '23:59',

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- A rate implies the block is paid, but not the reverse: is_paid = true
  -- with a null rate is allowed (DATA_GAP -- paid, rate unknown). Only
  -- is_paid = false with a non-null rate is rejected -- a free block should
  -- never have a rate attached.
  CONSTRAINT starting_rate_requires_paid CHECK (
    is_paid OR starting_rate_usd IS NULL
  ),

  -- One ELMNTKEY identifies a segment, not a single blockfaces row -- each
  -- side of that segment is its own row -- so uniqueness is the pair, not
  -- source_element_key alone.
  CONSTRAINT blockfaces_source_element_key_side_unique
    UNIQUE (source_element_key, side_of_street)
);

COMMENT ON TABLE blockfaces IS
  'Static reference data for each parking blockface: where it is and what the posted rules are. Does not change based on observed occupancy.';
COMMENT ON COLUMN blockfaces.location IS
  'Blockface centerline geometry, used for nearest-blockface and radius queries around a destination.';
COMMENT ON COLUMN blockfaces.starting_rate_usd IS
  'ONLY the first weekday morning tier''s rate -- not a representative or average price. Never show this alone as "the" rate for a blockface; pull the full schedule from rate_tiers for the relevant day/time instead.';
COMMENT ON COLUMN blockfaces.operating_days IS
  'ISO 8601 day-of-week numbers (1=Monday..7=Sunday) the posted hours/rate apply on.';
COMMENT ON COLUMN blockfaces.source_element_key IS
  'ELMNTKEY of the source street segment this blockface was assembled from (see assembleBlockface.ts). Paired with side_of_street for uniqueness, since one ELMNTKEY covers both sides of a segment.';

-- Spatial index (GiST) so "find blockfaces within N meters of this point"
-- queries stay fast as the table grows past a handful of streets.
CREATE INDEX idx_blockfaces_location ON blockfaces USING GIST (location);

ALTER TABLE blockfaces ENABLE ROW LEVEL SECURITY;

-- Detailed rate schedule for a paid blockface, one row per day-type/tier. A
-- single pay station can have up to 3 rate tiers per day-type (WKD/SAT/SUN),
-- each with its own time window and rate -- e.g. $2.50 8-11am, $1.50
-- 11am-5pm, $1 5-8pm on weekdays. blockfaces.starting_rate_usd only holds
-- the first weekday morning tier's rate, not a representative summary or
-- average; this table holds the full real schedule.
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
  'Detailed rate schedule for a paid blockface, one row per day-type (WKD/SAT/SUN) and tier (up to 3 per day-type), sourced from SDOT Pay Stations. blockfaces.starting_rate_usd is only the first weekday morning tier''s rate, not a representative summary; this table is the authoritative detail.';
COMMENT ON COLUMN rate_tiers.day_type IS
  'WKD (Monday-Friday), SAT, or SUN -- matches the source data''s own day-type grouping, not individual ISO days.';
COMMENT ON COLUMN rate_tiers.tier_number IS
  'Ordinal position of this tier within its day-type (1-3), matching the source''s WKD_RATE1/2/3-style fields. Not necessarily chronological across day-types.';

-- Postgres does not automatically index foreign key columns; without this,
-- every lookup of a blockface's rate schedule would force a sequential scan
-- of rate_tiers as it grows.
CREATE INDEX idx_rate_tiers_blockface_id ON rate_tiers (blockface_id);

ALTER TABLE rate_tiers ENABLE ROW LEVEL SECURITY;

-- Historical occupancy stats, bucketed per blockface / day-of-week /
-- hour-of-day. This is the actively-used, primary storage for precomputed
-- predictions -- populated by a periodic batch aggregation job (see
-- CLAUDE.md's Architecture section) and read directly by the Edge Function
-- at request time, for fast, millisecond-level responses rather than a
-- live Socrata query per request. That batch job has not yet been built as
-- of this note, so this table needs populating before predictions can work.
CREATE TABLE occupancy_stats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  blockface_id uuid NOT NULL REFERENCES blockfaces(id) ON DELETE CASCADE,

  -- ISO 8601 day-of-week numbering (1=Monday..7=Sunday), matching
  -- blockfaces.operating_days so the two can be joined/filtered consistently.
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  hour_of_day smallint NOT NULL CHECK (hour_of_day BETWEEN 0 AND 23),

  -- Fraction of observations in this bucket where the blockface was occupied,
  -- 0 (always empty) to 1 (always full).
  mean_occupancy real NOT NULL CHECK (mean_occupancy BETWEEN 0 AND 1),

  -- Standard deviation of occupancy within the bucket, also on a 0-1 scale;
  -- feeds the "consistency" term of the prediction confidence score.
  std_dev real NOT NULL CHECK (std_dev BETWEEN 0 AND 1),

  -- Number of historical observations behind this bucket's stats; feeds the
  -- "sample size" term of the confidence score, so low-data buckets don't
  -- overstate how reliable the prediction is. The batch job only writes a
  -- row at all when this would be >= 30 (MIN_READINGS_PER_BUCKET) -- see
  -- CLAUDE.md's Architecture section for the live-verified reasoning behind
  -- that number. A CHECK of >= 0 rather than >= 30 here since that
  -- minimum is an application-level aggregation decision, not a database
  -- invariant every row must satisfy for its own sake.
  sample_count integer NOT NULL CHECK (sample_count >= 0),

  updated_at timestamptz NOT NULL DEFAULT now(),

  -- One precomputed row per blockface/day/hour bucket; re-aggregation updates
  -- the existing row instead of accumulating duplicates.
  UNIQUE (blockface_id, day_of_week, hour_of_day)
);

COMMENT ON TABLE occupancy_stats IS
  'Historical occupancy statistics per blockface, bucketed by day-of-week and hour-of-day. Primary storage for precomputed predictions, populated by a periodic batch aggregation job and read directly by the Edge Function at request time (see CLAUDE.md''s Architecture section). That batch job has not yet been built as of this note.';
COMMENT ON COLUMN occupancy_stats.mean_occupancy IS
  'Average fraction of capacity occupied in this bucket, 0 (empty) to 1 (full).';
COMMENT ON COLUMN occupancy_stats.std_dev IS
  'Standard deviation of occupancy in this bucket, 0 (always the same) to 1 (totally random).';

-- Postgres does not automatically index foreign key columns; without this,
-- every lookup of a blockface's stats (the app's main read pattern) would
-- force a sequential scan of occupancy_stats as it grows.
CREATE INDEX idx_occupancy_stats_blockface_id ON occupancy_stats (blockface_id);

ALTER TABLE occupancy_stats ENABLE ROW LEVEL SECURITY;

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

  operator_name text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE off_street_facilities IS
  'Privately-operated, publicly-accessible garages and lots, imported from Seattle''s Public Garages and Parking Lots dataset. In that source data, only capacity and address are populated for nearly all records (~99% and ~97% respectively) — facility_type and operator_name are each populated for only a few percent of records, so nulls in those columns are expected and normal, not a sign of a broken import. Rate information lives in off_street_rate_tiers, not on this table -- the source data has 4 independent duration-based rate fields (1HR/2HR/3HR/ALLDAY), which a single column here couldn''t represent without discarding 3 of the 4.';
COMMENT ON COLUMN off_street_facilities.source_facility_id IS
  'Identifier from the source dataset (e.g. its business-license location ID), used to upsert on re-import rather than duplicate rows.';
COMMENT ON COLUMN off_street_facilities.location IS
  'Facility location as a point, reprojected from the source SRID (2926) to WGS84 (4326) at import time.';

-- Spatial index (GiST) so proximity queries against off-street facilities
-- stay fast, matching the index on blockfaces.location.
CREATE INDEX idx_off_street_facilities_location ON off_street_facilities USING GIST (location);

ALTER TABLE off_street_facilities ENABLE ROW LEVEL SECURITY;

-- Detailed rate schedule for an off-street facility, one row per duration
-- type. The source data (Public Garages and Parking Lots dataset) expresses
-- rates as 4 independent duration-based fields (RTE_1HR, RTE_2HR, RTE_3HR,
-- RTE_ALLDAY) rather than a single number -- live-verified against the real
-- FeatureServer, each field independently populated for only ~3-4% of
-- records. A single hourly_rate_usd column on off_street_facilities could
-- only ever hold one of these four, silently discarding the rest; this table
-- holds the full set, the same summary-vs-detail split blockfaces uses for
-- rate_tiers.
CREATE TABLE off_street_rate_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  facility_id uuid NOT NULL REFERENCES off_street_facilities(id) ON DELETE CASCADE,

  -- Matches the source data's own duration grouping (RTE_1HR/2HR/3HR/ALLDAY)
  -- -- not a time-of-day window like blockfaces' rate_tiers.day_type/
  -- start_time/end_time, since this source expresses rates by how long a
  -- vehicle stays, not by time of day.
  duration_type text NOT NULL CHECK (duration_type IN ('1HR', '2HR', '3HR', 'ALLDAY')),

  -- Parsed via parseRateValue.ts: exactly one of rate_usd/rate_note is set
  -- per tier (or neither, if the source field was null/empty) -- rate_usd
  -- for a clean numeric value, rate_note for non-numeric source text (e.g.
  -- "Permit only") that would otherwise be silently discarded.
  rate_usd numeric(6, 2),
  rate_note text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- One row per duration type per facility; re-import updates the existing
  -- row instead of accumulating duplicates.
  UNIQUE (facility_id, duration_type),

  -- Mirrors parseRateValue's own output contract: a tier's rate is either a
  -- clean number, non-numeric text, or genuinely unknown -- never both a
  -- number and text for the same tier.
  CONSTRAINT off_street_rate_tiers_rate_xor_note CHECK (
    rate_usd IS NULL OR rate_note IS NULL
  )
);

COMMENT ON TABLE off_street_rate_tiers IS
  'Detailed rate schedule for an off-street facility, one row per duration type (1HR/2HR/3HR/ALLDAY), sourced from the Public Garages and Parking Lots dataset''s RTE_1HR/2HR/3HR/ALLDAY fields. Replaces the single hourly_rate_usd/rate_note pair off_street_facilities previously had, the same summary-vs-detail split blockfaces uses for rate_tiers.';
COMMENT ON COLUMN off_street_rate_tiers.duration_type IS
  '1HR, 2HR, 3HR, or ALLDAY -- matches the source data''s own RTE_1HR/2HR/3HR/ALLDAY field grouping.';
COMMENT ON COLUMN off_street_rate_tiers.rate_usd IS
  'Parsed rate in USD for this duration type, set only when the source value is a clean positive number. Null if unknown or if rate_note holds non-numeric source text instead.';
COMMENT ON COLUMN off_street_rate_tiers.rate_note IS
  'Raw source text for this duration type when it did not parse as a clean positive number (e.g. "Permit only"), preserved instead of discarded.';

-- Postgres does not automatically index foreign key columns; without this,
-- every lookup of a facility's rate schedule would force a sequential scan
-- of off_street_rate_tiers as it grows.
CREATE INDEX idx_off_street_rate_tiers_facility_id ON off_street_rate_tiers (facility_id);

ALTER TABLE off_street_rate_tiers ENABLE ROW LEVEL SECURITY;

-- Tracks the occupancy_stats batch aggregation job's progress, one row per
-- (iso_day, hour) bucket combination -- the same 91-bucket granularity the
-- batch job queries Socrata at (see CLAUDE.md's Architecture section). Lets
-- the job resume from where it left off after an interruption instead of
-- needing a full restart: on startup it can skip any bucket already marked
-- 'complete' and retry any left 'in_progress' or 'failed' from a previous
-- run.
CREATE TABLE occupancy_stats_backfill_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ISO 8601 day-of-week numbering (1=Monday..7=Sunday), matching
  -- occupancy_stats.day_of_week and blockfaces.operating_days.
  iso_day smallint NOT NULL CHECK (iso_day BETWEEN 1 AND 7),
  hour smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),

  status text NOT NULL CHECK (status IN ('pending', 'in_progress', 'complete', 'failed')),

  started_at timestamptz,
  completed_at timestamptz,

  -- Set only when status = 'failed', so a re-run (or a human) can see why a
  -- bucket didn't complete without digging through logs.
  error_message text,

  -- One row per (iso_day, hour) bucket combination; re-running the job
  -- updates the existing row's status instead of accumulating duplicates.
  UNIQUE (iso_day, hour)
);

COMMENT ON TABLE occupancy_stats_backfill_progress IS
  'Tracks the occupancy_stats batch aggregation job''s progress per (iso_day, hour) bucket, so an interrupted run can resume instead of restarting from scratch. Purely internal/operational bookkeeping for the batch job itself, not part of the public-facing schema. Deliberately has RLS enabled with NO policies at all (not even public read), unlike every other table in this schema: it holds no parking data of any public interest, only this project''s own job-scheduling state, and a public read policy here would serve no purpose while needlessly exposing internal operational details (job timing, failure messages) to anyone with API access.';
COMMENT ON COLUMN occupancy_stats_backfill_progress.status IS
  'pending (not yet attempted), in_progress (currently being processed -- also the state a bucket is left in if the job crashes mid-write), complete, or failed.';
COMMENT ON COLUMN occupancy_stats_backfill_progress.error_message IS
  'Set only when status = ''failed'', so a re-run or a human can see why without digging through logs.';

ALTER TABLE occupancy_stats_backfill_progress ENABLE ROW LEVEL SECURITY;
-- No CREATE POLICY statements, intentionally: unlike every other table in
-- this schema (which get public-read policies added manually via the
-- Supabase dashboard, outside these tracked files), this table must never
-- be publicly readable. With RLS enabled and zero policies, Postgres denies
-- all access by default to any role without BYPASSRLS -- only the
-- service-role key (used server-side by the batch job) can read or write
-- it.

-- Durably logs each bucket that fails during the occupancy_stats batch
-- aggregation job's main 91-combo run, so a final retry pass afterward has
-- a real record of exactly what failed and why, instead of relying on logs
-- from a run that may no longer be available (see CLAUDE.md's Architecture
-- section for how this fits into the batch job as a whole). A successful
-- retry deletes its row; a retry that fails again updates error_message
-- and increments retry_count in place, rather than accumulating duplicate
-- rows for the same bucket.
CREATE TABLE occupancy_stats_backfill_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  blockface_id uuid NOT NULL REFERENCES blockfaces(id) ON DELETE CASCADE,

  -- ISO 8601 day-of-week numbering (1=Monday..7=Sunday), matching
  -- occupancy_stats.day_of_week and occupancy_stats_backfill_progress.iso_day.
  iso_day smallint NOT NULL CHECK (iso_day BETWEEN 1 AND 7),
  hour smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),

  -- The computed stats that failed to be written, when the failure happened
  -- after aggregation completed (e.g. the occupancy_stats upsert itself
  -- failed). Left null when the failure happened earlier, before any stats
  -- were computed for this bucket (e.g. the Socrata fetch itself failed) --
  -- there's nothing meaningful to store in that case.
  mean_occupancy real,
  std_dev real,
  sample_count integer,

  -- Always set: every row in this table exists because something failed,
  -- so there's always a reason to record, unlike
  -- occupancy_stats_backfill_progress.error_message which is only set
  -- conditionally on that table's status.
  error_message text NOT NULL,

  -- How many times the retry pass has attempted this bucket again after
  -- its initial failure during the main run.
  retry_count integer NOT NULL DEFAULT 0,

  created_at timestamptz NOT NULL DEFAULT now(),

  -- One row per (blockface_id, iso_day, hour) bucket combination; a retry
  -- that fails again updates the existing row instead of accumulating
  -- duplicates for the same bucket.
  UNIQUE (blockface_id, iso_day, hour)
);

COMMENT ON TABLE occupancy_stats_backfill_failures IS
  'Durably logs each blockface/day/hour bucket that fails during the occupancy_stats batch aggregation job''s main 91-combo run, so a final retry pass afterward has a real record of what failed and why (see CLAUDE.md''s Architecture section). A successful retry deletes its row; a retry that fails again updates error_message and increments retry_count in place. Purely internal/operational bookkeeping for the batch job itself, not part of the public-facing schema. Deliberately has RLS enabled with NO policies at all (not even public read), same reasoning as occupancy_stats_backfill_progress: it holds no parking data of any public interest, only this project''s own job-failure bookkeeping.';
COMMENT ON COLUMN occupancy_stats_backfill_failures.mean_occupancy IS
  'The computed mean occupancy that failed to be written, if aggregation completed before the failure. Null if the failure happened earlier (e.g. the Socrata fetch itself failed), before any stats existed for this bucket.';
COMMENT ON COLUMN occupancy_stats_backfill_failures.retry_count IS
  'Number of times the retry pass has re-attempted this bucket after its initial failure during the main run.';

-- Postgres does not automatically index foreign key columns; without this,
-- looking up a blockface's failed buckets would force a sequential scan of
-- occupancy_stats_backfill_failures as it grows.
CREATE INDEX idx_occupancy_stats_backfill_failures_blockface_id ON occupancy_stats_backfill_failures (blockface_id);

ALTER TABLE occupancy_stats_backfill_failures ENABLE ROW LEVEL SECURITY;
-- No CREATE POLICY statements, intentionally: same reasoning as
-- occupancy_stats_backfill_progress. With RLS enabled and zero policies,
-- Postgres denies all access by default to any role without BYPASSRLS --
-- only the service-role key (used server-side by the batch job) can read
-- or write it.

-- Tracks resumability state for a full-archive streaming run (see CLAUDE.md's
-- Architecture section), one row per archive_dataset_id -- so each yearly
-- archive (e.g. "7c2e-uany" for 2025, "wtpb-jp8d" for 2020) gets its own
-- independent checkpoint, and streaming one year's archive never interferes
-- with another's progress. On startup, a streaming run checks for an
-- existing checkpoint row for the archive it's about to process and, if one
-- exists, resumes from just after last_processed_id instead of restarting
-- from the beginning of the dataset.
CREATE TABLE archive_stream_checkpoint (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  archive_dataset_id text NOT NULL UNIQUE,

  -- Socrata's own :id system field value (e.g. "row-km8v~rgdh.iue6") for the
  -- last row successfully processed, NOT a timestamp. Live-verified: :id
  -- pagination ($where=:id > cursor&$order=:id, no $offset) stays fast at
  -- depth (300ms-1.3s per 50,000-row page vs 14-16s for the equivalent
  -- occupancydatetime-based cursor -- 10-40x faster), and, since :id is
  -- guaranteed unique per row, resuming from it can never skip or duplicate
  -- a row the way a timestamp cursor can when multiple readings share the
  -- exact same timestamp at a resume boundary. Confirmed gap-free and
  -- duplicate-free by independently paginating an entire day (2025-06-10)
  -- this way and matching its row count exactly (1,002,814 rows) against a
  -- separately-verified count(*).
  last_processed_id text NOT NULL,

  -- Running count of readings processed so far in this archive's streaming
  -- run, purely informational (progress reporting/sanity-checking) -- not
  -- used to decide where to resume from, that's last_processed_id's job.
  readings_processed_count bigint NOT NULL,

  -- The :id cursor value the accumulator (archive_stream_accumulator_buckets)
  -- was last snapshotted at -- distinct from last_processed_id, which
  -- advances every chunk while this only advances every
  -- snapshotIntervalChunks chunks (see streamArchiveWithResume.ts). Null
  -- means no snapshot has been taken yet (a fresh run, or one still short
  -- of its first snapshot boundary).
  --
  -- This is a deliberate split, not the original design: the accumulator's
  -- per-bucket state is expensive enough to persist (previously a single
  -- large JSONB blob, now many small batched upserts into
  -- archive_stream_accumulator_buckets -- see that table's own comment for
  -- the full history) that snapshotting on every chunk would be far too
  -- slow across the full archive's ~6,002 chunks. A gap where this lags
  -- behind last_processed_id is expected and normal -- a resume re-fetches
  -- and re-folds exactly that bounded gap, never the whole dataset, before
  -- continuing.
  accumulator_snapshot_last_processed_id text,

  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE archive_stream_checkpoint IS
  'Tracks resumability state for a full-archive streaming run, one row per archive_dataset_id so each yearly archive checkpoints independently. On restart, a streaming run resumes from just after last_processed_id instead of re-fetching the whole dataset. Purely internal/operational bookkeeping for the batch job itself, not part of the public-facing schema. Deliberately has RLS enabled with NO policies at all (not even public read), same reasoning as occupancy_stats_backfill_progress and occupancy_stats_backfill_failures: it holds no parking data of any public interest, only this project''s own job-checkpoint state.';
COMMENT ON COLUMN archive_stream_checkpoint.archive_dataset_id IS
  'Socrata dataset id for the yearly archive being streamed (e.g. "7c2e-uany" for 2025), matching resolveYearlyArchiveDatasetId''s output. UNIQUE so each archive gets its own independent checkpoint.';
COMMENT ON COLUMN archive_stream_checkpoint.last_processed_id IS
  'Socrata''s own :id system field value for the last row successfully processed -- not a timestamp. Live-verified unique per row, gap-free and duplicate-free under keyset pagination, and 10-40x faster at depth than an occupancydatetime-based cursor. Resuming from this can never skip or duplicate a row the way a timestamp cursor can when multiple readings share the same timestamp at a resume boundary. Updated every chunk (cheap -- see saveArchiveStreamPosition), unlike accumulator_snapshot_last_processed_id below.';
COMMENT ON COLUMN archive_stream_checkpoint.accumulator_snapshot_last_processed_id IS
  'The :id cursor value the accumulator (archive_stream_accumulator_buckets) was last snapshotted at -- distinct from last_processed_id (the stream''s own fetch position), which advances every chunk while this only advances every snapshotIntervalChunks chunks (see streamArchiveWithResume.ts). Null means no snapshot has been taken yet. A gap where this lags behind last_processed_id is expected and normal -- a resume re-fetches and re-folds exactly that bounded gap, never the whole dataset, before continuing.';
COMMENT ON COLUMN archive_stream_checkpoint.readings_processed_count IS
  'Running count of readings processed so far in this archive''s streaming run. Informational only (progress reporting) -- resuming is driven by last_processed_id, not this count.';

ALTER TABLE archive_stream_checkpoint ENABLE ROW LEVEL SECURITY;
-- No CREATE POLICY statements, intentionally: same reasoning as
-- occupancy_stats_backfill_progress and occupancy_stats_backfill_failures.
-- With RLS enabled and zero policies, Postgres denies all access by default
-- to any role without BYPASSRLS -- only the service-role key (used
-- server-side by the batch job) can read or write it.

-- One row per (archive_dataset_id, blockface_id, iso_day, hour) bucket,
-- replacing the old single-JSONB-blob accumulator_state column (previously
-- on archive_stream_checkpoint, removed by migrations/016) with one row per
-- bucket, written via many small batched upserts instead of one large
-- write. See migrations/015 and streamArchiveWithResume.ts for the full,
-- live-verified reasoning: the old blob write hit a hard, size-independent
-- ~20-second failure ceiling (payloads 12.4MB-16.9MB all failed within
-- ~1.4s of each other, evidence of an external timeout layer, not
-- Postgres's own statement_timeout) that this design avoids structurally,
-- since no individual request ever again carries the full accumulator
-- state.
CREATE TABLE archive_stream_accumulator_buckets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Plain text, NOT a foreign key to archive_stream_checkpoint.archive_dataset_id
  -- -- clearArchiveStreamCheckpoint deletes the checkpoint row on
  -- successful completion, and an FK with ON DELETE CASCADE here would wipe
  -- these bucket rows at exactly the moment a crash-recovery scenario might
  -- still need them.
  archive_dataset_id text NOT NULL,

  blockface_id uuid NOT NULL REFERENCES blockfaces(id) ON DELETE CASCADE,

  -- ISO 8601 day-of-week numbering (1=Monday..7=Sunday), matching
  -- occupancy_stats.day_of_week and every other iso_day column in this
  -- schema.
  iso_day smallint NOT NULL CHECK (iso_day BETWEEN 1 AND 7),
  hour smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),

  -- WeightedStatsAccumulator's own fields (incrementalWeightedStats.ts).
  -- double precision, not real: these rows are read back into the
  -- in-memory accumulator and continue being folded via addReading()
  -- across further snapshots, so real's precision loss would compound on
  -- every round trip over a multi-hour run.
  count integer NOT NULL,
  total_weight double precision NOT NULL,
  mean double precision NOT NULL,
  sum_squared_diff double precision NOT NULL,

  updated_at timestamptz NOT NULL DEFAULT now(),

  -- One row per bucket; re-snapshotting (the entire current accumulator
  -- state is written every snapshot, not a delta) upserts each bucket's row
  -- in place. Also the index a resume's paginated
  -- WHERE archive_dataset_id = ... read-back (fetchAccumulatorBuckets)
  -- uses -- no separate index needed for that.
  UNIQUE (archive_dataset_id, blockface_id, iso_day, hour)
);

COMMENT ON TABLE archive_stream_accumulator_buckets IS
  'One row per (archive_dataset_id, blockface_id, iso_day, hour) bucket, holding that bucket''s incremental accumulator state (see incrementalWeightedStats.ts) as of the archive stream''s last accumulator snapshot. Replaces the old archive_stream_checkpoint.accumulator_state JSONB blob with many small batched upserts -- see streamArchiveWithResume.ts for the full reasoning. Purely internal/operational bookkeeping for the batch job itself, not part of the public-facing schema.';
COMMENT ON COLUMN archive_stream_accumulator_buckets.archive_dataset_id IS
  'Socrata dataset id for the yearly archive this bucket belongs to (e.g. "7c2e-uany" for 2025). Not a foreign key -- see this table''s own comment for why not.';
COMMENT ON COLUMN archive_stream_accumulator_buckets.count IS
  'WeightedStatsAccumulator.count: number of readings folded into this bucket so far.';
COMMENT ON COLUMN archive_stream_accumulator_buckets.total_weight IS
  'WeightedStatsAccumulator.totalWeight: sum of recency weights folded into this bucket so far.';
COMMENT ON COLUMN archive_stream_accumulator_buckets.mean IS
  'WeightedStatsAccumulator.mean: running weighted mean occupancy ratio for this bucket.';
COMMENT ON COLUMN archive_stream_accumulator_buckets.sum_squared_diff IS
  'WeightedStatsAccumulator.sumSquaredDiff: running variance accumulator term (West''s algorithm) for this bucket.';

-- Postgres does not automatically index foreign key columns; without this,
-- looking up a blockface's accumulator buckets (or cascading its delete)
-- would force a sequential scan of this table as it grows.
CREATE INDEX idx_archive_stream_accumulator_buckets_blockface_id ON archive_stream_accumulator_buckets (blockface_id);

ALTER TABLE archive_stream_accumulator_buckets ENABLE ROW LEVEL SECURITY;
-- No CREATE POLICY statements, intentionally: same reasoning as
-- archive_stream_checkpoint. With RLS enabled and zero policies, Postgres
-- denies all access by default to any role without BYPASSRLS -- only the
-- service-role key (used server-side by the batch job) can read or write
-- it.

-- Spatial-search RPC functions for the Edge Function's "find real parking
-- options near this geocoded point" request path (migrations/017). Both
-- read-only, SECURITY INVOKER (the default -- not specified as SECURITY
-- DEFINER), so each runs under the calling role's own RLS context. See
-- migrations/017_add_nearby_spatial_search_functions.sql for the full
-- reasoning (ST_DWithin's closest-point-on-line semantics for blockfaces,
-- the reject-not-clamp radius validation, the full rate_tiers/
-- off_street_rate_tiers inclusion, and a live-confirmed prerequisite: an
-- RLS public-read policy still needs to be added manually to
-- off_street_rate_tiers before nearby_off_street_facilities' pricing data
-- is visible to anon callers).
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
