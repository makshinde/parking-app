import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurbSpaceRecord, PayStationRecord, Side } from "./resolveBlockfaceSides";
import { resolveBlockfaceSides } from "./resolveBlockfaceSides";

describe("resolveBlockfaceSides", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("resolves both sides as PAID when both have pay stations", () => {
    const paidStations: PayStationRecord[] = [{ side: "N" }, { side: "S" }];
    const curbSpaces: CurbSpaceRecord[] = [
      { side: "N", spaceType: "PS" },
      { side: "S", spaceType: "PS" },
    ];

    const result = resolveBlockfaceSides("SEG1", paidStations, curbSpaces);

    expect(result).toEqual([
      { side: "N", status: "PAID" },
      { side: "S", status: "PAID" },
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("resolves the missing side as UNPAID_CONFIRMED when curb-spaces shows no PS rows there", () => {
    const paidStations: PayStationRecord[] = [{ side: "N" }];
    const curbSpaces: CurbSpaceRecord[] = [
      { side: "N", spaceType: "PS" },
      { side: "S", spaceType: "RPZ" },
    ];

    const result = resolveBlockfaceSides("SEG2", paidStations, curbSpaces);

    expect(result).toEqual([
      { side: "N", status: "PAID" },
      { side: "S", status: "UNPAID_CONFIRMED" },
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("resolves the missing side as DATA_GAP and warns when curb-spaces shows PS rows there", () => {
    const paidStations: PayStationRecord[] = [{ side: "N" }];
    const curbSpaces: CurbSpaceRecord[] = [
      { side: "N", spaceType: "PS" },
      { side: "S", spaceType: "PS" },
    ];

    const result = resolveBlockfaceSides("SEG3", paidStations, curbSpaces);

    expect(result).toEqual([
      { side: "N", status: "PAID" },
      { side: "S", status: "DATA_GAP" },
    ]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("SEG3"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("data gap"));
  });

  it("resolves both sides from curb-spaces evidence alone when there are zero pay stations", () => {
    const paidStations: PayStationRecord[] = [];
    const curbSpaces: CurbSpaceRecord[] = [
      { side: "N", spaceType: "PS" },
      { side: "S", spaceType: "RPZ" },
    ];

    const result = resolveBlockfaceSides("SEG4", paidStations, curbSpaces);

    expect(result).toEqual([
      { side: "N", status: "DATA_GAP" },
      { side: "S", status: "UNPAID_CONFIRMED" },
    ]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("returns an empty array when there is no pay-station or curb-space data at all", () => {
    expect(resolveBlockfaceSides("SEG5", [], [])).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("treats a side as PAID even if curb-spaces has no PS rows there, since the pay station is direct evidence", () => {
    const paidStations: PayStationRecord[] = [{ side: "E" }];
    const curbSpaces: CurbSpaceRecord[] = [{ side: "E", spaceType: "RPZ" }];

    const result = resolveBlockfaceSides("SEG6", paidStations, curbSpaces);

    expect(result).toEqual([{ side: "E", status: "PAID" }]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("resolves an intercardinal side (e.g. NE) the same as a cardinal one -- diagonal streets are real, common data, not invalid input", () => {
    const paidStations: PayStationRecord[] = [{ side: "NE" }];
    const curbSpaces: CurbSpaceRecord[] = [{ side: "NE", spaceType: "PS" }];

    const result = resolveBlockfaceSides("SEG10", paidStations, curbSpaces);

    expect(result).toEqual([{ side: "NE", status: "PAID" }]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("throws for an invalid side on a pay-station record", () => {
    const paidStations = [{ side: "X" as unknown as Side }];
    expect(() => resolveBlockfaceSides("SEG7", paidStations, [])).toThrow(RangeError);
  });

  it("throws for an invalid side on a curb-space record", () => {
    const curbSpaces = [{ side: "Q" as unknown as Side, spaceType: "PS" }];
    expect(() => resolveBlockfaceSides("SEG8", [], curbSpaces)).toThrow(RangeError);
  });

  it("throws for a duplicate pay-station record on the same side", () => {
    const paidStations: PayStationRecord[] = [{ side: "N" }, { side: "N" }];
    expect(() => resolveBlockfaceSides("SEG9", paidStations, [])).toThrow(/duplicate/i);
  });
});
