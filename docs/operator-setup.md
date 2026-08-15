# Fitness MCP operator setup

This runbook deploys the private, read-only Fitness MCP Worker. Do not put
provider tokens, OAuth secrets, `.dev.vars`, or terminal captures containing
them in the repository, issue tracker, chat, or logs.

## Fixed routes and deployment model

The Worker is a stateless Streamable HTTP MCP service. It has one KV binding,
`OAUTH_KV`, for OAuth-provider state and registrations; it does not use a
Durable Object or persist provider payloads.

Use the Worker’s canonical `workers.dev` origin as `MCP_BASE_URL`, with no
path, trailing slash, query string, fragment, or credentials:

```text
https://fitness-mcp.<account-subdomain>.workers.dev
```

The MCP endpoint is exactly `MCP_BASE_URL/mcp`. The GitHub OAuth callback is
exactly `MCP_BASE_URL/callback`. Do not register `/mcp`, `/callback/`, a custom
domain, or a preview URL as the GitHub callback unless the Worker configuration
is changed and validated to use that exact canonical origin.

## 1. Prepare Cloudflare configuration

Authenticate the Wrangler CLI to the intended Cloudflare account. Create the
production KV namespace:

```bash
npx wrangler kv namespace create OAUTH_KV
```

Copy the returned namespace ID into `wrangler.jsonc` under the `OAUTH_KV`
binding. Do not change the binding name. `wrangler.jsonc` contains only public
configuration: replace both placeholder values before deployment.

```jsonc
"vars": {
  "ALLOWED_GITHUB_LOGIN": "the-one-approved-github-login",
  "MCP_BASE_URL": "https://fitness-mcp.<account-subdomain>.workers.dev"
}
```

`ALLOWED_GITHUB_LOGIN` is compared case-insensitively after trimming. Keep it
to one GitHub login. `MCP_BASE_URL` must be the canonical Worker **origin**;
it is used to construct OAuth issuer, discovery, resource, `/mcp`, and
`/callback` URLs. It is not a URL to the MCP endpoint itself.

## 2. Create the GitHub OAuth application

In GitHub, open **Settings → Developer settings → OAuth Apps → New OAuth App**
for the owning account or organization. Set:

- Application name: a private operator-recognizable name, such as `Fitness MCP`.
- Homepage URL: the exact `MCP_BASE_URL` origin.
- Authorization callback URL: the exact `MCP_BASE_URL/callback` URL.

Create the application, then copy its client ID and generate a client secret.
Enter both only through the Wrangler secret prompts; do not export them into a
shell variable, `.dev.vars`, or a command line:

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

The application reads the signed-in GitHub account identity and permits only
`ALLOWED_GITHUB_LOGIN`. It grants the MCP client only the Worker’s
`fitness:read` scope.

## 3. Obtain read credentials and enter Worker secrets

For Hevy, use a Hevy account with API access (currently a Hevy Pro feature).
In the Hevy mobile app, open **Profile → Settings → Hevy API** (the label may
be shown as Developer API), generate or copy the personal API key, and enter
it directly at the Wrangler prompt:

```bash
npx wrangler secret put HEVY_API_KEY
```

For Concept2, sign in to the Logbook, open the profile menu, choose
**Edit Profile → Applications → Concept2 Logbook API integration**, and
generate a long-lived authorization token. Request only `user:read` and
`results:read` access where the integration presents scope choices; do not
grant write access. Enter the token directly at the prompt:

```bash
npx wrangler secret put CONCEPT2_TOKEN
```

All required secret-entry commands, collected in deployment order, are:

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put HEVY_API_KEY
npx wrangler secret put CONCEPT2_TOKEN
```

Secrets are opaque Worker bindings. Never attempt to retrieve or print their
values after entry. A `wrangler secret put` prompt keeps the value out of shell
history; do not substitute a secret inline on the command line.

## 4. Deploy and install privately

After the KV ID and public variables are correct and all four secrets have
been entered, deploy the Worker:

```bash
npx wrangler deploy
```

First confirm the unauthenticated response and OAuth metadata at the deployed
origin. Then, in the organization’s ChatGPT Work developer-mode/private-MCP
installation flow, register the exact URL:

```text
MCP_BASE_URL/mcp
```

Complete the MCP authorization flow. The MCP consent page redirects to GitHub;
sign in as the single approved GitHub account. Do not install the server as a
public or organization-wide connector until the validation checklist passes.

## 5. Rotation and emergency revocation

Rotate immediately after suspected disclosure, unexpected provider activity,
or an operator departure. Revoke or regenerate the upstream credential first,
then replace the corresponding Worker secret using the same `wrangler secret
put` command above, deploy, and run the affected harmless read check.

- **GitHub:** regenerate the OAuth app client secret in GitHub, then update
  `GITHUB_CLIENT_SECRET`. If the client ID is replaced, update both GitHub
  bindings. Confirm the registered callback remains `MCP_BASE_URL/callback`.
- **Hevy:** revoke/regenerate the personal API key in **Profile → Settings →
  Hevy API**, update `HEVY_API_KEY`, and test `connection_status` plus one
  routines page.
- **Concept2:** revoke the long-lived token in **Edit Profile → Applications →
  Concept2 Logbook API integration**, create a new read-only token, update
  `CONCEPT2_TOKEN`, and test `connection_status` plus one results page.
- **Access allowlist:** change `ALLOWED_GITHUB_LOGIN` in `wrangler.jsonc` and
  redeploy. This controls future GitHub authorizations only.

If an MCP client token, a GitHub identity, or the OAuth backing store might be
compromised, revoke every existing Worker-issued authorization by creating a
new `OAUTH_KV` namespace, replacing only the `OAUTH_KV` binding ID, and
deploying. This forces all clients to register and authorize again. Keep the
old namespace until the replacement has passed validation, then delete it
through Cloudflare. Do not delete a namespace still bound to the live Worker.

## 6. Rollback

Before each production deployment, record the current known-good deployment
ID and the public configuration revision. If a release fails validation,
inspect deployment history and roll back the Worker code to that ID:

```bash
npx wrangler deployments list
npx wrangler rollback <known-good-deployment-id>
```

The canonical origin must not change during rollback. Cloudflare secrets are
not versioned with a Worker deployment: if the incident involved a secret
rotation, restore the previously stored value with the appropriate `wrangler
secret put` command before (or immediately after) rollback, then deploy and
validate. Never try to recover a secret from Cloudflare, logs, or source.

## 7. Production validation checklist

Run these checks against the deployed canonical origin after every initial
deployment, rollback, credential rotation, or access change. Use only harmless
GET/read MCP calls and a controlled MCP client/inspector. Record pass/fail and
sanitized status, never bearer tokens, authorization codes, API keys, or raw
provider errors.

1. An unauthenticated request to `MCP_BASE_URL/mcp` is rejected with `401` and
   an OAuth challenge; no provider call is made.
2. Both OAuth discovery documents are accessible: `/.well-known/oauth-protected-resource/mcp`
   and `/.well-known/oauth-authorization-server` at `MCP_BASE_URL`.
3. Authorizing with a GitHub account other than `ALLOWED_GITHUB_LOGIN` ends in
   access denied and cannot invoke an MCP tool.
4. Authorizing with the exact approved GitHub login succeeds and issues only
   the `fitness:read` scope for the `MCP_BASE_URL/mcp` resource.
5. The authenticated `connection_status` tool succeeds and exposes no
   credential or raw upstream-error text.
6. `get_hevy_routines` succeeds for one page (for example `page: 1`,
   `pageSize: 1`).
7. `get_hevy_workouts` for a recent bounded range succeeds and returned
   workouts include available exercise and set-level data (sets, reps, weight,
   set type, and RPE only when supplied by Hevy).
8. `get_concept2_results` for a recent bounded range succeeds for at least one
   page, including available interval/performance details.
9. The tool list contains only the six read-only tools: `connection_status`,
   `get_hevy_routines`, `get_hevy_workouts`, `get_hevy_exercise_history`,
   `get_concept2_results`, and `get_training_summary`; no mutation tool
   appears.
10. Scan the MCP client transcript, Worker logs, deployment output, source
    diff, and saved validation record for credentials. Remove any accidental
    capture from the destination, revoke the exposed credential, rotate it,
    and repeat this checklist.

Do not update dependent automations or grant broader access until all ten
checks pass.
