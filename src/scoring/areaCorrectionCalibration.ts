// Pure calibration-fitting logic for the area-aware occupancy correction
// layer designed and approved tonight (see CLAUDE.md's field-testing
// investigation). No I/O here -- fetch-annual-study-calibration-data.ts
// gathers the real (predicted%, ground-truth%) pairs this operates on
// from the Annual Parking Study, and fit-and-write-area-corrections.ts
// persists the result to area_occupancy_corrections. Kept separate so the
// actual math is fully unit-testable without a network or database.

export interface CalibrationPair {
  predictedPct: number; // 0-100
  groundTruthPct: number; // 0-100
}

export interface CalibrationBand {
  predictedBandLow: number;
  predictedBandHigh: number;
  correctedPct: number;
  sampleCount: number;
}

export interface AreaCalibration {
  paidParkingArea: string;
  paidParkingSubarea: string | null; // null when fit at the area level (fallback)
  bands: CalibrationBand[];
}

// --- Train/held-out split -------------------------------------------------

// Deterministic, not random-per-run: the same key always lands on the same
// side of the split, so re-running the fit script never silently changes
// which pairs were "training" data between runs -- the validation gates in
// backtest-predictions.ts need that split to mean the same thing every
// time they're checked. A simple string-hash mod, not crypto-grade, since
// this only needs a stable, roughly-uniform split, not security.
function stableHashFraction(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  // >>> 0 converts the signed 32-bit hash to an unsigned int before
  // scaling to [0, 1) -- without it, a negative hash would produce a
  // negative fraction and break the trainFraction comparison below.
  return (hash >>> 0) / 0xffffffff;
}

export interface SplitInput<T> {
  key: string;
  pair: T;
}

export interface TrainHoldoutSplit<T> {
  train: T[];
  holdout: T[];
}

// trainFraction is continuous/estimated (any value in (0,1) is a real,
// meaningful split ratio), so an out-of-range value is clamped with a
// warning rather than rejected, per CLAUDE.md's "Handling invalid input"
// convention. NaN/Infinity have no meaningful "nearest valid" split ratio,
// so those still throw.
function clampTrainFraction(trainFraction: number): number {
  if (!Number.isFinite(trainFraction)) {
    throw new RangeError(`splitTrainHoldout: trainFraction must be finite, got ${trainFraction}`);
  }
  if (trainFraction <= 0 || trainFraction >= 1) {
    console.warn(`splitTrainHoldout: trainFraction ${trainFraction} is outside (0, 1), clamping`);
    return Math.min(Math.max(trainFraction, 0.01), 0.99);
  }
  return trainFraction;
}

// key should uniquely identify the real-world observation (e.g. a study
// row's elmntkey+side+date_time) -- NOT the pair's own values -- so the
// split is stable regardless of any later reordering or reprocessing of
// the same underlying data.
export function splitTrainHoldout<T>(inputs: readonly SplitInput<T>[], trainFraction: number): TrainHoldoutSplit<T> {
  const fraction = clampTrainFraction(trainFraction);
  const train: T[] = [];
  const holdout: T[] = [];
  for (const input of inputs) {
    if (stableHashFraction(input.key) < fraction) {
      train.push(input.pair);
    } else {
      holdout.push(input.pair);
    }
  }
  return { train, holdout };
}

// --- Band definition -------------------------------------------------

// Fixed-width, not quantile-based: tonight's field data show predicted%
// clustering heavily in the low range (the whole reason this correction
// exists), so quantile bins would put most of the real evidence into one
// or two narrow bins near 0 and leave the high end almost unsampled --
// fixed 25-point bands keep every band's real-world meaning ("blocks the
// app calls roughly a quarter full") stable and comparable across areas,
// at the cost of some bands having much less evidence than others. That
// imbalance is exactly what MIN_BAND_CALIBRATION_SAMPLES below exists to
// catch.
const BAND_WIDTH = 25;
const PREDICTED_PCT_MAX = 100;

function bandBounds(predictedPct: number): { low: number; high: number } {
  const low = Math.min(Math.floor(predictedPct / BAND_WIDTH) * BAND_WIDTH, PREDICTED_PCT_MAX - BAND_WIDTH);
  return { low, high: low + BAND_WIDTH };
}

// --- Minimum evidence thresholds ------------------------------------

// Reused BY ANALOGY from MIN_READINGS_PER_BUCKET (occupancy_stats'
// established, empirically-derived noise-rejection threshold -- see
// CLAUDE.md's Architecture section), not independently re-derived for
// this specific metric: no real distribution study of how many
// (predicted%, ground-truth%) pairs are actually available per
// area/subarea/band has been run. Worth revisiting with a real derivation
// once this correction layer has shipped and accumulated more history.
export const MIN_BAND_CALIBRATION_SAMPLES = 30;
// An area/subarea needs enough total evidence to plausibly support all 4
// bands, not just clear the per-band floor in one or two of them -- 4x
// the per-band minimum, same reasoning.
export const MIN_AREA_CALIBRATION_SAMPLES = 120;

interface RawBand {
  low: number;
  high: number;
  sumGroundTruth: number;
  count: number;
}

function computeRawBands(pairs: readonly CalibrationPair[]): RawBand[] {
  const byLow = new Map<number, RawBand>();
  for (const pair of pairs) {
    const { low, high } = bandBounds(pair.predictedPct);
    const existing = byLow.get(low);
    if (existing === undefined) {
      byLow.set(low, { low, high, sumGroundTruth: pair.groundTruthPct, count: 1 });
    } else {
      existing.sumGroundTruth += pair.groundTruthPct;
      existing.count += 1;
    }
  }
  return Array.from(byLow.values()).sort((a, b) => a.low - b.low);
}

// Weighted isotonic regression via pool-adjacent-violators (PAVA):
// enforces that corrected_pct is non-decreasing across bands (a block the
// app calls "more full" should never get a LOWER corrected value than one
// it calls "less full" in the same area -- raw per-band averages from
// real, noisy field data can easily come out non-monotonic by chance,
// especially in sparser bands, without this). Two adjacent bands that
// violate monotonicity are merged into one pool with a weighted-average
// value; this repeats until the whole sequence is non-decreasing.
// Standard technique for exactly this problem, not a bespoke smoothing
// heuristic.
function poolAdjacentViolators(rawBands: readonly RawBand[]): CalibrationBand[] {
  interface Pool {
    low: number;
    high: number;
    value: number;
    weight: number;
  }
  const pools: Pool[] = rawBands.map((band) => ({
    low: band.low,
    high: band.high,
    value: band.sumGroundTruth / band.count,
    weight: band.count,
  }));

  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < pools.length - 1; i++) {
      const current = pools[i];
      const next = pools[i + 1];
      if (current === undefined || next === undefined) continue;
      if (current.value > next.value) {
        const combinedWeight = current.weight + next.weight;
        const combinedValue = (current.value * current.weight + next.value * next.weight) / combinedWeight;
        pools.splice(i, 2, { low: current.low, high: next.high, value: combinedValue, weight: combinedWeight });
        merged = true;
        break;
      }
    }
  }

  return pools.map((pool) => ({
    predictedBandLow: pool.low,
    predictedBandHigh: pool.high,
    correctedPct: Math.min(100, Math.max(0, pool.value)),
    sampleCount: pool.weight,
  }));
}

// Fits one area or subarea's calibration curve, or returns null when
// there isn't enough real evidence to trust it -- never invents a
// correction from insufficient data (same "clamp only with sufficient
// evidence, otherwise don't touch it" discipline as
// MIN_READINGS_PER_BUCKET). A band that still falls short of
// MIN_BAND_CALIBRATION_SAMPLES even after PAVA merging is dropped
// individually (that specific predicted range passes through
// uncorrected) rather than failing the whole area/subarea.
export function fitAreaCalibration(
  paidParkingArea: string,
  paidParkingSubarea: string | null,
  pairs: readonly CalibrationPair[],
): AreaCalibration | null {
  if (pairs.length < MIN_AREA_CALIBRATION_SAMPLES) {
    return null;
  }
  const rawBands = computeRawBands(pairs);
  const bands = poolAdjacentViolators(rawBands).filter((band) => band.sampleCount >= MIN_BAND_CALIBRATION_SAMPLES);
  if (bands.length === 0) {
    return null;
  }
  return { paidParkingArea, paidParkingSubarea, bands };
}

// --- Hierarchical fit: subarea, then area, never citywide -----------

export interface GroupedCalibrationPairs {
  paidParkingArea: string;
  paidParkingSubarea: string | null;
  pairs: CalibrationPair[];
}

// Fits every real subarea's own calibration, AND independently fits each
// area's calibration by pooling ALL of that area's pairs (subareas
// included) -- both are kept, since a subarea calibration only covers the
// specific bands it had enough evidence for; the area-level fit is the
// fallback applyAreaCorrection reaches for whenever a subarea-specific
// band is missing. There is deliberately no citywide fallback below area
// level: an unconfirmed area has no more real evidence behind a citywide
// number than it does behind its own raw, uncorrected prediction, so "no
// correction" is the safer default (see area_occupancy_corrections'
// migration comment).
export function fitAreaCalibrationsWithFallback(groups: readonly GroupedCalibrationPairs[]): AreaCalibration[] {
  const results: AreaCalibration[] = [];

  for (const group of groups) {
    if (group.paidParkingSubarea === null) continue;
    const subareaCalibration = fitAreaCalibration(group.paidParkingArea, group.paidParkingSubarea, group.pairs);
    if (subareaCalibration !== null) {
      results.push(subareaCalibration);
    }
  }

  const pairsByArea = new Map<string, CalibrationPair[]>();
  for (const group of groups) {
    const existing = pairsByArea.get(group.paidParkingArea) ?? [];
    existing.push(...group.pairs);
    pairsByArea.set(group.paidParkingArea, existing);
  }
  for (const [area, pairs] of pairsByArea) {
    const areaCalibration = fitAreaCalibration(area, null, pairs);
    if (areaCalibration !== null) {
      results.push(areaCalibration);
    }
  }

  return results;
}

// --- Request-time application (standalone, NOT wired into any live path) -

function findBand(calibration: AreaCalibration | undefined, predictedPct: number): CalibrationBand | undefined {
  if (calibration === undefined) return undefined;
  return calibration.bands.find(
    (band) => predictedPct >= band.predictedBandLow && (predictedPct < band.predictedBandHigh || band.predictedBandHigh === PREDICTED_PCT_MAX),
  );
}

// Prefers a subarea-specific band over the area-level one when both exist
// for the given predicted percentage, mirroring the fitting hierarchy
// above. Falls through to the raw, uncorrected value whenever no area is
// known, no calibration was ever fit for it, or the specific band it
// falls into never cleared the evidence threshold.
//
// Deliberately not imported by assembleSearchResults.ts (or any other
// live-facing request path) as of this file's own creation -- see
// area_occupancy_corrections' migration comment and
// backtest-predictions.ts's runAreaCorrectionValidation gates, all of
// which must pass on real data before that wiring happens.
export function applyAreaCorrection(
  rawPredictedPct: number,
  calibrations: readonly AreaCalibration[],
  paidParkingArea: string | null,
  paidParkingSubarea: string | null,
): number {
  if (paidParkingArea === null) {
    return rawPredictedPct;
  }
  const subareaCalibration =
    paidParkingSubarea === null
      ? undefined
      : calibrations.find((c) => c.paidParkingArea === paidParkingArea && c.paidParkingSubarea === paidParkingSubarea);
  const areaCalibration = calibrations.find((c) => c.paidParkingArea === paidParkingArea && c.paidParkingSubarea === null);

  const band = findBand(subareaCalibration, rawPredictedPct) ?? findBand(areaCalibration, rawPredictedPct);
  return band === undefined ? rawPredictedPct : band.correctedPct;
}
