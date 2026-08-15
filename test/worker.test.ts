import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker, { createFitnessWorker } from "../src/index";

const baseUrl = "https://fitness-mcp.example.workers.dev";

describe("fitness MCP Worker", () => {
  it("challenges unauthenticated MCP requests with canonical OAuth discovery metadata", async () => {
    const upstreamFetch = vi.fn<typeof fetch>();
    const protectedWorker = createFitnessWorker({ request: upstreamFetch });

    const response = await protectedWorker.fetch(
      new Request(`${baseUrl}/mcp`, { method: "POST" }),
      workerEnv(),
      executionContext()
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(
      `Bearer realm="OAuth", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp", scope="fitness:read"`
    );
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("serves canonical protected-resource and authorization-server metadata", async () => {
    const protectedMetadata = await worker.fetch(
      new Request(`${baseUrl}/.well-known/oauth-protected-resource/mcp`),
      workerEnv(),
      executionContext()
    );
    const authorizationMetadata = await worker.fetch(
      new Request(`${baseUrl}/.well-known/oauth-authorization-server`),
      workerEnv(),
      executionContext()
    );

    expect(protectedMetadata.status).toBe(200);
    expect(await protectedMetadata.json()).toMatchObject({
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl],
      scopes_supported: ["fitness:read"]
    });
    expect(authorizationMetadata.status).toBe(200);
    expect(await authorizationMetadata.json()).toMatchObject({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      scopes_supported: ["fitness:read"],
      client_id_metadata_document_supported: true
    });
  });

  it("returns 404 for non-MCP, non-OAuth paths", async () => {
    const response = await worker.fetch(
      new Request(`${baseUrl}/not-a-route`),
      workerEnv(),
      executionContext()
    );

    expect(response.status).toBe(404);
  });

  it.each(["/mcp-anything", "/mcp/"])("returns 404 for near-prefix path %s", async (path) => {
    const response = await worker.fetch(
      new Request(`${baseUrl}${path}`),
      workerEnv(),
      executionContext()
    );

    expect(response.status).toBe(404);
  });

  it("registers, authorizes, issues a scoped token, and reaches the stateless MCP endpoint", async () => {
    const githubAccessToken = "github-flow-access-token";
    const upstreamFetch = vi.fn<typeof fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url === "https://github.com/login/oauth/access_token") {
        return Response.json({ access_token: githubAccessToken, token_type: "bearer", scope: "" });
      }
      if (request.url === "https://api.github.com/user") {
        expect(request.headers.get("Authorization")).toBe(`Bearer ${githubAccessToken}`);
        return Response.json({ id: 42, login: "OctoCat" });
      }
      throw new Error(`Unexpected upstream request: ${request.url}`);
    });
    const protectedWorker = createFitnessWorker({ request: upstreamFetch });
    const testEnv = workerEnv();
    const clientRedirectUri = "https://client.example/callback";

    const registrationResponse = await protectedWorker.fetch(new Request(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Fitness worker integration test",
        redirect_uris: [clientRedirectUri],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_post"
      })
    }), testEnv, executionContext());
    expect(registrationResponse.status).toBe(201);
    const registration = await registrationResponse.json() as {
      client_id: string;
      client_secret: string;
    };
    expect(registration.client_id).toBeTruthy();
    expect(registration.client_secret).toBeTruthy();

    const authorizeUrl = new URL(`${baseUrl}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", registration.client_id);
    authorizeUrl.searchParams.set("redirect_uri", clientRedirectUri);
    authorizeUrl.searchParams.set("scope", "fitness:read");
    authorizeUrl.searchParams.set("state", "client-state");
    authorizeUrl.searchParams.set("resource", `${baseUrl}/mcp`);
    const start = await protectedWorker.fetch(
      new Request(authorizeUrl),
      testEnv,
      executionContext()
    );
    expect(start.status).toBe(302);
    const githubAuthorize = new URL(start.headers.get("Location") ?? "https://missing.example");
    const githubState = githubAuthorize.searchParams.get("state");
    expect(githubState).toBeTruthy();

    const callback = await protectedWorker.fetch(new Request(
      `${baseUrl}/callback?code=github-code&state=${githubState}`
    ), testEnv, executionContext());
    expect(callback.status).toBe(200);
    const consentToken = fieldValue(await callback.text(), "consent_token");

    const approve = await protectedWorker.fetch(new Request(`${baseUrl}/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action: "approve", consent_token: consentToken })
    }), testEnv, executionContext());
    expect(approve.status).toBe(302);
    const clientCallback = new URL(approve.headers.get("Location") ?? "https://missing.example");
    expect(clientCallback.origin + clientCallback.pathname).toBe(clientRedirectUri);
    expect(clientCallback.searchParams.get("state")).toBe("client-state");
    const authorizationCode = clientCallback.searchParams.get("code");
    expect(authorizationCode).toBeTruthy();

    const tokenResponse = await protectedWorker.fetch(new Request(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authorizationCode ?? "",
        redirect_uri: clientRedirectUri,
        client_id: registration.client_id,
        client_secret: registration.client_secret,
        resource: `${baseUrl}/mcp`
      })
    }), testEnv, executionContext());
    expect(tokenResponse.status).toBe(200);
    const token = await tokenResponse.json() as {
      access_token: string;
      scope: string;
      resource: string;
    };
    expect(token.access_token).toBeTruthy();
    expect(token.scope).toBe("fitness:read");
    expect(token.resource).toBe(`${baseUrl}/mcp`);

    const unwrapped = await testEnv.OAUTH_PROVIDER.unwrapToken<{
      githubUserId: number;
      githubLogin: string;
    }>(token.access_token);
    expect(unwrapped).toMatchObject({
      audience: `${baseUrl}/mcp`,
      scope: ["fitness:read"],
      grant: {
        scope: ["fitness:read"],
        props: { githubUserId: 42, githubLogin: "OctoCat" }
      }
    });

    const response = await protectedWorker.fetch(
      new Request(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token.access_token}`,
          "Content-Type": "application/json",
          Host: "fitness-mcp.example.workers.dev"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "fitness-worker-test", version: "1.0.0" }
          }
        })
      }),
      testEnv,
      executionContext()
    );
    const body = await response.text();

    expect(response.status, body).toBe(200);
    expect(body).toContain('"name":"fitness-mcp"');
    expect(body).toContain('"protocolVersion":"2025-06-18"');
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
  });
});

function workerEnv(): Env {
  return {
    OAUTH_KV: memoryKv(),
    OAUTH_PROVIDER: undefined,
    ALLOWED_GITHUB_LOGIN: "octocat",
    MCP_BASE_URL: baseUrl,
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret",
    HEVY_API_KEY: "hevy-secret",
    CONCEPT2_TOKEN: "concept2-secret"
  } as unknown as Env;
}

function memoryKv(): KVNamespace {
  const entries = new Map<string, string>();
  return {
    async get(key: string, options?: { type?: string }) {
      const value = entries.get(key);
      if (value === undefined) {
        return null;
      }
      return options?.type === "json" ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      entries.set(key, value);
    },
    async delete(key: string) {
      entries.delete(key);
    },
    async list(options?: { prefix?: string; limit?: number }) {
      const prefix = options?.prefix ?? "";
      const names = [...entries.keys()]
        .filter((name) => name.startsWith(prefix))
        .sort()
        .slice(0, options?.limit);
      return {
        keys: names.map((name) => ({ name })),
        list_complete: true,
        cacheStatus: null
      };
    }
  } as unknown as KVNamespace;
}

function fieldValue(html: string, name: string): string {
  const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`));
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

function executionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {}
  } as unknown as ExecutionContext;
}
