import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseDateRange } from "./date-range";
import { toSafeError } from "./errors";
import type { Concept2Client } from "./providers/concept2";
import type { HevyClient } from "./providers/hevy";
import type { TrainingService } from "./training";

const DEFAULT_PAGE = 1;
const DEFAULT_HEVY_PAGE_SIZE = 5;
const DEFAULT_CONCEPT2_PAGE_SIZE = 50;
const MAX_HEVY_PAGE_SIZE = 10;

const dateSchema = z.iso.date();
const pageSchema = z.number().int().min(1);
const pageSizeSchema = z.number().int().min(1).max(100);
const dateRangeSchema = {
  start: dateSchema.optional(),
  end: dateSchema.optional()
};
const paginationSchema = {
  page: pageSchema.optional(),
  pageSize: pageSizeSchema.optional()
};

const readOnlyDescription = [
  "This is a read-only tool.",
  "Source data may omit fields.",
  "Date ranges are bounded to 90 days and default to the most recent seven days when omitted."
].join(" ");

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
} as const;

export interface FitnessMcpDependencies {
  hevy: HevyClient;
  concept2: Concept2Client;
  training: TrainingService;
  parseDateRange?: typeof parseDateRange;
  now?: () => Date;
}

/**
 * Creates the MCP surface for the app's six read-only fitness queries.
 * Provider data is returned inside stable JSON text so callers do not need
 * to infer a presentation format from the source provider.
 */
export function createFitnessMcpServer(deps: FitnessMcpDependencies): McpServer {
  const server = new McpServer({ name: "fitness-mcp", version: "1.0.0" });
  const parseRange = deps.parseDateRange ?? parseDateRange;
  const now = deps.now ?? (() => new Date());

  server.registerTool(
    "connection_status",
    {
      description: `Check Hevy and Concept2 connectivity. ${readOnlyDescription}`,
      annotations: readOnlyAnnotations
    },
    async () => runReadOnly(() => deps.training.connectionStatus().then((providers) => ({ providers })))
  );

  server.registerTool(
    "get_hevy_routines",
    {
      description: `List Hevy workout routines. ${readOnlyDescription}`,
      inputSchema: paginationSchema,
      annotations: readOnlyAnnotations
    },
    async ({ page, pageSize }) => runReadOnly(async () => {
      const resolvedPage = page ?? DEFAULT_PAGE;
      const resolvedPageSize = Math.min(pageSize ?? DEFAULT_HEVY_PAGE_SIZE, MAX_HEVY_PAGE_SIZE);
      const result = await deps.hevy.getRoutines(resolvedPage, resolvedPageSize);

      return {
        provider: "hevy" as const,
        retrievedAt: timestamp(now),
        page: resolvedPage,
        pageSize: resolvedPageSize,
        items: result.items,
        ...(result.nextPage === undefined ? {} : { nextPage: result.nextPage })
      };
    })
  );

  server.registerTool(
    "get_hevy_workouts",
    {
      description: `List Hevy workouts in a bounded date range. ${readOnlyDescription}`,
      inputSchema: { ...dateRangeSchema, ...paginationSchema },
      annotations: readOnlyAnnotations
    },
    async ({ start, end, page, pageSize }) => runReadOnly(async () => {
      const range = parseRange({ start, end });
      const resolvedPage = page ?? DEFAULT_PAGE;
      const resolvedPageSize = Math.min(pageSize ?? DEFAULT_HEVY_PAGE_SIZE, MAX_HEVY_PAGE_SIZE);
      const result = await deps.hevy.getWorkouts(range, resolvedPage, resolvedPageSize);

      return {
        provider: "hevy" as const,
        retrievedAt: timestamp(now),
        range,
        page: resolvedPage,
        pageSize: resolvedPageSize,
        items: result.items,
        ...(result.nextPage === undefined ? {} : { nextPage: result.nextPage })
      };
    })
  );

  server.registerTool(
    "get_hevy_exercise_history",
    {
      description: `List Hevy performance history for one exact exercise-template ID. ${readOnlyDescription}`,
      inputSchema: {
        ...dateRangeSchema,
        exerciseTemplateId: z.string().min(1)
      },
      annotations: readOnlyAnnotations
    },
    async ({ start, end, exerciseTemplateId }) => runReadOnly(async () => {
      const range = parseRange({ start, end });
      const items = await deps.hevy.getExerciseHistory(exerciseTemplateId, range);

      return {
        provider: "hevy" as const,
        retrievedAt: timestamp(now),
        exerciseTemplateId,
        range,
        items
      };
    })
  );

  server.registerTool(
    "get_concept2_results",
    {
      description: `List Concept2 results in a bounded date range. ${readOnlyDescription}`,
      inputSchema: { ...dateRangeSchema, ...paginationSchema },
      annotations: readOnlyAnnotations
    },
    async ({ start, end, page, pageSize }) => runReadOnly(async () => {
      const range = parseRange({ start, end });
      const resolvedPage = page ?? DEFAULT_PAGE;
      const resolvedPageSize = pageSize ?? DEFAULT_CONCEPT2_PAGE_SIZE;
      const result = await deps.concept2.getResults(range, resolvedPage, resolvedPageSize);

      return {
        provider: "concept2" as const,
        retrievedAt: timestamp(now),
        range,
        page: resolvedPage,
        pageSize: resolvedPageSize,
        items: result.items,
        ...(result.nextPage === undefined ? {} : { nextPage: result.nextPage })
      };
    })
  );

  server.registerTool(
    "get_training_summary",
    {
      description: `Combine available Hevy and Concept2 activity into a training summary. ${readOnlyDescription}`,
      inputSchema: dateRangeSchema,
      annotations: readOnlyAnnotations
    },
    async ({ start, end }) => runReadOnly(async () => {
      const range = parseRange({ start, end });
      return deps.training.getSummary(range);
    })
  );

  return server;
}

async function runReadOnly(payload: () => Promise<unknown>): Promise<ReadOnlyToolResult> {
  try {
    return jsonResult(await payload());
  } catch (error) {
    return {
      ...jsonResult({ error: toSafeError(error) }),
      isError: true
    };
  }
}

type ReadOnlyToolResult = {
  content: [{ type: "text"; text: string }];
  isError?: true;
};

function jsonResult(payload: unknown): ReadOnlyToolResult {
  return {
    content: [{ type: "text", text: stableJson(payload) }]
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortJson((value as Record<string, unknown>)[key])])
    );
  }

  return value;
}

function timestamp(now: () => Date): string {
  return now().toISOString();
}
