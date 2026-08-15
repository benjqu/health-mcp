# Fitness MCP

Private, read-only remote MCP for Hevy and Concept2 training data, protected by
GitHub OAuth. No credentials or health data belong in this repository.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/benjqu/fitness-mcp)

## Deploy

1. Select **Deploy to Cloudflare** above.
2. Keep the Worker name `fitness-mcp` and allow Cloudflare to provision `OAUTH_KV`.
3. Set `ALLOWED_GITHUB_LOGIN` to `benjqu`.
4. After Cloudflare shows the final `workers.dev` hostname, set `MCP_BASE_URL`
   to that exact HTTPS origin without a trailing slash.
5. Follow [`docs/operator-setup.md`](docs/operator-setup.md) to create the GitHub
   OAuth app and enter the GitHub, Hevy, and Concept2 secrets.

The MCP endpoint is `<MCP_BASE_URL>/mcp` and the GitHub OAuth callback is
`<MCP_BASE_URL>/callback`.

The server exposes read-only tools only. Run the production validation checklist
in the operator guide before connecting it to an automation.
