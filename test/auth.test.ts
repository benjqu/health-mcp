import type {
  AuthRequest,
  CompleteAuthorizationOptions,
  OAuthHelpers
} from "@cloudflare/workers-oauth-provider";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { createGitHubAuthHandler, type GitHubAuthHandler } from "../src/github-auth";

const baseUrl = "https://fitness-mcp.example.workers.dev";
const oauthRequest: AuthRequest = {
  responseType: "code",
  clientId: "mcp-client",
  redirectUri: "https://client.example/callback",
  scope: ["fitness:read"],
  state: "mcp-client-state",
  codeChallenge: "challenge",
  codeChallengeMethod: "S256",
  resource: `${baseUrl}/mcp`,
  issuer: baseUrl
};

describe("createGitHubAuthHandler", () => {
  it("renders an escaped consent page for the single read scope", async () => {
    const fixture = authFixture({
      clientName: `<script>alert("unsafe")</script>`
    });
    const handler = createGitHubAuthHandler({ randomUUID: () => "csrf-token" });

    const response = await handler.fetch(authorizeRequest(), fixture.env, executionContext());
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Set-Cookie")).toContain("__Host-fitness-consent=csrf-token");
    expect(html).toContain("fitness:read");
    expect(html).toContain("&lt;script&gt;alert(&quot;unsafe&quot;)&lt;/script&gt;");
    expect(html).not.toContain(`<script>alert("unsafe")</script>`);
  });

  it("uses the canonical callback, normalizes both logins, and grants only fitness:read", async () => {
    const githubAccessToken = "github-access-token-must-not-be-stored";
    const fixture = authFixture({ allowedLogin: "  OCTOCAT  " });
    const githubFetch = vi.fn<typeof fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);

      if (request.url === "https://github.com/login/oauth/access_token") {
        expect(request.method).toBe("POST");
        expect(request.headers.get("Accept")).toBe("application/json");
        const form = await request.clone().formData();
        expect(form.get("redirect_uri")).toBe(`${baseUrl}/callback`);
        return Response.json({
          access_token: githubAccessToken,
          token_type: "bearer",
          scope: ""
        });
      }

      expect(request.url).toBe("https://api.github.com/user");
      expect(request.method).toBe("GET");
      expect(request.headers.get("Authorization")).toBe(`Bearer ${githubAccessToken}`);
      return Response.json({ id: 42, login: "OctoCat", name: "Ignored profile name" });
    });
    const handler = createGitHubAuthHandler({
      request: githubFetch,
      randomUUID: sequence("consent-token", "github-state")
    });

    const response = await completeGitHubFlow(handler, fixture.env);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://client.example/authorized");
    expect(githubFetch).toHaveBeenCalledTimes(2);
    expect(fixture.completed).toEqual({
      request: oauthRequest,
      userId: "42",
      metadata: undefined,
      scope: ["fitness:read"],
      props: { githubUserId: 42, githubLogin: "OctoCat" }
    });

    const serialized = JSON.stringify(fixture.completed);
    expect(serialized).not.toContain(githubAccessToken);
    expect(serialized).not.toContain(fixture.env.GITHUB_CLIENT_SECRET);
    expect(serialized).not.toContain(fixture.env.HEVY_API_KEY);
    expect(serialized).not.toContain(fixture.env.CONCEPT2_TOKEN);
  });

  it("denies a different GitHub login without completing authorization", async () => {
    const fixture = authFixture({ allowedLogin: "octocat" });
    const githubFetch = githubResponses({ id: 43, login: "octocat-other" });
    const handler = createGitHubAuthHandler({
      request: githubFetch,
      randomUUID: sequence("consent-token", "github-state")
    });

    const response = await completeGitHubFlow(handler, fixture.env);
    const redirect = new URL(response.headers.get("Location") ?? "https://missing.example");

    expect(response.status).toBe(302);
    expect(redirect.origin + redirect.pathname).toBe(oauthRequest.redirectUri);
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe(oauthRequest.state);
    expect(fixture.completed).toBeUndefined();
  });

  it("consumes GitHub cancellation state and returns sanitized access_denied to the MCP client", async () => {
    const fixture = authFixture();
    const githubFetch = vi.fn<typeof fetch>();
    const handler = createGitHubAuthHandler({
      request: githubFetch,
      randomUUID: sequence("consent-token", "github-state")
    });
    const started = await startGitHubFlow(handler, fixture.env);
    const callback = new Request(
      `${baseUrl}/callback?error=access_denied&error_description=private-provider-detail&state=${started.state}`,
      { headers: { Cookie: started.stateCookie } }
    );

    const response = await handler.fetch(callback, fixture.env, executionContext());
    const redirect = new URL(response.headers.get("Location") ?? "https://missing.example");

    expect(response.status).toBe(302);
    expect(redirect.origin + redirect.pathname).toBe(oauthRequest.redirectUri);
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("error_description")).toBeNull();
    expect(redirect.searchParams.get("state")).toBe(oauthRequest.state);
    expect(response.headers.get("Set-Cookie")).toContain("__Host-fitness-state=;");
    expect(githubFetch).not.toHaveBeenCalled();
    expect(fixture.completed).toBeUndefined();

    const replay = await handler.fetch(callback.clone(), fixture.env, executionContext());
    expect(replay.status).toBe(400);
    expect(githubFetch).not.toHaveBeenCalled();
  });

  it.each([
    { label: "missing", csrfToken: undefined },
    { label: "mismatched", csrfToken: "wrong-token" }
  ])("rejects a $label consent token before creating GitHub state", async ({ csrfToken }) => {
    const fixture = authFixture();
    const githubFetch = vi.fn<typeof fetch>();
    const handler = createGitHubAuthHandler({ request: githubFetch, randomUUID: () => "consent-token" });
    const authorize = authorizeRequest();
    const consent = await handler.fetch(authorize, fixture.env, executionContext());
    const body = new URLSearchParams({ action: "approve" });
    if (csrfToken !== undefined) {
      body.set("csrf_token", csrfToken);
    }

    const response = await handler.fetch(new Request(authorize.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookiePair(consent)
      },
      body
    }), fixture.env, executionContext());

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid consent response");
    expect(githubFetch).not.toHaveBeenCalled();
  });

  it("rejects a mismatched callback cookie without consuming valid state", async () => {
    const fixture = authFixture();
    const githubFetch = vi.fn(githubResponses({ id: 42, login: "octocat" }));
    const handler = createGitHubAuthHandler({
      request: githubFetch,
      randomUUID: sequence("consent-token", "github-state")
    });
    const started = await startGitHubFlow(handler, fixture.env);

    const rejected = await handler.fetch(new Request(
      `${baseUrl}/callback?code=github-code&state=${started.state}`,
      { headers: { Cookie: "__Host-fitness-state=wrong-state-digest" } }
    ), fixture.env, executionContext());

    expect(rejected.status).toBe(400);
    expect(githubFetch).not.toHaveBeenCalled();

    const accepted = await handler.fetch(new Request(
      `${baseUrl}/callback?code=github-code&state=${started.state}`,
      { headers: { Cookie: started.stateCookie } }
    ), fixture.env, executionContext());
    expect(accepted.status).toBe(302);
    expect(fixture.completed).toBeDefined();
  });

  it("rejects a missing or expired stored callback state before GitHub exchange", async () => {
    const fixture = authFixture();
    const githubFetch = vi.fn<typeof fetch>();
    const handler = createGitHubAuthHandler({
      request: githubFetch,
      randomUUID: sequence("consent-token", "github-state")
    });
    const started = await startGitHubFlow(handler, fixture.env);
    await fixture.env.OAUTH_KV.delete(`github-oauth-state:${started.state}`);

    const response = await handler.fetch(new Request(
      `${baseUrl}/callback?code=github-code&state=${started.state}`,
      { headers: { Cookie: started.stateCookie } }
    ), fixture.env, executionContext());

    expect(response.status).toBe(400);
    expect(response.headers.get("Set-Cookie")).toContain("__Host-fitness-state=;");
    expect(githubFetch).not.toHaveBeenCalled();
    expect(fixture.completed).toBeUndefined();
  });

  it("rejects replay after a successful callback without repeating GitHub exchange", async () => {
    const fixture = authFixture();
    const githubFetch = vi.fn(githubResponses({ id: 42, login: "octocat" }));
    const handler = createGitHubAuthHandler({
      request: githubFetch,
      randomUUID: sequence("consent-token", "github-state")
    });
    const started = await startGitHubFlow(handler, fixture.env);
    const callbackUrl = `${baseUrl}/callback?code=github-code&state=${started.state}`;

    const first = await handler.fetch(new Request(callbackUrl, {
      headers: { Cookie: started.stateCookie }
    }), fixture.env, executionContext());
    const replay = await handler.fetch(new Request(callbackUrl, {
      headers: { Cookie: started.stateCookie }
    }), fixture.env, executionContext());

    expect(first.status).toBe(302);
    expect(replay.status).toBe(400);
    expect(githubFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { label: "missing", scope: [] },
    { label: "additional", scope: ["fitness:read", "fitness:write"] }
  ])("rejects $label scopes before starting GitHub OAuth", async ({ scope }) => {
    const fixture = authFixture({ oauthRequest: { ...oauthRequest, scope } });
    const githubFetch = vi.fn<typeof fetch>();
    const handler = createGitHubAuthHandler({ request: githubFetch });

    const response = await handler.fetch(authorizeRequest(), fixture.env, executionContext());

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid authorization request");
    expect(githubFetch).not.toHaveBeenCalled();
    expect(fixture.completed).toBeUndefined();
  });

  it("sanitizes GitHub token-exchange failures", async () => {
    const leakedBody = "client_secret=github-client-secret&access_token=leaked";
    const fixture = authFixture();
    const githubFetch = vi.fn<typeof fetch>(async () => new Response(leakedBody, { status: 401 }));
    const handler = createGitHubAuthHandler({
      request: githubFetch,
      randomUUID: sequence("consent-token", "github-state")
    });

    const response = await completeGitHubFlow(handler, fixture.env);
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(body).toBe("GitHub authentication failed");
    expect(body).not.toContain(leakedBody);
    expect(body).not.toContain(fixture.env.GITHUB_CLIENT_SECRET);
    expect(fixture.completed).toBeUndefined();
  });
});

function authorizeRequest(): Request {
  return new Request(`${baseUrl}/authorize?client_id=mcp-client&state=mcp-client-state`);
}

async function completeGitHubFlow(
  handler: GitHubAuthHandler,
  env: Env
): Promise<Response> {
  const started = await startGitHubFlow(handler, env);

  return handler.fetch(new Request(`${baseUrl}/callback?code=github-code&state=${started.state}`, {
    headers: { Cookie: started.stateCookie }
  }), env, executionContext());
}

async function startGitHubFlow(
  handler: GitHubAuthHandler,
  env: Env
): Promise<{ state: string; stateCookie: string }> {
  const authorize = authorizeRequest();
  const consent = await handler.fetch(authorize, env, executionContext());
  const consentCookie = cookiePair(consent);
  const csrfToken = fieldValue(await consent.text(), "csrf_token");
  const body = new URLSearchParams({ action: "approve", csrf_token: csrfToken });
  const approve = await handler.fetch(new Request(authorize.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: consentCookie
    },
    body
  }), env, executionContext());

  expect(approve.status).toBe(302);
  const githubAuthorize = new URL(approve.headers.get("Location") ?? "https://missing.example");
  expect(githubAuthorize.origin + githubAuthorize.pathname).toBe("https://github.com/login/oauth/authorize");
  expect(githubAuthorize.searchParams.get("client_id")).toBe(env.GITHUB_CLIENT_ID);
  expect(githubAuthorize.searchParams.get("redirect_uri")).toBe(`${baseUrl}/callback`);
  const state = githubAuthorize.searchParams.get("state");
  expect(state).toBeTruthy();

  return {
    state: state ?? "",
    stateCookie: cookiePair(approve)
  };
}

function cookiePair(response: Response): string {
  const cookie = response.headers.get("Set-Cookie");
  expect(cookie).toBeTruthy();
  return cookie?.split(";", 1)[0] ?? "";
}

function fieldValue(html: string, name: string): string {
  const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`));
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

function sequence(...values: string[]): () => string {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

function githubResponses(user: { id: number; login: string }): typeof fetch {
  let requestIndex = 0;
  return async () => requestIndex++ === 0
    ? Response.json({ access_token: "github-test-token", token_type: "bearer", scope: "" })
    : Response.json(user);
}

function authFixture(overrides: {
  allowedLogin?: string;
  clientName?: string;
  oauthRequest?: AuthRequest;
} = {}): {
  env: Env;
  completed?: CompleteAuthorizationOptions;
} {
  const kv = memoryKv();
  const fixture: {
    env: Env;
    completed?: CompleteAuthorizationOptions;
  } = {} as never;
  const provider = {
    async parseAuthRequest() {
      return overrides.oauthRequest ?? oauthRequest;
    },
    async lookupClient() {
      return {
        clientId: "mcp-client",
        redirectUris: [oauthRequest.redirectUri],
        clientName: overrides.clientName ?? "Fitness MCP client",
        tokenEndpointAuthMethod: "none"
      };
    },
    async completeAuthorization(options: CompleteAuthorizationOptions) {
      fixture.completed = options;
      return { redirectTo: "https://client.example/authorized" };
    }
  } as unknown as OAuthHelpers;

  fixture.env = {
    OAUTH_KV: kv,
    OAUTH_PROVIDER: provider,
    ALLOWED_GITHUB_LOGIN: overrides.allowedLogin ?? "octocat",
    MCP_BASE_URL: baseUrl,
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret",
    HEVY_API_KEY: "hevy-secret",
    CONCEPT2_TOKEN: "concept2-secret"
  };
  return fixture;
}

function memoryKv(): KVNamespace {
  const entries = new Map<string, string>();
  return {
    async get(key: string) {
      return entries.get(key) ?? null;
    },
    async put(key: string, value: string) {
      entries.set(key, value);
    },
    async delete(key: string) {
      entries.delete(key);
    }
  } as unknown as KVNamespace;
}

function executionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {}
  } as unknown as ExecutionContext;
}
