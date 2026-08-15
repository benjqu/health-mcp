import {
  AuthorizationError,
  type AuthRequest,
  type ClientInfo
} from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { readPublicConfig, type Env } from "./env";

const FITNESS_READ_SCOPE = "fitness:read";
const AUTHORIZE_PATH = "/authorize";
const CALLBACK_PATH = "/callback";
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const STATE_PREFIX = "github-oauth-state:";
const FLOW_TTL_SECONDS = 10 * 60;
const CONSENT_COOKIE = "__Host-fitness-consent";
const STATE_COOKIE = "__Host-fitness-state";

const githubTokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1)
}).passthrough();

const githubUserSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1)
}).passthrough();

export interface GitHubAuthDependencies {
  request?: typeof fetch;
  randomUUID?: () => string;
}

export interface GitHubAuthHandler {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
}

/** Handles the application-owned GitHub login and consent routes. */
export function createGitHubAuthHandler(
  dependencies: GitHubAuthDependencies = {}
): GitHubAuthHandler {
  const request = dependencies.request ?? fetch;
  const randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID());

  return {
    async fetch(incoming, env) {
      const url = new URL(incoming.url);

      if (url.pathname === AUTHORIZE_PATH) {
        return handleAuthorize(incoming, env, randomUUID);
      }

      if (url.pathname === CALLBACK_PATH) {
        return handleCallback(incoming, env, request);
      }

      return new Response("Not Found", { status: 404 });
    }
  };
}

async function handleAuthorize(
  request: Request,
  env: Env,
  randomUUID: () => string
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return methodNotAllowed("GET, POST");
  }

  const oauthRequest = await parseAuthorizationRequest(request, env);
  if (oauthRequest instanceof Response) {
    return oauthRequest;
  }

  if (!hasExactReadScope(oauthRequest.scope)) {
    return new Response("Invalid authorization request", { status: 400 });
  }

  let client: ClientInfo | null;
  try {
    client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  } catch {
    return new Response("Invalid authorization request", { status: 400 });
  }

  if (client === null) {
    return new Response("Invalid authorization request", { status: 400 });
  }

  if (request.method === "GET") {
    const csrfToken = randomUUID();
    return consentPage(request, client, csrfToken);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new Response("Invalid consent response", { status: 400 });
  }

  const csrfToken = form.get("csrf_token");
  if (
    typeof csrfToken !== "string" ||
    csrfToken.length === 0 ||
    csrfToken !== cookieValue(request, CONSENT_COOKIE)
  ) {
    return new Response("Invalid consent response", { status: 400 });
  }

  if (form.get("action") !== "approve") {
    return oauthErrorRedirect(oauthRequest, "access_denied", clearCookie(CONSENT_COOKIE));
  }

  const config = readPublicConfig(env);
  const state = randomUUID();
  await env.OAUTH_KV.put(`${STATE_PREFIX}${state}`, JSON.stringify(oauthRequest), {
    expirationTtl: FLOW_TTL_SECONDS
  });

  const githubUrl = new URL(GITHUB_AUTHORIZE_URL);
  githubUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  githubUrl.searchParams.set("redirect_uri", `${config.MCP_BASE_URL}${CALLBACK_PATH}`);
  githubUrl.searchParams.set("state", state);

  const headers = new Headers({ Location: githubUrl.toString() });
  headers.append("Set-Cookie", secureCookie(STATE_COOKIE, await sha256Hex(state)));
  headers.append("Set-Cookie", clearCookie(CONSENT_COOKIE));
  return new Response(null, { status: 302, headers });
}

async function handleCallback(
  request: Request,
  env: Env,
  githubFetch: typeof fetch
): Promise<Response> {
  if (request.method !== "GET") {
    return methodNotAllowed("GET");
  }

  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const stateCookie = cookieValue(request, STATE_COOKIE);
  if (
    state === null ||
    state.length === 0 ||
    stateCookie === undefined ||
    stateCookie !== await sha256Hex(state)
  ) {
    return new Response("Invalid GitHub callback", { status: 400 });
  }

  const stateKey = `${STATE_PREFIX}${state}`;
  const serializedRequest = await env.OAUTH_KV.get(stateKey);
  await env.OAUTH_KV.delete(stateKey);
  if (serializedRequest === null) {
    return responseWithCookie(
      new Response("Invalid GitHub callback", { status: 400 }),
      clearCookie(STATE_COOKIE)
    );
  }

  const oauthRequest = storedAuthRequest(serializedRequest);
  if (oauthRequest === undefined || !hasExactReadScope(oauthRequest.scope)) {
    return responseWithCookie(
      new Response("Invalid GitHub callback", { status: 400 }),
      clearCookie(STATE_COOKIE)
    );
  }

  if (url.searchParams.get("error") === "access_denied") {
    return oauthErrorRedirect(oauthRequest, "access_denied", clearCookie(STATE_COOKIE));
  }

  const code = url.searchParams.get("code");
  if (code === null || code.length === 0) {
    return responseWithCookie(
      new Response("Invalid GitHub callback", { status: 400 }),
      clearCookie(STATE_COOKIE)
    );
  }

  const config = readPublicConfig(env);
  let githubUser: z.infer<typeof githubUserSchema>;
  try {
    const accessToken = await exchangeGitHubCode(
      githubFetch,
      env,
      code,
      `${config.MCP_BASE_URL}${CALLBACK_PATH}`
    );
    githubUser = await getGitHubUser(githubFetch, accessToken);
  } catch {
    return responseWithCookie(
      new Response("GitHub authentication failed", { status: 502 }),
      clearCookie(STATE_COOKIE)
    );
  }

  if (normalizeLogin(githubUser.login) !== normalizeLogin(config.ALLOWED_GITHUB_LOGIN)) {
    return oauthErrorRedirect(oauthRequest, "access_denied", clearCookie(STATE_COOKIE));
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: String(githubUser.id),
    metadata: undefined,
    scope: [FITNESS_READ_SCOPE],
    props: {
      githubUserId: githubUser.id,
      githubLogin: githubUser.login
    }
  });

  return redirectResponse(redirectTo, clearCookie(STATE_COOKIE));
}

async function parseAuthorizationRequest(request: Request, env: Env): Promise<AuthRequest | Response> {
  try {
    return await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectUri !== undefined) {
      const redirect = new URL(error.redirectUri);
      redirect.searchParams.set("error", error.code);
      redirect.searchParams.set("error_description", error.description);
      if (error.state !== undefined) {
        redirect.searchParams.set("state", error.state);
      }
      if (error.issuer !== undefined) {
        redirect.searchParams.set("iss", error.issuer);
      }
      return redirectResponse(redirect.toString());
    }

    return new Response("Invalid authorization request", { status: 400 });
  }
}

async function exchangeGitHubCode(
  request: typeof fetch,
  env: Env,
  code: string,
  redirectUri: string
): Promise<string> {
  const response = await request(new Request(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri
    })
  }));

  if (!response.ok) {
    throw new Error("GitHub token exchange failed");
  }

  return githubTokenSchema.parse(await response.json()).access_token;
}

async function getGitHubUser(request: typeof fetch, accessToken: string) {
  const response = await request(new Request(GITHUB_USER_URL, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "fitness-mcp"
    }
  }));

  if (!response.ok) {
    throw new Error("GitHub user lookup failed");
  }

  return githubUserSchema.parse(await response.json());
}

function consentPage(request: Request, client: ClientInfo, csrfToken: string): Response {
  const url = new URL(request.url);
  const clientName = escapeHtml(client.clientName ?? "MCP client");
  const formAction = escapeHtml(`${url.pathname}${url.search}`);
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorize Fitness MCP</title></head>
<body>
  <main>
    <h1>Authorize Fitness MCP</h1>
    <p>${clientName} is requesting read-only access.</p>
    <p>Scope: ${FITNESS_READ_SCOPE}</p>
    <form method="post" action="${formAction}">
      <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
      <button type="submit" name="action" value="approve">Continue with GitHub</button>
      <button type="submit" name="action" value="deny">Deny</button>
    </form>
  </main>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "Set-Cookie": secureCookie(CONSENT_COOKIE, csrfToken),
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY"
    }
  });
}

function hasExactReadScope(scope: string[]): boolean {
  return scope.length === 1 && scope[0] === FITNESS_READ_SCOPE;
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function storedAuthRequest(value: string): AuthRequest | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<AuthRequest>;
    if (
      parsed.responseType !== "code" ||
      typeof parsed.clientId !== "string" ||
      typeof parsed.redirectUri !== "string" ||
      !Array.isArray(parsed.scope) ||
      !parsed.scope.every((scope) => typeof scope === "string") ||
      typeof parsed.state !== "string"
    ) {
      return undefined;
    }
    return parsed as AuthRequest;
  } catch {
    return undefined;
  }
}

function oauthErrorRedirect(
  request: AuthRequest,
  code: "access_denied",
  setCookie?: string
): Response {
  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set("error", code);
  redirect.searchParams.set("state", request.state);
  if (request.issuer !== undefined) {
    redirect.searchParams.set("iss", request.issuer);
  }
  return redirectResponse(redirect.toString(), setCookie);
}

function redirectResponse(location: string, setCookie?: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      ...(setCookie === undefined ? {} : { "Set-Cookie": setCookie })
    }
  });
}

function responseWithCookie(response: Response, setCookie: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Set-Cookie", setCookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function cookieValue(request: Request, name: string): string | undefined {
  for (const entry of (request.headers.get("Cookie") ?? "").split(";")) {
    const [cookieName, ...value] = entry.trim().split("=");
    if (cookieName === name) {
      return value.join("=");
    }
  }
  return undefined;
}

function secureCookie(name: string, value: string): string {
  return `${name}=${value}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${FLOW_TTL_SECONDS}`;
}

function clearCookie(name: string): string {
  return `${name}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`;
}

function methodNotAllowed(allow: string): Response {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: allow }
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
