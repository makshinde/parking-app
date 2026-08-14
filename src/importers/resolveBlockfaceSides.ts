// Resolves the "418 single-sided SEGKEYs" known open question (see
// CLAUDE.md): when a pay-station block segment has no recorded pay station
// on one side, that's ambiguous on its own -- it could genuinely have no
// paid parking there, or it could be a gap in the source data. This
// disambiguates using curb-spaces SPACETYPE='PS' rows for the same segment
// as independent evidence of whether a pay station is expected on that side.
//
// Inputs here are already-normalized domain records, not raw Socrata/ArcGIS
// API responses -- mapping the source datasets' actual field names onto
// `side`/`spaceType` is the import layer's job, not this decision logic's.

export type Side = "N" | "S" | "E" | "W";

const VALID_SIDES: readonly Side[] = ["N", "S", "E", "W"];

export interface PayStationRecord {
  side: Side;
}

export interface CurbSpaceRecord {
  side: Side;
  // Real curb-spaces source values include 'PS' (pay station eligible) among
  // others; only 'PS' is meaningful to this decision.
  spaceType: string;
}

export type SideStatus = "PAID" | "UNPAID_CONFIRMED" | "DATA_GAP";

export interface BlockfaceSideResolution {
  side: Side;
  status: SideStatus;
}

// side is discrete/categorical (a fixed set of compass directions), so an
// unrecognized value throws rather than being coerced -- there's no
// meaningful "nearest valid side."
function assertValidSide(side: string): asserts side is Side {
  if (!VALID_SIDES.includes(side as Side)) {
    throw new RangeError(
      `resolveBlockfaceSides: invalid side "${side}", expected one of ${VALID_SIDES.join(", ")}`,
    );
  }
}

// A segment should have at most one pay-station record per side; more than
// one signals a bug upstream (e.g. a bad join), not real-world ambiguity.
function assertNoDuplicatePayStationSides(paidStations: PayStationRecord[]): void {
  const seen = new Set<Side>();
  for (const record of paidStations) {
    if (seen.has(record.side)) {
      throw new Error(`resolveBlockfaceSides: duplicate pay-station record for side "${record.side}"`);
    }
    seen.add(record.side);
  }
}

export function resolveBlockfaceSides(
  segkey: string,
  paidStations: PayStationRecord[],
  curbSpaces: CurbSpaceRecord[],
): BlockfaceSideResolution[] {
  for (const record of paidStations) {
    assertValidSide(record.side);
  }
  for (const record of curbSpaces) {
    assertValidSide(record.side);
  }
  assertNoDuplicatePayStationSides(paidStations);

  const paidSides = new Set(paidStations.map((record) => record.side));
  const sidesToEvaluate = Array.from(
    new Set<Side>([...paidSides, ...curbSpaces.map((record) => record.side)]),
  ).sort((a, b) => VALID_SIDES.indexOf(a) - VALID_SIDES.indexOf(b));

  return sidesToEvaluate.map((side) => {
    if (paidSides.has(side)) {
      return { side, status: "PAID" as const };
    }

    const hasPayStationEligibleCurbSpace = curbSpaces.some(
      (record) => record.side === side && record.spaceType === "PS",
    );

    if (hasPayStationEligibleCurbSpace) {
      // Not thrown: this is an expected, known category of real-world data
      // (see CLAUDE.md), and the import must keep going. Logging it here
      // gives a real count of how many gaps exist once this runs against
      // live data.
      console.warn(
        `resolveBlockfaceSides: SEGKEY ${segkey} side ${side} has no pay-station record but curb-spaces shows SPACETYPE='PS' rows -- data gap, not a confirmed absence of paid parking`,
      );
      return { side, status: "DATA_GAP" as const };
    }

    return { side, status: "UNPAID_CONFIRMED" as const };
  });
}
