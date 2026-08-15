import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { readPublicConfig, type Env } from "./env";
import { createGitHubAuthHandler } from "./github-auth";
import { createConcept2Client } from "./providers/concept2";
import { createHevyClient } from "./providers/hevy";
import { createFitnessMcpServer } from "./tools";
import { createTrainingService } from "./training";

const FITNESS_READ_SCOPE = "fitness:read";

export interface FitnessWorkerDependencies {
  request?: typeof fetch;
}

type WorkerFetch = (
  request: Request,
  env: Env,
  ctx: ExecutionContext
) => Promise<Response>;

export interface FitnessWorker {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
}

/** Creates the authenticated Worker surface with injectable upstream fetch for tests. */
export function createFitnessWorker(
  dependencies: FitnessWorkerDependencies = {}
): FitnessWorker {
  const request = dependencies.request ?? fetch;
  const apiFetch = createFitnessMcpHandler(request);
  const apiHandler: ExportedHandler<Env> & { fetch: WorkerFetch } = { fetch: apiFetch };
  const defaultHandler = createGitHubAuthHandler({ request });

  return {
    fetch(incoming, env, ctx) {
      const pathname = new URL(incoming.url).pathname;
      if (pathname.startsWith("/mcp") && pathname !== "/mcp") {
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }

      const config = readPublicConfig(env);
      const resource = `${config.MCP_BASE_URL}/mcp`;
      const provider = new OAuthProvider<Env>({
        apiRoute: "/mcp",
        apiHandler,
        defaultHandler,
        authorizeEndpoint: "/authorize",
        tokenEndpoint: "/oauth/token",
        clientRegistrationEndpoint: "/oauth/register",
        scopesSupported: [FITNESS_READ_SCOPE],
        clientIdMetadataDocumentEnabled: true,
        resourceMetadata: {
          resource,
          authorization_servers: [config.MCP_BASE_URL],
          scopes_supported: [FITNESS_READ_SCOPE],
          bearer_methods_supported: ["header"],
          resource_name: "Fitness MCP"
        }
      });

      return provider.fetch(incoming, env, ctx);
    }
  };
}

/** Connects the existing read-only fitness server to the current stateless MCP handler. */
export function createFitnessMcpHandler(request: typeof fetch = fetch): WorkerFetch {
  return async (incoming, env, ctx) => {
    const hevy = createHevyClient(env.HEVY_API_KEY, request);
    const concept2 = createConcept2Client(env.CONCEPT2_TOKEN, request);
    const training = createTrainingService(hevy, concept2);
    const handler = createMcpHandler(
      () => createFitnessMcpServer({ hevy, concept2, training }) as never,
      { route: "/mcp", legacy: "stateless" }
    );

    return handler(incoming, env, ctx);
  };
}

export default createFitnessWorker();
