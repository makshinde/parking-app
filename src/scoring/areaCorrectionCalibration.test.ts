import { describe, expect, it } from "vitest";
import {
  applyAreaCorrection,
  fitAreaCalibration,
  fitAreaCalibrationsWithFallback,
  MIN_AREA_CALIBRATION_SAMPLES,
  MIN_BAND_CALIBRATION_SAMPLES,
  splitTrainHoldout,
} from "./areaCorrectionCalibration";
import type { AreaCalibration, CalibrationPair, GroupedCalibrationPairs, SplitInput } from "./areaCorrectionCalibration";

describe("splitTrainHoldout", () => {
  it("puts every input into either train or holdout, never both, never dropped", () => {
    const inputs: SplitInput<number>[] = Array.from({ length: 200 }, (_, i) => ({ key: `key-${i}`, pair: i }));
    const { train, holdout } = splitTrainHoldout(inputs, 0.7);
    expect(train.length + holdout.length).toBe(200);
    expect(new Set([...train, ...holdout]).size).toBe(200);
  });

  it("is deterministic -- the same inputs always split the same way", () => {
    const inputs: SplitInput<string>[] = [
      { key: "a", pair: "A" },
      { key: "b", pair: "B" },
      { key: "c", pair: "C" },
    ];
    const first = splitTrainHoldout(inputs, 0.7);
    const second = splitTrainHoldout(inputs, 0.7);
    expect(first).toEqual(second);
  });

  it("produces roughly the requested train fraction over a large, varied input", () => {
    const inputs: SplitInput<number>[] = Array.from({ length: 5000 }, (_, i) => ({ key: `elmntkey-${i}-side-N`, pair: i }));
    const { train, holdout } = splitTrainHoldout(inputs, 0.7);
    const trainShare = train.length / (train.length + holdout.length);
    expect(trainShare).toBeGreaterThan(0.6);
    expect(trainShare).toBeLessThan(0.8);
  });

  it("clamps an out-of-range trainFraction instead of throwing", () => {
    const inputs: SplitInput<number>[] = [{ key: "a", pair: 1 }];
    expect(() => splitTrainHoldout(inputs, 1.5)).not.toThrow();
    expect(() => splitTrainHoldout(inputs, -0.5)).not.toThrow();
  });

  it("throws for a non-finite trainFraction", () => {
    expect(() => splitTrainHoldout([], NaN)).toThrow(/finite/);
    expect(() => splitTrainHoldout([], Infinity)).toThrow(/finite/);
  });
});

function makePairs(count: number, predictedPct: number, groundTruthPct: number): CalibrationPair[] {
  return Array.from({ length: count }, () => ({ predictedPct, groundTruthPct }));
}

describe("fitAreaCalibration", () => {
  it("returns null when the area has fewer than MIN_AREA_CALIBRATION_SAMPLES pairs", () => {
    const pairs = makePairs(MIN_AREA_CALIBRATION_SAMPLES - 1, 10, 40);
    expect(fitAreaCalibration("TestArea", null, pairs)).toBeNull();
  });

  it("fits real bands once there's enough evidence, with sample counts intact", () => {
    const pairs = [
      ...makePairs(MIN_AREA_CALIBRATION_SAMPLES, 10, 40), // band [0,25) -> ~40
      ...makePairs(MIN_AREA_CALIBRATION_SAMPLES, 60, 70), // band [50,75) -> ~70
    ];
    const calibration = fitAreaCalibration("Ballard", null, pairs);
    expect(calibration).not.toBeNull();
    expect(calibration?.paidParkingArea).toBe("Ballard");
    expect(calibration?.paidParkingSubarea).toBeNull();
    const lowBand = calibration?.bands.find((b) => b.predictedBandLow === 0);
    const midBand = calibration?.bands.find((b) => b.predictedBandLow === 50);
    expect(lowBand?.correctedPct).toBeCloseTo(40, 5);
    expect(midBand?.correctedPct).toBeCloseTo(70, 5);
  });

  it("drops an individual band that never clears the per-band minimum, even when the area total clears its own minimum", () => {
    const pairs = [
      ...makePairs(MIN_AREA_CALIBRATION_SAMPLES, 10, 40), // one huge, well-evidenced band
      ...makePairs(MIN_BAND_CALIBRATION_SAMPLES - 5, 90, 95), // a sparse band that stays below MIN_BAND_CALIBRATION_SAMPLES after PAVA
    ];
    const calibration = fitAreaCalibration("TestArea", null, pairs);
    expect(calibration?.bands.some((b) => b.predictedBandLow === 75)).toBe(false);
  });

  it("enforces monotonicity via pool-adjacent-violators when raw band averages would otherwise decrease", () => {
    // A real, noisy case: the high-predicted band's raw average (30) is
    // LOWER than the low-predicted band's (60) -- physically implausible
    // for this correction (higher predicted should never correct to lower
    // real occupancy), so PAVA must merge them into one non-decreasing pool.
    const pairs = [
      ...makePairs(MIN_AREA_CALIBRATION_SAMPLES, 10, 60),
      ...makePairs(MIN_AREA_CALIBRATION_SAMPLES, 60, 30),
    ];
    const calibration = fitAreaCalibration("TestArea", null, pairs);
    expect(calibration).not.toBeNull();
    const values = (calibration?.bands ?? []).map((b) => b.correctedPct);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1] as number);
    }
  });
});

describe("fitAreaCalibrationsWithFallback", () => {
  it("fits both a subarea calibration and its parent area's pooled calibration when both have enough evidence", () => {
    const groups: GroupedCalibrationPairs[] = [
      { paidParkingArea: "Belltown", paidParkingSubarea: "North", pairs: makePairs(MIN_AREA_CALIBRATION_SAMPLES, 10, 50) },
      { paidParkingArea: "Belltown", paidParkingSubarea: "South", pairs: makePairs(MIN_AREA_CALIBRATION_SAMPLES, 10, 45) },
    ];
    const results = fitAreaCalibrationsWithFallback(groups);
    const subareaResults = results.filter((r) => r.paidParkingArea === "Belltown" && r.paidParkingSubarea !== null);
    const areaResult = results.find((r) => r.paidParkingArea === "Belltown" && r.paidParkingSubarea === null);
    expect(subareaResults).toHaveLength(2);
    expect(areaResult).toBeDefined();
    // The area-level fit pools BOTH subareas' pairs, so it has more total
    // evidence behind it than either subarea alone.
    expect(areaResult?.bands[0]?.sampleCount).toBe(2 * MIN_AREA_CALIBRATION_SAMPLES);
  });

  it("still fits the area level even when every individual subarea lacks enough evidence on its own", () => {
    const groups: GroupedCalibrationPairs[] = [
      { paidParkingArea: "SmallArea", paidParkingSubarea: "A", pairs: makePairs(MIN_AREA_CALIBRATION_SAMPLES / 2, 10, 50) },
      { paidParkingArea: "SmallArea", paidParkingSubarea: "B", pairs: makePairs(MIN_AREA_CALIBRATION_SAMPLES / 2, 10, 50) },
    ];
    const results = fitAreaCalibrationsWithFallback(groups);
    expect(results.filter((r) => r.paidParkingSubarea !== null)).toHaveLength(0);
    expect(results.find((r) => r.paidParkingArea === "SmallArea" && r.paidParkingSubarea === null)).toBeDefined();
  });

  it("returns no calibration at all for an area whose pooled total never clears MIN_AREA_CALIBRATION_SAMPLES", () => {
    const groups: GroupedCalibrationPairs[] = [
      { paidParkingArea: "TinyArea", paidParkingSubarea: null, pairs: makePairs(10, 10, 50) },
    ];
    const results = fitAreaCalibrationsWithFallback(groups);
    expect(results).toHaveLength(0);
  });
});

describe("applyAreaCorrection", () => {
  const calibrations: AreaCalibration[] = [
    {
      paidParkingArea: "Ballard",
      paidParkingSubarea: null,
      bands: [{ predictedBandLow: 0, predictedBandHigh: 25, correctedPct: 45, sampleCount: 100 }],
    },
    {
      paidParkingArea: "Ballard",
      paidParkingSubarea: "Core",
      bands: [{ predictedBandLow: 0, predictedBandHigh: 25, correctedPct: 55, sampleCount: 40 }],
    },
  ];

  it("prefers a subarea-specific band over the area-level one when both cover the same predicted value", () => {
    expect(applyAreaCorrection(10, calibrations, "Ballard", "Core")).toBe(55);
  });

  it("falls back to the area-level band when no subarea calibration exists for that block", () => {
    expect(applyAreaCorrection(10, calibrations, "Ballard", "Edge")).toBe(45);
    expect(applyAreaCorrection(10, calibrations, "Ballard", null)).toBe(45);
  });

  it("returns the raw predicted value unchanged when the area has no calibration at all", () => {
    expect(applyAreaCorrection(10, calibrations, "SomeUncalibratedArea", null)).toBe(10);
  });

  it("returns the raw predicted value unchanged when the blockface has no area on record", () => {
    expect(applyAreaCorrection(10, calibrations, null, null)).toBe(10);
  });

  it("returns the raw predicted value unchanged when the predicted value falls outside every fitted band", () => {
    // Only the [0,25) band was fit in this test's calibrations -- 80 falls
    // in an unfitted range.
    expect(applyAreaCorrection(80, calibrations, "Ballard", null)).toBe(80);
  });
});
