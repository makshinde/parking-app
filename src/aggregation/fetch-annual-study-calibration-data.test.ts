import { describe, expect, it } from "vitest";
import {
  buildCalibrationInputs,
  buildPairKey,
  computeStudyGroundTruthPct,
  groupCalibrationPairs,
  parseStudyDateTime,
} from "./fetch-annual-study-calibration-data";
import type { BlockfaceAreaRow, StudyRow } from "./fetch-annual-study-calibration-data";

describe("parseStudyDateTime", () => {
  it("parses a real study timestamp into isoDay/hour", () => {
    // 2018-04-04 was a Wednesday -> ISO day 3.
    expect(parseStudyDateTime("4/4/2018 23:00")).toEqual({ isoDay: 3, hour: 23 });
  });

  it("handles single-digit month/day/hour", () => {
    // 2018-01-02 was a Tuesday -> ISO day 2.
    expect(parseStudyDateTime("1/2/2018 9:00")).toEqual({ isoDay: 2, hour: 9 });
  });

  it("maps a Sunday to ISO day 7, not 0", () => {
    // 2018-04-01 was a Sunday.
    expect(parseStudyDateTime("4/1/2018 12:00").isoDay).toBe(7);
  });

  it("throws on a malformed timestamp", () => {
    expect(() => parseStudyDateTime("not-a-date")).toThrow(/does not match/);
    expect(() => parseStudyDateTime("2018-04-04T23:00:00")).toThrow(/does not match/);
  });
});

describe("computeStudyGroundTruthPct", () => {
  it("computes a normal fraction as a percentage", () => {
    expect(computeStudyGroundTruthPct(10, 7)).toBe(70);
  });

  it("clamps a vehicle count exceeding the recorded space count to 100, not rejecting it", () => {
    expect(computeStudyGroundTruthPct(5, 8)).toBe(100);
  });

  it("returns null for a non-positive space count -- no meaningful ratio exists", () => {
    expect(computeStudyGroundTruthPct(0, 3)).toBeNull();
    expect(computeStudyGroundTruthPct(-1, 3)).toBeNull();
  });
});

describe("buildPairKey", () => {
  it("is stable for the same inputs and distinct for different ones", () => {
    expect(buildPairKey("1021", "SW", "4/4/2018 23:00")).toBe(buildPairKey("1021", "SW", "4/4/2018 23:00"));
    expect(buildPairKey("1021", "SW", "4/4/2018 23:00")).not.toBe(buildPairKey("1021", "NE", "4/4/2018 23:00"));
  });
});

describe("buildCalibrationInputs", () => {
  const blockface: BlockfaceAreaRow = {
    id: "bf-1",
    source_element_key: 1021,
    side_of_street: "SW",
    paidparkingarea: "Ballard",
    paidparkingsubarea: "Core",
  };
  const blockfacesByKey = new Map([["1021|SW", blockface]]);

  it("joins a real study row to its blockface and occupancy_stats bucket", () => {
    const studyRows: StudyRow[] = [{ elmntkey: "1021", side: "SW", date_time: "4/4/2018 23:00", parking_spaces: "10", total_vehicle_count: "7" }];
    const occStatsByKey = new Map([["bf-1|3|23", { source_element_key: 0, side_of_street: "", day_of_week: 3, hour_of_day: 23, mean_occupancy: 0.4 }]]);
    const result = buildCalibrationInputs(studyRows, blockfacesByKey, occStatsByKey);
    expect(result).toHaveLength(1);
    expect(result[0]?.pair).toEqual({ area: "Ballard", subarea: "Core", pair: { predictedPct: 40, groundTruthPct: 70 } });
  });

  it("skips a study row whose blockface isn't in our own database", () => {
    const studyRows: StudyRow[] = [{ elmntkey: "99999", side: "SW", date_time: "4/4/2018 23:00", parking_spaces: "10", total_vehicle_count: "7" }];
    expect(buildCalibrationInputs(studyRows, blockfacesByKey, new Map())).toHaveLength(0);
  });

  it("skips a study row with no matching occupancy_stats bucket for that exact isoDay/hour", () => {
    const studyRows: StudyRow[] = [{ elmntkey: "1021", side: "SW", date_time: "4/4/2018 23:00", parking_spaces: "10", total_vehicle_count: "7" }];
    expect(buildCalibrationInputs(studyRows, blockfacesByKey, new Map())).toHaveLength(0);
  });

  it("skips a row with a malformed timestamp instead of throwing", () => {
    const studyRows: StudyRow[] = [{ elmntkey: "1021", side: "SW", date_time: "garbage", parking_spaces: "10", total_vehicle_count: "7" }];
    expect(buildCalibrationInputs(studyRows, blockfacesByKey, new Map())).toHaveLength(0);
  });

  it("skips a row with a zero recorded space count", () => {
    const studyRows: StudyRow[] = [{ elmntkey: "1021", side: "SW", date_time: "4/4/2018 23:00", parking_spaces: "0", total_vehicle_count: "7" }];
    const occStatsByKey = new Map([["bf-1|3|23", { source_element_key: 0, side_of_street: "", day_of_week: 3, hour_of_day: 23, mean_occupancy: 0.4 }]]);
    expect(buildCalibrationInputs(studyRows, blockfacesByKey, occStatsByKey)).toHaveLength(0);
  });
});

describe("groupCalibrationPairs", () => {
  it("groups pairs by (area, subarea), keeping distinct subareas separate", () => {
    const grouped = groupCalibrationPairs([
      { area: "Ballard", subarea: "Core", pair: { predictedPct: 10, groundTruthPct: 20 } },
      { area: "Ballard", subarea: "Core", pair: { predictedPct: 15, groundTruthPct: 25 } },
      { area: "Ballard", subarea: "Edge", pair: { predictedPct: 5, groundTruthPct: 10 } },
      { area: "Ballard", subarea: null, pair: { predictedPct: 8, groundTruthPct: 12 } },
    ]);
    expect(grouped).toHaveLength(3);
    const core = grouped.find((g) => g.paidParkingSubarea === "Core");
    expect(core?.pairs).toHaveLength(2);
  });
});
