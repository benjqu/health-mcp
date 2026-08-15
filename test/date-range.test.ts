import { describe, expect, it } from "vitest";
import { parseDateRange } from "../src/date-range";

describe("parseDateRange", () => {
  it("defaults to the preceding seven UTC calendar days", () => {
    expect(parseDateRange({}, new Date("2026-08-15T12:00:00Z"))).toEqual({
      start: "2026-08-09",
      end: "2026-08-15"
    });
  });

  it("accepts a range of exactly ninety inclusive days", () => {
    expect(parseDateRange({ start: "2026-05-18", end: "2026-08-15" })).toEqual({
      start: "2026-05-18",
      end: "2026-08-15"
    });
  });

  it("rejects a range longer than ninety days", () => {
    expect(() => parseDateRange({ start: "2026-05-16", end: "2026-08-15" })).toThrow(
      "Date range cannot exceed 90 days"
    );
  });

  it("rejects an end before the start", () => {
    expect(() => parseDateRange({ start: "2026-08-15", end: "2026-08-14" })).toThrow(
      "Date range end cannot be before start"
    );
  });

  it.each(["2026-02-30", "2026-8-15", "15-08-2026", "not-a-date"])(
    "rejects invalid ISO date %s",
    (date) => {
      expect(() => parseDateRange({ start: date, end: "2026-08-15" })).toThrow("Invalid ISO date");
    }
  );
});
