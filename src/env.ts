import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  ALLOWED_GITHUB_LOGIN: string;
  MCP_BASE_URL: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  HEVY_API_KEY: string;
  CONCEPT2_TOKEN: string;
}

const publicConfigSchema = z.object({
  ALLOWED_GITHUB_LOGIN: z.string().min(1),
  MCP_BASE_URL: z.string().url().refine((value) => {
    let url: URL;

    try {
      url = new URL(value);
    } catch {
      return false;
    }

    return (
      url.protocol === "https:" &&
      url.origin === value &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === ""
    );
  })
});

export type PublicConfig = z.infer<typeof publicConfigSchema>;

export function readPublicConfig(env: Env): PublicConfig {
  const result = publicConfigSchema.safeParse(env);

  if (!result.success) {
    throw new Error("Invalid public configuration");
  }

  return result.data;
}
