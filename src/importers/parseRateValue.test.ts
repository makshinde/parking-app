import { describe, expect, it } from "vitest";
import { parseRateValue } from "./parseRateValue";

describe("parseRateValue", () => {
  it("parses a clean integer string", () => {
    expect(parseRateValue("3")).toEqual({ rate: 3, note: null });
  });

  it("parses a clean decimal string", () => {
    expect(parseRateValue("4.9")).toEqual({ rate: 4.9, note: null });
  });

  it("returns both null for null input", () => {
    expect(parseRateValue(null)).toEqual({ rate: null, note: null });
  });

  it("returns both null for an empty string", () => {
    expect(parseRateValue("")).toEqual({ rate: null, note: null });
  });

  it("returns both null for a whitespace-only string", () => {
    expect(parseRateValue("   ")).toEqual({ rate: null, note: null });
  });

  it("preserves non-numeric text as a note", () => {
    expect(parseRateValue("Permit only")).toEqual({ rate: null, note: "Permit only" });
  });

  it("preserves another plausible non-numeric value as a note", () => {
    expect(parseRateValue("Call for rates")).toEqual({ rate: null, note: "Call for rates" });
  });

  it("treats a negative number as invalid text, not a clamped value", () => {
    // A negative rate has no meaningful "nearest valid value" (an hourly
    // rate is never actually negative), so this is preserved as note text
    // rather than clamped to 0 -- see parseRateValue.ts's comment.
    expect(parseRateValue("-5")).toEqual({ rate: null, note: "-5" });
  });
});
