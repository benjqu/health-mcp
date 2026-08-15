import { describe, expect, it } from "vitest";
import { CallerValidationError, ProviderError, toSafeError } from "../src/errors";

describe("toSafeError", () => {
  it("returns only safe fields for provider errors", () => {
    const error = new ProviderError("hevy", "auth", 401, "Bearer secret-value");

    expect(toSafeError(error)).toEqual({ provider: "hevy", category: "auth", retryable: false });
    expect(JSON.stringify(toSafeError(error))).not.toContain("secret-value");
  });

  it.each([
    [400, "schema", false],
    [422, "schema", false],
    [401, "auth", false],
    [403, "forbidden", false],
    [429, "rate_limit", true],
    [500, "unavailable", true],
    [503, "unavailable", true]
  ] as const)("maps status %s to %s", (status, category, retryable) => {
    expect(toSafeError(new ProviderError("concept2", status))).toEqual({
      provider: "concept2",
      category,
      retryable
    });
  });

  it("falls back to unavailable for an unmapped provider status", () => {
    expect(toSafeError(new ProviderError("hevy", 502))).toEqual({
      provider: "hevy",
      category: "unavailable",
      retryable: true
    });
  });

  it("preserves a safe retry time without exposing provider details", () => {
    expect(toSafeError(new ProviderError("hevy", "rate_limit", 429, "upstream body", "2026-08-15T12:05:00Z"))).toEqual({
      provider: "hevy",
      category: "rate_limit",
      retryable: true,
      retryAt: "2026-08-15T12:05:00Z"
    });
  });

  it("sanitizes unknown errors as MCP unavailable errors", () => {
    expect(toSafeError(new Error("secret upstream response"))).toEqual({
      provider: "mcp",
      category: "unavailable",
      retryable: false
    });
  });

  it("classifies schema and caller validation failures without their details", () => {
    expect(toSafeError(new ProviderError("mcp", "schema", 400, "secret schema payload"))).toEqual({
      provider: "mcp",
      category: "schema",
      retryable: false
    });
    expect(toSafeError(new Error("Date range cannot exceed 90 days"))).toEqual({
      provider: "mcp",
      category: "invalid_request",
      retryable: false
    });
    expect(toSafeError(new Error("Invalid Hevy pagination"))).toEqual({
      provider: "mcp",
      category: "invalid_request",
      retryable: false
    });
  });

  it("classifies typed caller validation errors without provider-specific message matching", () => {
    expect(toSafeError(new CallerValidationError("Invalid Concept2 pagination"))).toEqual({
      provider: "mcp",
      category: "invalid_request",
      retryable: false
    });
  });
});
