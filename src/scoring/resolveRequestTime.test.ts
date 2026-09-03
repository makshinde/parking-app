import { describe, expect, it } from "vitest";
import { resolveRequestTime, type PredictionTimeRequest } from "./resolveRequestTime";
import { MAX_DAYS_IN_FUTURE } from "./confidenceScore";

// All dates below are independently verified real calendar facts (checked
// against the system `date` command, not assumed): 2026-06-15/16/20 fall on
// Monday/Tuesday/Saturday respectively, and 2026-01-15 falls on a Thursday.
// June sits solidly within Pacific Daylight Time (UTC-7); January sits
// solidly within Pacific Standard Time (UTC-8) -- neither date is near a
// DST transition, so the offset for each is unambiguous.

describe("resolveRequestTime", () => {
  describe("quick options (no day rollover)", () => {
    // now = 2026-06-15T14:00:00 Pacific (Monday, PDT/UTC-7) = 2026-06-15T21:00:00Z
    const now = new Date("2026-06-15T21:00:00.000Z");

    it("right_now resolves to 1 minute from now, same day/hour", () => {
      const request: PredictionTimeRequest = { type: "quick", option: "right_now" };
      const result = resolveRequestTime(request, now);
      expect(result.isoDay).toBe(1); // Monday
      expect(result.hour).toBe(14);
      expect(result.daysInFuture).toBeCloseTo(1 / 1440, 10);
    });

    it("in_10_minutes resolves 10 minutes ahead, same day/hour", () => {
      const request: PredictionTimeRequest = { type: "quick", option: "in_10_minutes" };
      const result = resolveRequestTime(request, now);
      expect(result.isoDay).toBe(1);
      expect(result.hour).toBe(14);
      expect(result.daysInFuture).toBeCloseTo(10 / 1440, 10);
    });

    it("in_30_minutes resolves 30 minutes ahead, same day/hour", () => {
      const request: PredictionTimeRequest = { type: "quick", option: "in_30_minutes" };
      const result = resolveRequestTime(request, now);
      expect(result.isoDay).toBe(1);
      expect(result.hour).toBe(14);
      expect(result.daysInFuture).toBeCloseTo(30 / 1440, 10);
    });

    it("in_1_hour resolves 1 hour ahead, rolling the hour bucket forward but not the day", () => {
      const request: PredictionTimeRequest = { type: "quick", option: "in_1_hour" };
      const result = resolveRequestTime(request, now);
      expect(result.isoDay).toBe(1);
      expect(result.hour).toBe(15);
      expect(result.daysInFuture).toBeCloseTo(60 / 1440, 10);
    });
  });

  describe("midnight rollover", () => {
    it("right_now made at 23:59:00 Pacific rolls both hour and isoDay forward together", () => {
      // now = 2026-06-15T23:59:00 Pacific (Monday, PDT) = 2026-06-16T06:59:00Z
      // +1 minute -> 2026-06-16T00:00:00 Pacific (Tuesday)
      const now = new Date("2026-06-16T06:59:00.000Z");
      const request: PredictionTimeRequest = { type: "quick", option: "right_now" };
      const result = resolveRequestTime(request, now);
      expect(result.hour).toBe(0);
      expect(result.isoDay).toBe(2); // Tuesday -- not still Monday (1)
      expect(result.daysInFuture).toBeCloseTo(1 / 1440, 10);
    });

    it("in_1_hour made at 23:30 Pacific rolls both hour and isoDay forward together", () => {
      // now = 2026-06-15T23:30:00 Pacific (Monday, PDT) = 2026-06-16T06:30:00Z
      // +1 hour -> 2026-06-16T00:30:00 Pacific (Tuesday)
      const now = new Date("2026-06-16T06:30:00.000Z");
      const request: PredictionTimeRequest = { type: "quick", option: "in_1_hour" };
      const result = resolveRequestTime(request, now);
      expect(result.hour).toBe(0);
      expect(result.isoDay).toBe(2); // Tuesday -- not still Monday (1)
      expect(result.daysInFuture).toBeCloseTo(60 / 1440, 10);
    });
  });

  describe("specific future date/time", () => {
    it("resolves a multi-day-ahead specific date correctly", () => {
      // now = 2026-06-15T10:00:00 Pacific (Monday, PDT) = 2026-06-15T17:00:00Z
      // target = 2026-06-20T16:00:00 Pacific (Saturday, PDT) = 2026-06-20T23:00:00Z
      // 5 days + 6 hours ahead = 5.25 days exactly.
      const now = new Date("2026-06-15T17:00:00.000Z");
      const request: PredictionTimeRequest = { type: "specific", instant: new Date("2026-06-20T23:00:00.000Z") };
      const result = resolveRequestTime(request, now);
      expect(result.isoDay).toBe(6); // Saturday
      expect(result.hour).toBe(16);
      expect(result.daysInFuture).toBeCloseTo(5.25, 10);
    });

    it("resolves correctly in Pacific Standard Time (winter, UTC-8), not just PDT", () => {
      // now = 2026-01-15T10:00:00 Pacific (Thursday, PST/UTC-8) = 2026-01-15T18:00:00Z
      // target = 2026-01-15T12:00:00 Pacific (same day, PST) = 2026-01-15T20:00:00Z
      const now = new Date("2026-01-15T18:00:00.000Z");
      const request: PredictionTimeRequest = { type: "specific", instant: new Date("2026-01-15T20:00:00.000Z") };
      const result = resolveRequestTime(request, now);
      expect(result.isoDay).toBe(4); // Thursday
      expect(result.hour).toBe(12);
      expect(result.daysInFuture).toBeCloseTo(2 / 24, 10);
    });
  });

  describe("the app's one-week request horizon", () => {
    // now = 2026-06-15T10:00:00 Pacific (Monday, PDT) = 2026-06-15T17:00:00Z
    const now = new Date("2026-06-15T17:00:00.000Z");

    it("allows a request exactly at the MAX_DAYS_IN_FUTURE boundary (7 days)", () => {
      expect(MAX_DAYS_IN_FUTURE).toBe(7);
      const target = new Date(now.getTime() + MAX_DAYS_IN_FUTURE * 24 * 60 * 60 * 1000);
      const request: PredictionTimeRequest = { type: "specific", instant: target };
      const result = resolveRequestTime(request, now);
      expect(result.daysInFuture).toBeCloseTo(7, 10);
      expect(result.isoDay).toBe(1); // still a Monday, 7 days later
      expect(result.hour).toBe(10);
    });

    it("rejects a request more than a week in the future", () => {
      const target = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000);
      const request: PredictionTimeRequest = { type: "specific", instant: target };
      expect(() => resolveRequestTime(request, now)).toThrow(RangeError);
      expect(() => resolveRequestTime(request, now)).toThrow(/exceeding the 7-day limit/);
    });
  });

  describe("invalid input", () => {
    const now = new Date("2026-06-15T17:00:00.000Z");

    it("rejects a specific instant that resolves to the past", () => {
      const target = new Date(now.getTime() - 60 * 60 * 1000);
      const request: PredictionTimeRequest = { type: "specific", instant: target };
      expect(() => resolveRequestTime(request, now)).toThrow(RangeError);
      expect(() => resolveRequestTime(request, now)).toThrow(/days in the past/);
    });

    it("rejects an invalid (NaN) now", () => {
      const request: PredictionTimeRequest = { type: "quick", option: "right_now" };
      expect(() => resolveRequestTime(request, new Date("not-a-date"))).toThrow(RangeError);
    });

    it("rejects an invalid (NaN) specific instant", () => {
      const request: PredictionTimeRequest = { type: "specific", instant: new Date("not-a-date") };
      expect(() => resolveRequestTime(request, now)).toThrow(RangeError);
    });

    it("rejects an unrecognized quick option value arriving from untyped request JSON", () => {
      // Simulates a malformed request body: TypeScript's QuickTimeOption
      // union doesn't protect against this at the actual runtime boundary.
      const request = { type: "quick", option: "next_tuesday" } as unknown as PredictionTimeRequest;
      expect(() => resolveRequestTime(request, now)).toThrow(/unrecognized quick option/);
    });

    it("rejects an unrecognized request type value arriving from untyped request JSON", () => {
      const request = { type: "asap" } as unknown as PredictionTimeRequest;
      expect(() => resolveRequestTime(request, now)).toThrow(/unrecognized request type/);
    });
  });
});
