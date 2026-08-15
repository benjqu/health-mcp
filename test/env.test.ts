import { describe, expect, it } from "vitest";
import { readPublicConfig } from "../src/env";

describe("readPublicConfig", () => {
  const validEnv = {
    ALLOWED_GITHUB_LOGIN: "octocat",
    MCP_BASE_URL: "https://fitness-mcp.example.workers.dev"
  };

  it("rejects an empty GitHub login", () => {
    expect(() => readPublicConfig({ ...validEnv, ALLOWED_GITHUB_LOGIN: "" } as never)).toThrow(
      "Invalid public configuration"
    );
  });

  it("rejects a non-HTTPS MCP base URL", () => {
    expect(() => readPublicConfig({ ...validEnv, MCP_BASE_URL: "http://fitness-mcp.example.workers.dev" } as never)).toThrow(
      "Invalid public configuration"
    );
  });

  it("rejects a malformed MCP base URL", () => {
    expect(() => readPublicConfig({ ...validEnv, MCP_BASE_URL: "x" } as never)).toThrow("Invalid public configuration");
  });

  it.each([
    "https://fitness-mcp.example.workers.dev/mcp",
    "https://fitness-mcp.example.workers.dev?test=true",
    "https://fitness-mcp.example.workers.dev#section",
    "https://user@fitness-mcp.example.workers.dev"
  ])("rejects a non-origin MCP base URL: %s", (MCP_BASE_URL) => {
    expect(() => readPublicConfig({ ...validEnv, MCP_BASE_URL } as never)).toThrow("Invalid public configuration");
  });

  it("accepts an HTTPS Worker origin", () => {
    expect(readPublicConfig(validEnv as never)).toEqual({
      ALLOWED_GITHUB_LOGIN: "octocat",
      MCP_BASE_URL: "https://fitness-mcp.example.workers.dev"
    });
  });
});
