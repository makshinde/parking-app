// The real, independently-gathered field-test and transaction-coverage-
// rebuild results from tonight's investigation (see CLAUDE.md's
// field-testing section). This file exists specifically so
// runAreaCorrectionValidation (backtest-predictions.ts) has a final
// ground-truth set that fitAreaCalibration NEVER saw during fitting --
// fetch-annual-study-calibration-data.ts and fit-and-write-area-corrections.ts
// read only the Annual Parking Study; nothing in this repo's fitting path
// imports this file. If that ever changes, this file's entire purpose as
// an independent check is gone.
//
// sourceElementKey/side identify the real blockface each point was
// measured against (see CLAUDE.md for how each was matched, including the
// reverse-percentage-matching technique used where the exact test hour
// wasn't logged). paidParkingArea is the real SDOT PAIDAREA value for
// that blockface, confirmed against the Blockface FeatureServer tonight;
// null means it was never confirmed against a specific area and should be
// excluded from any area-specific validation slice (it can still count
// toward a citywide, uncorrected-vs-uncorrected sanity check).

export interface FieldTestPoint {
  name: string;
  sourceElementKey: number;
  sideOfStreet: string;
  paidParkingArea: string | null;
  realOccupiedCount: number;
  realTotalSpaces: number;
  appPredictedPct: number;
}

export const FIELD_TEST_POINTS: readonly FieldTestPoint[] = [
  // Destination 1 -- Imperial Kitchen and Bar, Belltown
  { name: "1st Ave (Battery-Wall)", sourceElementKey: 1026, sideOfStreet: "NE", paidParkingArea: "Belltown", realOccupiedCount: 9, realTotalSpaces: 18, appPredictedPct: 40 },
  { name: "1st Ave (Wall-Vine)", sourceElementKey: 24045, sideOfStreet: "SW", paidParkingArea: "Belltown", realOccupiedCount: 3, realTotalSpaces: 9, appPredictedPct: 25 },
  { name: "Wall St (1st-Western)", sourceElementKey: 58681, sideOfStreet: "NW", paidParkingArea: "Belltown", realOccupiedCount: 10, realTotalSpaces: 15, appPredictedPct: 43 },
  { name: "Wall St (2nd-3rd)", sourceElementKey: 58685, sideOfStreet: "NW", paidParkingArea: "Belltown", realOccupiedCount: 6, realTotalSpaces: 12, appPredictedPct: 28 },
  { name: "2nd Ave (Vine-Cedar)", sourceElementKey: 25717, sideOfStreet: "SW", paidParkingArea: "Belltown", realOccupiedCount: 7, realTotalSpaces: 10, appPredictedPct: 28 },
  { name: "Vine St (2nd-3rd)", sourceElementKey: 58621, sideOfStreet: "NW", paidParkingArea: "Belltown", realOccupiedCount: 1, realTotalSpaces: 7, appPredictedPct: 26 },
  { name: "Battery St (2nd-3rd)", sourceElementKey: 76986, sideOfStreet: "SE", paidParkingArea: "Belltown", realOccupiedCount: 13, realTotalSpaces: 16, appPredictedPct: 43 },
  { name: "Bell St (1st-2nd)", sourceElementKey: 32022, sideOfStreet: "SE", paidParkingArea: "Belltown", realOccupiedCount: 3, realTotalSpaces: 5, appPredictedPct: 10 },
  { name: "1st Ave (Bell-Blanchard)", sourceElementKey: 24037, sideOfStreet: "SW", paidParkingArea: "Belltown", realOccupiedCount: 17, realTotalSpaces: 25, appPredictedPct: 30 },

  // Destination 2 -- Sizzle n Crunch, South Lake Union
  { name: "9th Ave N (Republican-Mercer)", sourceElementKey: 53810, sideOfStreet: "E", paidParkingArea: "South Lake Union", realOccupiedCount: 1, realTotalSpaces: 3, appPredictedPct: 23 },
  { name: "9th Ave N (Republican-Harrison)", sourceElementKey: 76434, sideOfStreet: "E", paidParkingArea: "South Lake Union", realOccupiedCount: 9, realTotalSpaces: 10, appPredictedPct: 16 },
  { name: "8th Ave N (Republican-Harrison)", sourceElementKey: 76202, sideOfStreet: "E", paidParkingArea: "South Lake Union", realOccupiedCount: 13, realTotalSpaces: 17, appPredictedPct: 19 },
  { name: "Republican St (8th-Dexter)", sourceElementKey: 12538, sideOfStreet: "S", paidParkingArea: "South Lake Union", realOccupiedCount: 8, realTotalSpaces: 12, appPredictedPct: 23 },
  { name: "Republican St (8th-9th)", sourceElementKey: 80545, sideOfStreet: "N", paidParkingArea: "South Lake Union", realOccupiedCount: 2, realTotalSpaces: 6, appPredictedPct: 14 },
  { name: "Republican St (Westlake-9thAveN)", sourceElementKey: 80550, sideOfStreet: "S", paidParkingArea: "South Lake Union", realOccupiedCount: 3, realTotalSpaces: 3, appPredictedPct: 6 },
  { name: "Republican St (Westlake-Terry)", sourceElementKey: 12542, sideOfStreet: "S", paidParkingArea: "South Lake Union", realOccupiedCount: 10, realTotalSpaces: 16, appPredictedPct: 25 },
  { name: "Republican St (Terry-Boren)", sourceElementKey: 35198, sideOfStreet: "S", paidParkingArea: "South Lake Union", realOccupiedCount: 8, realTotalSpaces: 11, appPredictedPct: 16 },
  { name: "Mercer St (Terry-Westlake)", sourceElementKey: 11778, sideOfStreet: "S", paidParkingArea: "South Lake Union", realOccupiedCount: 2, realTotalSpaces: 13, appPredictedPct: 19 },
  { name: "Mercer St (Westlake-9th)", sourceElementKey: 79778, sideOfStreet: "S", paidParkingArea: "South Lake Union", realOccupiedCount: 3, realTotalSpaces: 4, appPredictedPct: 21 },
  { name: "Mercer St (8th-9th)", sourceElementKey: 34386, sideOfStreet: "S", paidParkingArea: "South Lake Union", realOccupiedCount: 5, realTotalSpaces: 11, appPredictedPct: 21 },

  // Ballard batch
  { name: "Ballard Ave (20th-Vernon, Sabine side)", sourceElementKey: 76961, sideOfStreet: "SW", paidParkingArea: "Ballard", realOccupiedCount: 6, realTotalSpaces: 7, appPredictedPct: 58 },
  { name: "NW Vernon Place (Ballard-Shilshole)", sourceElementKey: 87285, sideOfStreet: "NW", paidParkingArea: "Ballard", realOccupiedCount: 11, realTotalSpaces: 13, appPredictedPct: 77 },
  { name: "22nd Ave (Shilshole-Ballard Ave)", sourceElementKey: 3338, sideOfStreet: "E", paidParkingArea: "Ballard", realOccupiedCount: 12, realTotalSpaces: 16, appPredictedPct: 58 },
  { name: "Ballard Ave (22nd-NW Market)", sourceElementKey: 31854, sideOfStreet: "NE", paidParkingArea: "Ballard", realOccupiedCount: 25, realTotalSpaces: 38, appPredictedPct: 38 },
  { name: "20th Ave NW (Market-Russell)", sourceElementKey: 48213, sideOfStreet: "W", paidParkingArea: "Ballard", realOccupiedCount: 6, realTotalSpaces: 12, appPredictedPct: 45 },
  { name: "Russell Ave NW (20th-Market)", sourceElementKey: 80657, sideOfStreet: "SW", paidParkingArea: "Ballard", realOccupiedCount: 14, realTotalSpaces: 25, appPredictedPct: 58 },
  { name: "Leary Ave NW (Market-20th)", sourceElementKey: 56653, sideOfStreet: "SW", paidParkingArea: "Ballard", realOccupiedCount: 22, realTotalSpaces: 26, appPredictedPct: 40 },
  { name: "22nd Ave (Market-Ballard Ave)", sourceElementKey: 48449, sideOfStreet: "W", paidParkingArea: "Ballard", realOccupiedCount: 13, realTotalSpaces: 18, appPredictedPct: 70 },
  { name: "Ballard Ave (22nd-Vernon Place)", sourceElementKey: 31850, sideOfStreet: "NE", paidParkingArea: "Ballard", realOccupiedCount: 23, realTotalSpaces: 24, appPredictedPct: 72 },
  { name: "NW Vernon Place (Ballard-Leary)", sourceElementKey: 87282, sideOfStreet: "SE", paidParkingArea: "Ballard", realOccupiedCount: 11, realTotalSpaces: 12, appPredictedPct: 82 },

  // Pike Place batch -- only PP3 has a real fraction and a confirmed
  // blockface match (PP1/PP2 were given with no cross streets and were
  // never mapped to a specific blockface -- see CLAUDE.md). paidParkingArea
  // was originally guessed as "Commercial Core" ("near Pike Place Market")
  // without checking directly -- corrected after syncBlockfaceParkingAreas.ts's
  // real sync run showed this blockface's actual PAIDAREA is "Belltown"
  // (subarea "South"), live-verified against the database directly.
  { name: "1st Ave (Lenora-Blanchard)", sourceElementKey: 1022, sideOfStreet: "NE", paidParkingArea: "Belltown", realOccupiedCount: 100, realTotalSpaces: 100, appPredictedPct: 43 },
] as const;

// Real, independently-reconstructed transaction-coverage results from
// tonight's investigation: paid space-minutes actually covered by real
// Paid Parking Transaction Data records (data.seattle.gov gg89-k5p6),
// divided by that block's real capacity-minutes for the same tested hour
// -- computed entirely independently of occupancy_stats. Keyed by the
// same `name` as FIELD_TEST_POINTS above (Bell St excluded -- confirmed
// zero paid spaces on record for that block).
export interface TransactionCoveragePoint {
  name: string;
  coveragePct: number;
}

export const TRANSACTION_COVERAGE_POINTS: readonly TransactionCoveragePoint[] = [
  { name: "1st Ave (Battery-Wall)", coveragePct: 40.8 },
  { name: "1st Ave (Wall-Vine)", coveragePct: 36.5 },
  { name: "Wall St (1st-Western)", coveragePct: 51.9 },
  { name: "Wall St (2nd-3rd)", coveragePct: 42.1 },
  { name: "2nd Ave (Vine-Cedar)", coveragePct: 7.6 },
  { name: "Vine St (2nd-3rd)", coveragePct: 23.0 },
  { name: "Battery St (2nd-3rd)", coveragePct: 24.3 },
  { name: "1st Ave (Bell-Blanchard)", coveragePct: 15.2 },
  { name: "9th Ave N (Republican-Mercer)", coveragePct: 0.0 },
  { name: "9th Ave N (Republican-Harrison)", coveragePct: 17.6 },
  { name: "8th Ave N (Republican-Harrison)", coveragePct: 8.9 },
  { name: "Republican St (8th-Dexter)", coveragePct: 32.2 },
  { name: "Republican St (8th-9th)", coveragePct: 0.0 },
  { name: "Republican St (Westlake-9thAveN)", coveragePct: 0.0 },
  { name: "Republican St (Westlake-Terry)", coveragePct: 37.2 },
  { name: "Republican St (Terry-Boren)", coveragePct: 8.5 },
  { name: "Mercer St (Terry-Westlake)", coveragePct: 42.5 },
  { name: "Mercer St (Westlake-9th)", coveragePct: 25.0 },
  { name: "Mercer St (8th-9th)", coveragePct: 9.1 },
  { name: "Ballard Ave (20th-Vernon, Sabine side)", coveragePct: 20.2 },
  { name: "NW Vernon Place (Ballard-Shilshole)", coveragePct: 46.2 },
  { name: "22nd Ave (Shilshole-Ballard Ave)", coveragePct: 38.8 },
  { name: "Ballard Ave (22nd-NW Market)", coveragePct: 36.3 },
  { name: "20th Ave NW (Market-Russell)", coveragePct: 51.4 },
  { name: "Russell Ave NW (20th-Market)", coveragePct: 46.4 },
  { name: "Leary Ave NW (Market-20th)", coveragePct: 44.1 },
  { name: "22nd Ave (Market-Ballard Ave)", coveragePct: 30.3 },
  { name: "Ballard Ave (22nd-Vernon Place)", coveragePct: 46.1 },
  { name: "NW Vernon Place (Ballard-Leary)", coveragePct: 71.9 },
] as const;
