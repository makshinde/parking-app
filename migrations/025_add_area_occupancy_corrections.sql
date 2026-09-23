-- Area-aware calibration for the payment-vs-physical-occupancy
-- under-prediction bias documented tonight in CLAUDE.md: the field test,
-- the transaction-coverage rebuild, and the Annual Parking Study
-- comparison all independently confirmed the same geographic pattern
-- (predictions run meaningfully further below real occupancy downtown
-- than in Ballard, though that specific two-area pattern did NOT
-- generalize cleanly to every neighborhood tested afterward -- see the
-- Green Lake/Fremont/Capitol Hill/Columbia City follow-ups).
--
-- Maps a raw occupancy_stats-derived predicted percentage to a corrected
-- one, per paid-parking area/subarea, as a piecewise (banded) monotonic
-- calibration curve rather than a single flat offset -- a flat per-area
-- adjustment would overcorrect the high-predicted blocks and undercorrect
-- the low-predicted ones within the same area, since the under-prediction
-- gap itself is worse specifically at low predicted values (confirmed
-- repeatedly tonight, r(app%, gap) around -0.4 to -0.5 across every field
-- test slice computed).
--
-- Populated offline by fitAreaCalibration.ts from real, independent
-- ground truth (the Annual Parking Study's training split only -- see
-- that script's own comment) -- NEVER from occupancy_stats' own
-- historical accuracy against itself, which would be circular. The field
-- test and transaction-coverage rebuild are deliberately excluded from
-- fitting; they're reserved as the final, untouched validation set (see
-- backtest-predictions.ts's runAreaCorrectionValidation).
--
-- Deliberately NOT read by any live-facing prediction path yet as of
-- this migration -- assembleSearchResults.ts does not import
-- applyAreaCorrection.ts. All three validation gates in
-- runAreaCorrectionValidation must pass, on real data, before that
-- wiring happens.
CREATE TABLE area_occupancy_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Matches blockfaces.paidparkingarea exactly. paidparkingsubarea is
  -- null when this row's calibration was fit at the area level (the
  -- specific subarea had insufficient evidence -- see
  -- fitAreaCalibration.ts's hierarchical fallback: subarea, then area,
  -- then no correction at all -- never a citywide default, since a
  -- citywide number has no more real evidence behind it for an
  -- unconfirmed area than leaving that area uncorrected does).
  paidparkingarea text NOT NULL,
  paidparkingsubarea text,

  -- The calibration curve is stored as discrete (predicted-band,
  -- corrected value) rows rather than a closed-form formula, since it's
  -- fit via weighted isotonic regression (pool-adjacent-violators) over a
  -- small number of bands, not a parametric model -- see
  -- fitAreaCalibration.ts. [predicted_band_low, predicted_band_high) on
  -- the 0-100 predicted-percentage scale; the top band is closed at 100.
  predicted_band_low real NOT NULL CHECK (predicted_band_low >= 0 AND predicted_band_low < 100),
  predicted_band_high real NOT NULL CHECK (predicted_band_high > 0 AND predicted_band_high <= 100),
  corrected_pct real NOT NULL CHECK (corrected_pct BETWEEN 0 AND 100),

  -- How many real (predicted%, ground-truth%) training pairs from the
  -- Annual Study's training split this band's corrected_pct was fit
  -- from -- mirrors occupancy_stats.sample_count's role (lets a reader
  -- judge the evidence behind this specific row) and is the same number
  -- MIN_AREA_CALIBRATION_SAMPLES/MIN_BAND_CALIBRATION_SAMPLES in
  -- fitAreaCalibration.ts gate on before a row is written at all.
  sample_count integer NOT NULL CHECK (sample_count > 0),

  fit_at timestamptz NOT NULL DEFAULT now(),

  -- One row per (area, subarea-or-null, band); re-fitting upserts in
  -- place instead of accumulating stale bands from a previous fit.
  UNIQUE (paidparkingarea, paidparkingsubarea, predicted_band_low)
);

COMMENT ON TABLE area_occupancy_corrections IS
  'Area-aware calibration mapping a raw predicted occupancy percentage to a corrected one, fit offline from the Annual Parking Study''s training split (never from occupancy_stats'' own accuracy, which would be circular; never from the field test or transaction-coverage rebuild, which are held out for final validation). Not yet wired into any live-facing prediction path -- see backtest-predictions.ts''s runAreaCorrectionValidation gates.';

-- Supports the request-time lookup (once wired) reading all bands for a
-- given area/subarea in one indexed query.
CREATE INDEX idx_area_occupancy_corrections_area ON area_occupancy_corrections (paidparkingarea, paidparkingsubarea);

ALTER TABLE area_occupancy_corrections ENABLE ROW LEVEL SECURITY;
