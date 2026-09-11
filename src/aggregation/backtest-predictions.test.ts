import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  bootstrapMeanConfidenceInterval,
  computeGroundTruth,
  computeSummary,
  formatCsv,
  formatSummaryReport,
  pacificMidnightInstant,
  parseCliOptions,
  parseResultsCsv,
  pearsonCorrelation,
  resolveGroundTruthDataset,
  resolveTrainingDatasets,
  runTestCase,
  TEST_CASES,
  type BacktestDeps,
  type TestCase,
  type TestCaseResult,
} from "./backtest-predictions.ts";
import type { RawReading } from "./blockfaceLookup.ts";
import type { SocrataRecord } from "../utils/fetchSocrataRecords.ts";

// --- pacificMidnightInstant ------------------------------------------------

describe("pacificMidnightInstant", () => {
  it("resolves a summer (PDT, UTC-7) date to the correct real instant", () => {
    // 2025-09-06 00:00 Pacific Daylight Time = 2025-09-06 07:00 UTC.
    expect(pacificMidnightInstant("2025-09-06").toISOString()).toBe("2025-09-06T07:00:00.000Z");
  });

  it("resolves a winter (PST, UTC-8) date to the correct real instant", () => {
    // 2025-01-15 00:00 Pacific Standard Time = 2025-01-15 08:00 UTC.
    expect(pacificMidnightInstant("2025-01-15").toISOString()).toBe("2025-01-15T08:00:00.000Z");
  });

  it("throws on a malformed date string", () => {
    expect(() => pacificMidnightInstant("09-06-2025")).toThrow(/expected a "YYYY-MM-DD" date/);
    expect(() => pacificMidnightInstant("not-a-date")).toThrow(/expected a "YYYY-MM-DD" date/);
  });
});

// --- addCalendarDays --------------------------------------------------

describe("addCalendarDays", () => {
  it("adds days within the same month", () => {
    expect(addCalendarDays("2025-09-06", 7)).toBe("2025-09-13");
  });

  it("crosses a month boundary", () => {
    expect(addCalendarDays("2025-09-27", 7)).toBe("2025-10-04");
  });

  it("crosses a year boundary", () => {
    expect(addCalendarDays("2025-12-28", 7)).toBe("2026-01-04");
  });

  it("supports zero days (identity)", () => {
    expect(addCalendarDays("2025-09-06", 0)).toBe("2025-09-06");
  });

  it("throws on a malformed date string", () => {
    expect(() => addCalendarDays("not-a-date", 7)).toThrow(/expected a "YYYY-MM-DD" date/);
  });
});

// --- resolveTrainingDatasets / resolveGroundTruthDataset -----------------

describe("resolveTrainingDatasets", () => {
  it("resolves a 2025 cutoff to just the 2025 archive, filtered to the cutoff", () => {
    expect(resolveTrainingDatasets(2025, "2025-09-06")).toEqual([
      { datasetId: "7c2e-uany", upperBoundNaive: "2025-09-06T00:00:00" },
    ]);
  });

  it("resolves a 2026 cutoff to the full 2025 archive plus the rolling window filtered to the cutoff", () => {
    expect(resolveTrainingDatasets(2026, "2026-08-15")).toEqual([
      { datasetId: "7c2e-uany", upperBoundNaive: null },
      { datasetId: "rke9-rsvs", upperBoundNaive: "2026-08-15T00:00:00" },
    ]);
  });

  it("throws for a year this harness's fixed test-case list doesn't cover", () => {
    expect(() => resolveTrainingDatasets(2024, "2024-01-01")).toThrow(/only covers 2025\/2026 cutoffs/);
  });
});

describe("resolveGroundTruthDataset", () => {
  it("resolves 2025 to the 2025 archive", () => {
    expect(resolveGroundTruthDataset(2025)).toBe("7c2e-uany");
  });

  it("resolves 2026 to the rolling window dataset", () => {
    expect(resolveGroundTruthDataset(2026)).toBe("rke9-rsvs");
  });

  it("throws for an unsupported year", () => {
    expect(() => resolveGroundTruthDataset(2027)).toThrow(/only covers 2025\/2026 cutoffs/);
  });
});

// --- computeGroundTruth --------------------------------------------------

function reading(occupancyDateTime: string, paidOccupancy: number, parkingSpaceCount: number): RawReading {
  return { sourceElementKey: 1, sideOfStreet: "E", occupancyDateTime, paidOccupancy, parkingSpaceCount };
}

describe("computeGroundTruth", () => {
  it("returns all-null/zero for an empty reading list", () => {
    expect(computeGroundTruth([])).toEqual({
      singleNearestMean: null,
      multiOccurrenceMean: null,
      occurrenceCount: 0,
      totalReadingCount: 0,
    });
  });

  it("computes a single occurrence's mean, with single-nearest equal to multi-occurrence", () => {
    const readings = [
      reading("2025-09-13T19:00:00.000", 4, 8), // 0.5
      reading("2025-09-13T19:30:00.000", 6, 8), // 0.75
    ];
    const result = computeGroundTruth(readings);
    expect(result.occurrenceCount).toBe(1);
    expect(result.totalReadingCount).toBe(2);
    expect(result.singleNearestMean).toBeCloseTo(0.625, 10);
    expect(result.multiOccurrenceMean).toBeCloseTo(0.625, 10);
  });

  it("distinguishes single-nearest from multi-occurrence-averaged across two real occurrences", () => {
    const readings = [
      // Nearest occurrence: mean 0.5
      reading("2025-09-13T19:00:00.000", 4, 8),
      reading("2025-09-13T19:30:00.000", 4, 8),
      // Second, later occurrence: mean 1.0
      reading("2025-09-20T19:00:00.000", 8, 8),
      reading("2025-09-20T19:30:00.000", 8, 8),
    ];
    const result = computeGroundTruth(readings);
    expect(result.occurrenceCount).toBe(2);
    expect(result.totalReadingCount).toBe(4);
    expect(result.singleNearestMean).toBeCloseTo(0.5, 10); // just the nearest (earlier) occurrence
    expect(result.multiOccurrenceMean).toBeCloseTo(0.75, 10); // average of the two occurrences' own means (0.5, 1.0)
  });

  it("clamps an over-100% reading the same way calculateOccupancyRatio does", () => {
    const readings = [reading("2025-09-13T19:00:00.000", 12, 8)]; // 1.5 -> clamped to 1.0
    expect(computeGroundTruth(readings).singleNearestMean).toBe(1);
  });
});

// --- pearsonCorrelation ----------------------------------------------------

describe("pearsonCorrelation", () => {
  it("returns 1 for a perfectly positive linear relationship", () => {
    expect(pearsonCorrelation([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 10);
  });

  it("returns -1 for a perfectly negative linear relationship (the working-calibration shape)", () => {
    expect(pearsonCorrelation([0, 1, 2, 3], [3, 2, 1, 0])).toBeCloseTo(-1, 10);
  });

  it("returns 0 when one series has zero variance", () => {
    expect(pearsonCorrelation([5, 5, 5], [1, 2, 3])).toBe(0);
  });

  it("throws when the two series have different lengths", () => {
    expect(() => pearsonCorrelation([1, 2], [1])).toThrow(/same length/);
  });

  it("throws with fewer than 2 data points", () => {
    expect(() => pearsonCorrelation([1], [1])).toThrow(/need at least 2 data points/);
    expect(() => pearsonCorrelation([], [])).toThrow(/need at least 2 data points/);
  });
});

// --- bootstrapMeanConfidenceInterval ---------------------------------------

// Deterministic mulberry32 PRNG, seeded -- purely a test-only convenience so
// these tests can hand-verify exact resample behavior instead of only
// checking loose statistical properties against real Math.random(). Never
// used in production code (bootstrapMeanConfidenceInterval defaults to the
// real Math.random()).
function makeSeededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A random function that always returns the same fixed sequence of
// fractions, cycling -- makes every resample select exactly the same
// indices in the same order, so the resample mean is hand-computable
// exactly rather than merely bounded.
function makeCyclingRandom(fractions: readonly number[]): () => number {
  let i = 0;
  return () => {
    const value = fractions[i % fractions.length] as number;
    i += 1;
    return value;
  };
}

describe("bootstrapMeanConfidenceInterval", () => {
  it("produces an exact, hand-computable result with a fixed cycling random sequence", () => {
    // values[0]=1, values[1]=2, values[2]=3 -- fractions 0, 1/3, 2/3 select
    // indices 0, 1, 2 in that order every time (floor(0*3)=0,
    // floor(0.34*3)=1, floor(0.67*3)=2), so every single resample is
    // exactly [1,2,3] and its mean is exactly 2.
    const randomFn = makeCyclingRandom([0, 0.34, 0.67]);
    const result = bootstrapMeanConfidenceInterval([1, 2, 3], 5, 0.95, randomFn);

    expect(result.observedMean).toBeCloseTo(2, 10);
    expect(result.meanOfResampleMeans).toBeCloseTo(2, 10);
    expect(result.lowerBound).toBeCloseTo(2, 10);
    expect(result.upperBound).toBeCloseTo(2, 10);
    expect(result.fractionResamplesNegative).toBe(0);
    expect(result.resampleCount).toBe(5);
    expect(result.sampleSize).toBe(3);
  });

  it("brackets the observed mean and matches its sign for a real, consistently-negative sample", () => {
    const values = [-0.6, -0.5, -0.55, -0.45, -0.5, -0.6, -0.4];
    const result = bootstrapMeanConfidenceInterval(values, 2000, 0.95, makeSeededRandom(42));

    expect(result.observedMean).toBeLessThan(0);
    expect(result.lowerBound).toBeLessThanOrEqual(result.upperBound);
    expect(result.meanOfResampleMeans).toBeCloseTo(result.observedMean, 1);
    // Every real value is clearly negative with modest spread -- the bias's
    // sign should be essentially always reproduced across resamples.
    expect(result.fractionResamplesNegative).toBeGreaterThan(0.95);
    expect(result.upperBound).toBeLessThan(0); // even the CI's high end stays negative
  });

  it("shows real instability (fractionResamplesNegative near 0.5) when the true mean is near zero with high variance", () => {
    const values = [-1, 1, -1, 1, -1, 1, 0.1, -0.1];
    const result = bootstrapMeanConfidenceInterval(values, 2000, 0.95, makeSeededRandom(7));
    expect(result.fractionResamplesNegative).toBeGreaterThan(0.3);
    expect(result.fractionResamplesNegative).toBeLessThan(0.7);
  });

  it("throws on an empty values array", () => {
    expect(() => bootstrapMeanConfidenceInterval([], 100, 0.95)).toThrow(/values must not be empty/);
  });

  it("throws on a non-positive-integer resampleCount", () => {
    expect(() => bootstrapMeanConfidenceInterval([1, 2], 0, 0.95)).toThrow(/resampleCount must be a positive integer/);
    expect(() => bootstrapMeanConfidenceInterval([1, 2], -5, 0.95)).toThrow(/resampleCount must be a positive integer/);
    expect(() => bootstrapMeanConfidenceInterval([1, 2], 2.5, 0.95)).toThrow(/resampleCount must be a positive integer/);
  });

  it("throws on a confidenceLevel outside (0, 1)", () => {
    expect(() => bootstrapMeanConfidenceInterval([1, 2], 100, 0)).toThrow(/confidenceLevel must be a finite number strictly between 0 and 1/);
    expect(() => bootstrapMeanConfidenceInterval([1, 2], 100, 1)).toThrow(/confidenceLevel must be a finite number strictly between 0 and 1/);
    expect(() => bootstrapMeanConfidenceInterval([1, 2], 100, 1.5)).toThrow(/confidenceLevel must be a finite number strictly between 0 and 1/);
    expect(() => bootstrapMeanConfidenceInterval([1, 2], 100, NaN)).toThrow(/confidenceLevel must be a finite number strictly between 0 and 1/);
  });
});

// --- parseCliOptions ---------------------------------------------------

describe("parseCliOptions", () => {
  it("defaults to no limit, outDir 'backtest-output', and no --from-csv", () => {
    expect(parseCliOptions([])).toEqual({ limit: null, outDir: "backtest-output", fromCsv: null });
  });

  it("parses --limit and --out-dir", () => {
    expect(parseCliOptions(["--limit=5", "--out-dir=/tmp/out"])).toEqual({ limit: 5, outDir: "/tmp/out", fromCsv: null });
  });

  it("parses --from-csv", () => {
    expect(parseCliOptions(["--from-csv=/tmp/results.csv"])).toEqual({ limit: null, outDir: "backtest-output", fromCsv: "/tmp/results.csv" });
  });

  it("throws for a non-positive-integer --limit", () => {
    expect(() => parseCliOptions(["--limit=0"])).toThrow(/must be a positive integer/);
    expect(() => parseCliOptions(["--limit=-3"])).toThrow(/must be a positive integer/);
    expect(() => parseCliOptions(["--limit=abc"])).toThrow(/must be a positive integer/);
  });
});

// --- runTestCase (fake Socrata deps, no real network) ---------------------

const BASE_TEST_CASE: TestCase = {
  label: "fake_case",
  blockfaceId: "00000000-0000-0000-0000-000000000001",
  sourceElementKey: 12345,
  sideOfStreet: "E",
  isoDay: 6,
  hour: 19,
  cutoffDateOnly: "2025-09-06",
  horizonDays: 7,
  slice: "general",
};

function makeSocrataRecord(occupancyDateTime: string, paidOccupancy: number, parkingSpaceCount: number): SocrataRecord {
  return {
    sourceelementkey: "12345",
    sideofstreet: "E",
    occupancydatetime: occupancyDateTime,
    paidoccupancy: String(paidOccupancy),
    parkingspacecount: String(parkingSpaceCount),
  };
}

// 40 well-formed training readings, all at a stable, well-supported ~50%
// occupancy -- comfortably above MIN_READINGS_PER_BUCKET (30), so
// decideBucketStats returns real stats rather than null.
function makeTrainingRecords(): SocrataRecord[] {
  const records: SocrataRecord[] = [];
  for (let i = 0; i < 40; i++) {
    records.push(makeSocrataRecord(`2025-08-${String(2 + (i % 20)).padStart(2, "0")}T19:00:00.000`, 4, 8));
  }
  return records;
}

describe("runTestCase", () => {
  it("wires training -> predict and ground truth -> error correctly against a fake Socrata backend", async () => {
    const trainingRecords = makeTrainingRecords();
    const groundTruthRecords = [makeSocrataRecord("2025-09-13T19:00:00.000", 6, 8)]; // 0.75

    const deps: BacktestDeps = {
      fetchRecords: async (_datasetUrl, whereClause) => {
        // The two queries this test case issues are distinguishable by
        // their date-range bound: training has an upper bound only,
        // ground truth has both a lower and upper bound.
        if (whereClause.includes(">=")) {
          return groundTruthRecords;
        }
        return trainingRecords;
      },
    };

    const result = await runTestCase(BASE_TEST_CASE, deps);

    expect(result.skippedReason).toBeNull();
    expect(result.predictedMean).toBeCloseTo(0.5, 5); // every training reading is paidOccupancy=4/8
    expect(result.sampleCount).toBe(40);
    expect(result.observedParkingSpaceCount).toBe(8);
    expect(result.lowCapacity).toBe(false);
    expect(result.singleNearestActualMean).toBeCloseTo(0.75, 10);
    expect(result.errorSingleNearest).toBeCloseTo(0.5 - 0.75, 5);
    expect(result.absErrorSingleNearest).toBeCloseTo(0.25, 5);
    expect(result.confidenceScore).not.toBeNull();
  });

  it("marks insufficient_training_data when fewer than MIN_READINGS_PER_BUCKET readings are found", async () => {
    const deps: BacktestDeps = {
      fetchRecords: async (_datasetUrl, whereClause) => {
        if (whereClause.includes(">=")) {
          return [makeSocrataRecord("2025-09-13T19:00:00.000", 6, 8)];
        }
        return [makeSocrataRecord("2025-08-02T19:00:00.000", 4, 8)]; // just 1 reading, far below 30
      },
    };

    const result = await runTestCase(BASE_TEST_CASE, deps);
    expect(result.skippedReason).toBe("insufficient_training_data");
    expect(result.predictedMean).toBeNull();
  });

  it("marks no_ground_truth_data when training succeeds but no future readings exist", async () => {
    const trainingRecords = makeTrainingRecords();
    const deps: BacktestDeps = {
      fetchRecords: async (_datasetUrl, whereClause) => {
        if (whereClause.includes(">=")) {
          return [];
        }
        return trainingRecords;
      },
    };

    const result = await runTestCase(BASE_TEST_CASE, deps);
    expect(result.skippedReason).toBe("no_ground_truth_data");
    expect(result.predictedMean).toBeCloseTo(0.5, 5); // prediction itself still computed and recorded
    expect(result.singleNearestActualMean).toBeNull();
  });

  it("flags low-capacity blockfaces (< 6 spaces) using the training window's own observed capacity", async () => {
    const smallCapacityRecords: SocrataRecord[] = [];
    for (let i = 0; i < 35; i++) {
      smallCapacityRecords.push(makeSocrataRecord(`2025-08-${String(2 + (i % 20)).padStart(2, "0")}T19:00:00.000`, 2, 4));
    }
    const deps: BacktestDeps = {
      fetchRecords: async (_datasetUrl, whereClause) => {
        if (whereClause.includes(">=")) {
          return [makeSocrataRecord("2025-09-13T19:00:00.000", 2, 4)];
        }
        return smallCapacityRecords;
      },
    };

    const result = await runTestCase(BASE_TEST_CASE, deps);
    expect(result.observedParkingSpaceCount).toBe(4);
    expect(result.lowCapacity).toBe(true);
  });

  it("records fetch_error, not a thrown exception, when the Socrata dependency fails", async () => {
    const deps: BacktestDeps = {
      fetchRecords: async () => {
        throw new Error("simulated network failure");
      },
    };

    const result = await runTestCase(BASE_TEST_CASE, deps);
    expect(result.skippedReason).toBe("fetch_error");
    expect(result.skippedDetail).toMatch(/simulated network failure/);
  });
});

// --- computeSummary / formatCsv / formatSummaryReport ----------------------

function makeResult(overrides: Partial<TestCaseResult>): TestCaseResult {
  return {
    label: "case",
    blockfaceId: "id",
    isoDay: 6,
    hour: 19,
    cutoffDateOnly: "2025-09-06",
    horizonDays: 7,
    slice: "general",
    predictedMean: 0.5,
    confidenceScore: 5,
    sampleCount: 100,
    stdDev: 0.2,
    observedParkingSpaceCount: 8,
    lowCapacity: false,
    singleNearestActualMean: 0.5,
    multiOccurrenceActualMean: 0.5,
    groundTruthOccurrenceCount: 1,
    groundTruthReadingCount: 10,
    errorSingleNearest: 0,
    absErrorSingleNearest: 0,
    errorMultiOccurrence: 0,
    absErrorMultiOccurrence: 0,
    skippedReason: null,
    skippedDetail: null,
    ...overrides,
  };
}

describe("computeSummary", () => {
  it("throws when every case was skipped (nothing scored)", () => {
    expect(() => computeSummary([makeResult({ skippedReason: "insufficient_training_data", predictedMean: null, absErrorSingleNearest: null })])).toThrow(
      /no scored test cases/,
    );
  });

  it("computes overall MAE and mean signed error from a small hand-checkable set", () => {
    const results = [
      makeResult({ errorSingleNearest: 0.1, absErrorSingleNearest: 0.1, errorMultiOccurrence: 0.1, absErrorMultiOccurrence: 0.1, confidenceScore: 8 }),
      makeResult({ errorSingleNearest: -0.3, absErrorSingleNearest: 0.3, errorMultiOccurrence: -0.3, absErrorMultiOccurrence: 0.3, confidenceScore: 2 }),
    ];
    const summary = computeSummary(results);
    expect(summary.totalCases).toBe(2);
    expect(summary.scoredCases).toBe(2);
    expect(summary.overallMaeSingleNearest).toBeCloseTo(0.2, 10);
    expect(summary.meanSignedErrorSingleNearest).toBeCloseTo(-0.1, 10);
  });

  it("shows a negative confidence-error correlation when higher confidence genuinely has lower error", () => {
    const results = [
      makeResult({ confidenceScore: 0, absErrorSingleNearest: 0.5, errorSingleNearest: 0.5 }),
      makeResult({ confidenceScore: 3, absErrorSingleNearest: 0.3, errorSingleNearest: 0.3 }),
      makeResult({ confidenceScore: 6, absErrorSingleNearest: 0.15, errorSingleNearest: 0.15 }),
      makeResult({ confidenceScore: 10, absErrorSingleNearest: 0.02, errorSingleNearest: 0.02 }),
    ];
    const summary = computeSummary(results);
    expect(summary.confidenceErrorCorrelation).toBeLessThan(0);
  });

  it("separates the named capitol_hill_saturday and general slices", () => {
    const results = [
      makeResult({ slice: "capitol_hill_saturday", absErrorSingleNearest: 0.4, errorSingleNearest: 0.4 }),
      makeResult({ slice: "general", absErrorSingleNearest: 0.1, errorSingleNearest: 0.1 }),
    ];
    const summary = computeSummary(results);
    const capitolHill = summary.slices.find((s) => s.name === "capitol_hill_saturday");
    const general = summary.slices.find((s) => s.name === "general");
    expect(capitolHill?.maeSingleNearest).toBeCloseTo(0.4, 10);
    expect(general?.maeSingleNearest).toBeCloseTo(0.1, 10);
  });

  it("attaches a bootstrap result to every non-empty slice", () => {
    const results = [
      makeResult({ slice: "general", absErrorSingleNearest: 0.1, errorSingleNearest: 0.1 }),
      makeResult({ slice: "general", absErrorSingleNearest: 0.2, errorSingleNearest: -0.2 }),
    ];
    const summary = computeSummary(results);
    const general = summary.slices.find((s) => s.name === "general");
    expect(general?.bootstrap).not.toBeNull();
    expect(general?.bootstrap?.sampleSize).toBe(2);
  });

  it("separates low-capacity from standard-capacity slices", () => {
    const results = [
      makeResult({ lowCapacity: true, observedParkingSpaceCount: 4, absErrorSingleNearest: 0.6, errorSingleNearest: 0.6 }),
      makeResult({ lowCapacity: false, observedParkingSpaceCount: 12, absErrorSingleNearest: 0.05, errorSingleNearest: 0.05 }),
    ];
    const summary = computeSummary(results);
    const low = summary.slices.find((s) => s.name.startsWith("low_capacity"));
    const standard = summary.slices.find((s) => s.name.startsWith("standard_capacity"));
    expect(low?.maeSingleNearest).toBeCloseTo(0.6, 10);
    expect(standard?.maeSingleNearest).toBeCloseTo(0.05, 10);
  });
});

describe("formatCsv", () => {
  it("produces a header row plus one row per result", () => {
    const csv = formatCsv([makeResult({})]);
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      "label,blockfaceId,isoDay,hour,cutoffDateOnly,horizonDays,slice,predictedMean,confidenceScore,sampleCount,stdDev,observedParkingSpaceCount,lowCapacity,singleNearestActualMean,multiOccurrenceActualMean,groundTruthOccurrenceCount,groundTruthReadingCount,errorSingleNearest,absErrorSingleNearest,errorMultiOccurrence,absErrorMultiOccurrence,skippedReason,skippedDetail",
    );
  });

  it("renders a null field as an empty CSV cell", () => {
    const csv = formatCsv([makeResult({ skippedReason: "insufficient_training_data", predictedMean: null })]);
    const dataRow = csv.trim().split("\n")[1] as string;
    expect(dataRow).toMatch(/,,/); // an empty cell shows up as two consecutive commas somewhere in the row
  });

  it("quotes a field containing a comma", () => {
    const csv = formatCsv([makeResult({ skippedDetail: "failed, retrying" })]);
    expect(csv).toContain('"failed, retrying"');
  });
});

describe("parseResultsCsv", () => {
  it("round-trips a normal scored result exactly through formatCsv", () => {
    const original = makeResult({ label: "roundtrip_case", predictedMean: 0.4123, confidenceScore: 7, lowCapacity: true });
    const parsed = parseResultsCsv(formatCsv([original]));
    expect(parsed).toEqual([original]);
  });

  it("round-trips a skipped result (with null numeric fields) exactly", () => {
    const original = makeResult({
      skippedReason: "no_ground_truth_data",
      predictedMean: 0.5,
      confidenceScore: 6,
      singleNearestActualMean: null,
      multiOccurrenceActualMean: null,
      errorSingleNearest: null,
      absErrorSingleNearest: null,
      errorMultiOccurrence: null,
      absErrorMultiOccurrence: null,
      skippedDetail: null,
    });
    const parsed = parseResultsCsv(formatCsv([original]));
    expect(parsed).toEqual([original]);
  });

  it("round-trips a field containing a comma and embedded quotes", () => {
    const original = makeResult({ skippedReason: "fetch_error", skippedDetail: 'failed, retried "twice"' });
    const parsed = parseResultsCsv(formatCsv([original]));
    expect(parsed[0]?.skippedDetail).toBe('failed, retried "twice"');
  });

  it("returns an empty array for an empty/header-only CSV", () => {
    expect(parseResultsCsv("")).toEqual([]);
    expect(parseResultsCsv(formatCsv([]))).toEqual([]);
  });

  it("throws when the header doesn't match formatCsv's own columns", () => {
    expect(() => parseResultsCsv("wrong,header\nvalue,value")).toThrow(/CSV header does not match/);
  });

  it("throws when a data row has the wrong number of fields", () => {
    const header = formatCsv([]).trim();
    expect(() => parseResultsCsv(`${header}\ntoo,few,fields`)).toThrow(/has 3 fields, expected/);
  });
});

describe("formatSummaryReport", () => {
  it("produces a non-empty, readable report containing the headline correlation", () => {
    const summary = computeSummary([
      makeResult({ confidenceScore: 7, absErrorSingleNearest: 0.1, errorSingleNearest: 0.1 }),
      makeResult({ confidenceScore: 2, absErrorSingleNearest: 0.3, errorSingleNearest: 0.3 }),
    ]);
    const report = formatSummaryReport(summary);
    expect(report).toContain("Confidence-vs-error correlation");
    expect(report).toContain("Slices");
  });
});

// --- TEST_CASES (the fixed list itself) ------------------------------------

describe("TEST_CASES", () => {
  it("is non-empty and every case is well-formed", () => {
    expect(TEST_CASES.length).toBeGreaterThan(0);
    for (const testCase of TEST_CASES) {
      expect(testCase.isoDay).toBeGreaterThanOrEqual(1);
      expect(testCase.isoDay).toBeLessThanOrEqual(7);
      expect(testCase.hour).toBeGreaterThanOrEqual(0);
      expect(testCase.hour).toBeLessThanOrEqual(23);
      expect(testCase.horizonDays).toBeGreaterThan(0);
      expect(testCase.cutoffDateOnly).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("has every label unique (no accidental duplicate test cases)", () => {
    const labels = TEST_CASES.map((tc) => tc.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("includes the dedicated multi-occurrence (14-day horizon) demonstration cases", () => {
    const multiOccCases = TEST_CASES.filter((tc) => tc.horizonDays === 14);
    expect(multiOccCases.length).toBe(4); // one per Capitol Hill blockface
    expect(multiOccCases.every((tc) => tc.slice === "capitol_hill_saturday")).toBe(true);
  });

});
