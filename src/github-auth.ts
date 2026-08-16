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
const CONSENT_PATH = "/consent";
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const STATE_PREFIX = "github-oauth-state:";
const FLOW_TTL_SECONDS = 10 * 60;
const CONSENT_TOKEN_VERSION = 1;
const CONSENT_KEY_CONTEXT = "fitness-mcp-consent-v1";

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
        return handleCallback(incoming, env, request, randomUUID);
      }

      if (url.pathname === CONSENT_PATH) {
        return handleConsent(incoming, env);
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
  if (request.method !== "GET") {
    return methodNotAllowed("GET");
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

  const config = readPublicConfig(env);
  const state = randomUUID();
  await env.OAUTH_KV.put(`${STATE_PREFIX}${state}`, JSON.stringify(oauthRequest), {
    expirationTtl: FLOW_TTL_SECONDS
  });

  const githubUrl = new URL(GITHUB_AUTHORIZE_URL);
  githubUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  githubUrl.searchParams.set("redirect_uri", `${config.MCP_BASE_URL}${CALLBACK_PATH}`);
  githubUrl.searchParams.set("state", state);

  return redirectResponse(githubUrl.toString());
}

async function handleCallback(
  request: Request,
  env: Env,
  githubFetch: typeof fetch,
  randomUUID: () => string
): Promise<Response> {
  if (request.method !== "GET") {
    return methodNotAllowed("GET");
  }

  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  if (state === null || state.length === 0) {
    return new Response("Invalid GitHub callback", { status: 400 });
  }

  const stateKey = `${STATE_PREFIX}${state}`;
  const serializedRequest = await env.OAUTH_KV.get(stateKey);
  await env.OAUTH_KV.delete(stateKey);
  if (serializedRequest === null) {
    return new Response("Invalid GitHub callback", { status: 400 });
  }

  const oauthRequest = storedAuthRequest(serializedRequest);
  if (oauthRequest === undefined || !hasExactReadScope(oauthRequest.scope)) {
    return new Response("Invalid GitHub callback", { status: 400 });
  }

  if (url.searchParams.get("error") === "access_denied") {
    return oauthErrorRedirect(oauthRequest, "access_denied");
  }

  const code = url.searchParams.get("code");
  if (code === null || code.length === 0) {
    return new Response("Invalid GitHub callback", { status: 400 });
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
    return new Response("GitHub authentication failed", { status: 502 });
  }

  if (normalizeLogin(githubUser.login) !== normalizeLogin(config.ALLOWED_GITHUB_LOGIN)) {
    return oauthErrorRedirect(oauthRequest, "access_denied");
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

  const consentToken = await createConsentToken({
    oauthRequest,
    githubUser: { id: githubUser.id, login: githubUser.login }
  }, env.GITHUB_CLIENT_SECRET, randomUUID());

  return consentPage(client, consentToken);
}

async function handleConsent(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed("POST");
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new Response("Invalid consent response", { status: 400 });
  }

  const consentToken = form.get("consent_token");
  if (typeof consentToken !== "string" || consentToken.length === 0) {
    return new Response("Invalid consent response", { status: 400 });
  }

  const pending = await verifyConsentToken(consentToken, env.GITHUB_CLIENT_SECRET);
  if (pending === undefined) {
    return new Response("Invalid consent response", { status: 400 });
  }

  if (form.get("action") !== "approve") {
    return oauthErrorRedirect(pending.oauthRequest, "access_denied");
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: pending.oauthRequest,
    userId: String(pending.githubUser.id),
    metadata: undefined,
    scope: [FITNESS_READ_SCOPE],
    props: {
      githubUserId: pending.githubUser.id,
      githubLogin: pending.githubUser.login
    }
  });

  return redirectResponse(redirectTo);
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

function consentPage(client: ClientInfo, consentToken: string): Response {
  const clientName = escapeHtml(client.clientName ?? "MCP client");
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorize Fitness MCP</title></head>
<body>
  <main>
    <h1>Authorize Fitness MCP</h1>
    <p>${clientName} is requesting read-only access.</p>
    <p>Scope: ${FITNESS_READ_SCOPE}</p>
    <form method="post" action="${CONSENT_PATH}">
      <input type="hidden" name="consent_token" value="${escapeHtml(consentToken)}">
      <button type="submit" name="action" value="approve">Allow read-only access</button>
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

function storedConsent(value: string): {
  oauthRequest: AuthRequest;
  githubUser: { id: number; login: string };
} | undefined {
  try {
    const parsed = JSON.parse(value) as {
      oauthRequest?: unknown;
      githubUser?: { id?: unknown; login?: unknown };
    };
    const oauthRequest = storedAuthRequest(JSON.stringify(parsed.oauthRequest));
    if (
      oauthRequest === undefined ||
      !hasExactReadScope(oauthRequest.scope) ||
      typeof parsed.githubUser?.id !== "number" ||
      !Number.isInteger(parsed.githubUser.id) ||
      parsed.githubUser.id <= 0 ||
      typeof parsed.githubUser.login !== "string" ||
      parsed.githubUser.login.length === 0
    ) {
      return undefined;
    }
    return {
      oauthRequest,
      githubUser: { id: parsed.githubUser.id, login: parsed.githubUser.login }
    };
  } catch {
    return undefined;
  }
}

async function createConsentToken(
  pending: { oauthRequest: AuthRequest; githubUser: { id: number; login: string } },
  secret: string,
  nonce: string
): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({
    version: CONSENT_TOKEN_VERSION,
    issuedAt,
    expiresAt: issuedAt + FLOW_TTL_SECONDS,
    nonce,
    ...pending
  })));
  const key = await consentSigningKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload)
  );
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function verifyConsentToken(
  token: string,
  secret: string
): Promise<{ oauthRequest: AuthRequest; githubUser: { id: number; login: string } } | undefined> {
  const parts = token.split(".");
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    return undefined;
  }

  try {
    const key = await consentSigningKey(secret);
    const validSignature = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlDecode(parts[1]),
      new TextEncoder().encode(parts[0])
    );
    if (!validSignature) {
      return undefined;
    }

    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0]))) as {
      version?: unknown;
      issuedAt?: unknown;
      expiresAt?: unknown;
      nonce?: unknown;
    };
    const now = Math.floor(Date.now() / 1000);
    if (
      parsed.version !== CONSENT_TOKEN_VERSION ||
      typeof parsed.issuedAt !== "number" ||
      !Number.isInteger(parsed.issuedAt) ||
      typeof parsed.expiresAt !== "number" ||
      !Number.isInteger(parsed.expiresAt) ||
      parsed.expiresAt <= now ||
      parsed.issuedAt > now + 30 ||
      parsed.expiresAt - parsed.issuedAt !== FLOW_TTL_SECONDS ||
      typeof parsed.nonce !== "string" ||
      parsed.nonce.length === 0
    ) {
      return undefined;
    }

    return storedConsent(JSON.stringify(parsed));
  } catch {
    return undefined;
  }
}

async function consentSigningKey(secret: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${CONSENT_KEY_CONTEXT}\0${secret}`)
  );
  return crypto.subtle.importKey(
    "raw",
    keyMaterial,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function oauthErrorRedirect(
  request: AuthRequest,
  code: "access_denied"
): Response {
  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set("error", code);
  redirect.searchParams.set("state", request.state);
  if (request.issuer !== undefined) {
    redirect.searchParams.set("iss", request.issuer);
  }
  return redirectResponse(redirect.toString());
}

function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location }
  });
}

function methodNotAllowed(allow: string): Response {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: allow }
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
