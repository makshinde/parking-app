import { describe, expect, it } from "vitest";
import type { ArcGisFeature } from "../utils/fetchArcGisFeatures";
import { assembleBlockface } from "./assembleBlockface";
import type { BlockfaceSideResolution } from "./resolveBlockfaceSides";

// Real, verified street segment (1ST AVE between CHERRY ST and COLUMBIA ST,
// COMPKEY 1001) from the Seattle Streets FeatureServer.
function makeStreetsRecord(): ArcGisFeature {
  return {
    attributes: {
      COMPKEY: 1001,
      STNAME_ORD: "1ST AVE",
      XSTRLO: "CHERRY ST",
      XSTRHI: "COLUMBIA ST",
    },
    geometry: {
      paths: [
        [
          [1270150.94814542, 223404.780440807],
          [1269994.83806525, 223668.036505073],
        ],
      ],
    },
  };
}

// Real, verified pay station (18TH AVE, SIDE "W") from the SDOT Pay
// Stations FeatureServer, with its actual 3-tier weekday/Saturday schedule
// and no Sunday charge.
function makeMultiTierPayStationRecord(overrides: Record<string, unknown> = {}): ArcGisFeature {
  return {
    attributes: {
      ELMNTKEY: 70501,
      SEGKEY: 2535,
      SIDE: "W",
      WKD_RATE1: 2.5,
      WKD_START1: 480,
      WKD_END1: 659,
      WKD_RATE2: 1.5,
      WKD_START2: 660,
      WKD_END2: 1019,
      WKD_RATE3: 1,
      WKD_START3: 1020,
      WKD_END3: 1199,
      SAT_RATE1: 2.5,
      SAT_START1: 480,
      SAT_END1: 659,
      SAT_RATE2: 1.5,
      SAT_START2: 660,
      SAT_END2: 1019,
      SAT_RATE3: 1,
      SAT_START3: 1020,
      SAT_END3: 1199,
      SUN_RATE1: null,
      SUN_START1: null,
      SUN_END1: null,
      SUN_RATE2: null,
      SUN_START2: null,
      SUN_END2: null,
      SUN_RATE3: null,
      SUN_START3: null,
      SUN_END3: null,
      ...overrides,
    },
  };
}

function makeSingleTierPayStationRecord(): ArcGisFeature {
  return makeMultiTierPayStationRecord({
    WKD_RATE2: null,
    WKD_START2: null,
    WKD_END2: null,
    WKD_RATE3: null,
    WKD_START3: null,
    WKD_END3: null,
    SAT_RATE1: null,
    SAT_START1: null,
    SAT_END1: null,
    SAT_RATE2: null,
    SAT_START2: null,
    SAT_END2: null,
    SAT_RATE3: null,
    SAT_START3: null,
    SAT_END3: null,
  });
}

function makeCurbSpace(side: "N" | "S" | "E" | "W", spaceType: string): ArcGisFeature {
  return { attributes: { ELMNTKEY: 70501, SIDE: side, SPACETYPE: spaceType } };
}

function resolution(status: BlockfaceSideResolution["status"], side: "N" | "S" | "E" | "W" = "W"): BlockfaceSideResolution {
  return { side, status };
}

// Mirrors blockfaces' hourly_rate_requires_paid CHECK constraint (see
// migrations/004_loosen_hourly_rate_check.sql): is_paid OR hourly_rate_usd
// IS NULL. Only is_paid = false with a non-null rate violates it.
function satisfiesHourlyRateCheckConstraint(isPaid: boolean, hourlyRateUsd: number | null): boolean {
  return isPaid || hourlyRateUsd === null;
}

describe("assembleBlockface", () => {
  it("assembles a fully PAID side with a single weekday tier", () => {
    const result = assembleBlockface(
      [makeCurbSpace("W", "PS")],
      makeStreetsRecord(),
      makeSingleTierPayStationRecord(),
      resolution("PAID"),
    );

    expect(result.blockface).toEqual({
      street_name: "1ST AVE",
      cross_street_from: "CHERRY ST",
      cross_street_to: "COLUMBIA ST",
      side_of_street: "W",
      is_paid: true,
      hourly_rate_usd: 2.5,
      operating_days: [1, 2, 3, 4, 5],
      operating_hours_start: "08:00:00",
      operating_hours_end: "10:59:00",
      raw_line_coordinates: [
        [1270150.94814542, 223404.780440807],
        [1269994.83806525, 223668.036505073],
      ],
    });
    expect(result.rateTiers).toEqual([
      { day_type: "WKD", tier_number: 1, start_time: "08:00:00", end_time: "10:59:00", rate_usd: 2.5 },
    ]);
  });

  it("assembles an UNPAID_CONFIRMED side with no rate and no operating days", () => {
    const result = assembleBlockface([makeCurbSpace("W", "RPZ")], makeStreetsRecord(), null, resolution("UNPAID_CONFIRMED"));

    expect(result.blockface.is_paid).toBe(false);
    expect(result.blockface.hourly_rate_usd).toBeNull();
    // UNPAID_CONFIRMED is confirmed evidence there's no rate at all, so
    // operating_days ("days the posted rate applies") is correctly empty --
    // not "all 7 days," which would misrepresent a confirmed absence as
    // "always in effect."
    expect(result.blockface.operating_days).toEqual([]);
    expect(result.blockface.operating_hours_start).toBe("00:00:00");
    expect(result.blockface.operating_hours_end).toBe("23:59:00");
    expect(result.rateTiers).toEqual([]);
  });

  it("assembles a DATA_GAP side using the documented is_paid and operating_days defaults", () => {
    const result = assembleBlockface([makeCurbSpace("W", "PS")], makeStreetsRecord(), null, resolution("DATA_GAP"));

    // Documented judgment call: DATA_GAP defaults to is_paid = true, since
    // curb-spaces evidence suggests a pay station belongs here even though
    // its record is missing -- see the comment in assembleBlockface.ts.
    expect(result.blockface.is_paid).toBe(true);
    expect(result.blockface.hourly_rate_usd).toBeNull();
    // Unlike UNPAID_CONFIRMED, DATA_GAP doesn't know which days the
    // (believed-to-exist) rate applies to, so operating_days stays [1..7] --
    // honest uncertainty ("don't rule out any day"), not a specific claim.
    expect(result.blockface.operating_days).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.rateTiers).toEqual([]);

    // is_paid = true with a null rate used to violate
    // hourly_rate_requires_paid; migrations/004_loosen_hourly_rate_check.sql
    // loosens it specifically so this DATA_GAP row is a valid insert.
    expect(
      satisfiesHourlyRateCheckConstraint(result.blockface.is_paid, result.blockface.hourly_rate_usd),
    ).toBe(true);
  });

  it("handles multiple weekday and Saturday rate tiers, with no Sunday tiers", () => {
    const result = assembleBlockface(
      [makeCurbSpace("W", "PS")],
      makeStreetsRecord(),
      makeMultiTierPayStationRecord(),
      resolution("PAID"),
    );

    expect(result.rateTiers).toHaveLength(6);
    expect(result.rateTiers.filter((tier) => tier.day_type === "WKD")).toHaveLength(3);
    expect(result.rateTiers.filter((tier) => tier.day_type === "SAT")).toHaveLength(3);
    expect(result.rateTiers.filter((tier) => tier.day_type === "SUN")).toHaveLength(0);

    // hourly_rate_usd is only the first weekday tier's rate, not an average
    // or the peak/off-peak rate -- the full schedule is in rateTiers.
    expect(result.blockface.hourly_rate_usd).toBe(2.5);

    // Spans the earliest tier start (WKD/SAT_START1 = 480 = 08:00) to the
    // latest tier end (WKD/SAT_END3 = 1199 = 19:59) across all tiers.
    expect(result.blockface.operating_hours_start).toBe("08:00:00");
    expect(result.blockface.operating_hours_end).toBe("19:59:00");

    // WKD + SAT tiers exist, SUN tiers are all null -- operating_days
    // reflects Mon-Sat (1-6), not all 7 days.
    expect(result.blockface.operating_days).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("accepts an empty curb-spaces group", () => {
    const result = assembleBlockface([], makeStreetsRecord(), null, resolution("UNPAID_CONFIRMED"));
    expect(result.blockface.side_of_street).toBe("W");
  });

  it("throws when classified PAID but no payStationRecord is given", () => {
    expect(() => assembleBlockface([], makeStreetsRecord(), null, resolution("PAID"))).toThrow(/PAID/);
  });

  it("throws when classified UNPAID_CONFIRMED or DATA_GAP but a payStationRecord is given", () => {
    expect(() =>
      assembleBlockface([], makeStreetsRecord(), makeSingleTierPayStationRecord(), resolution("UNPAID_CONFIRMED")),
    ).toThrow(/UNPAID_CONFIRMED/);
  });

  it("throws when a curb-spaces record's SIDE doesn't match the resolution's side", () => {
    expect(() =>
      assembleBlockface([makeCurbSpace("E", "PS")], makeStreetsRecord(), null, resolution("UNPAID_CONFIRMED", "W")),
    ).toThrow(/SIDE/);
  });

  it("throws when the curb-spaces group spans more than one ELMNTKEY", () => {
    const mismatched: ArcGisFeature = { attributes: { ELMNTKEY: 99999, SIDE: "W", SPACETYPE: "PS" } };
    expect(() =>
      assembleBlockface([makeCurbSpace("W", "PS"), mismatched], makeStreetsRecord(), null, resolution("UNPAID_CONFIRMED")),
    ).toThrow(/ELMNTKEY/);
  });

  it("throws when the streets record is missing a required field", () => {
    const brokenStreetsRecord: ArcGisFeature = {
      attributes: { STNAME_ORD: "1ST AVE", XSTRLO: "CHERRY ST" },
      geometry: { paths: [[[1, 2]]] },
    };
    expect(() => assembleBlockface([], brokenStreetsRecord, null, resolution("UNPAID_CONFIRMED"))).toThrow(
      /XSTRHI/,
    );
  });

  it("throws when the streets record has no usable geometry", () => {
    const noGeometry: ArcGisFeature = {
      attributes: { STNAME_ORD: "1ST AVE", XSTRLO: "CHERRY ST", XSTRHI: "COLUMBIA ST" },
    };
    expect(() => assembleBlockface([], noGeometry, null, resolution("UNPAID_CONFIRMED"))).toThrow(/geometry/);
  });
});
