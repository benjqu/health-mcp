import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { parseDateRange } from "../src/date-range";
import { ProviderError } from "../src/errors";
import type { Concept2Client, Concept2Result } from "../src/providers/concept2";
import type { HevyClient, HevyExercisePerformance, HevyRoutine, HevyWorkout } from "../src/providers/hevy";
import type { ConnectionStatus, TrainingService, TrainingSummary } from "../src/training";
import { createFitnessMcpServer } from "../src/tools";

const now = new Date("2026-08-15T12:00:00.000Z");

describe("createFitnessMcpServer", () => {
  it("exposes exactly the six read-only fitness tools", async () => {
    const client = await connectedClient();

    try {
      const { tools } = await client.listTools();

      expect(tools.map((tool) => tool.name)).toEqual([
        "connection_status",
        "get_hevy_routines",
        "get_hevy_workouts",
        "get_hevy_exercise_history",
        "get_concept2_results",
        "get_training_summary"
      ]);
      expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
      expect(tools.every((tool) =>
        !/(create|update|edit|write|delete)/.test(tool.name)
      )).toBe(true);
      expect(tools.every((tool) =>
        /read-only/i.test(tool.description ?? "") &&
        /may omit fields/i.test(tool.description ?? "") &&
        /date ranges are bounded/i.test(tool.description ?? "")
      )).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("returns provider-attributed stable JSON for default and ninety-day queries", async () => {
    const client = await connectedClient({
      hevy: hevyClient({
        routines: [routine()],
        workouts: [workout()],
        history: [performance()],
        expectedRoutines: { page: 1, pageSize: 5 },
        expectedWorkouts: {
          range: { start: "2026-08-09", end: "2026-08-15" },
          page: 1,
          pageSize: 5
        },
        expectedHistory: {
          exerciseTemplateId: "template-exact",
          range: { start: "2026-08-09", end: "2026-08-15" }
        }
      }),
      concept2: concept2Client([result()], {
        expected: {
          range: { start: "2026-05-18", end: "2026-08-15" },
          page: 2,
          pageSize: 100
        }
      }),
      training: trainingService({
        status: [
          { provider: "hevy", connected: true, checkedAt: now.toISOString() },
          { provider: "concept2", connected: false, checkedAt: now.toISOString() }
        ]
      })
    });

    try {
      const status = await callJson(client, "connection_status");
      const workouts = await callJson(client, "get_hevy_workouts", {});
      const routines = await callJson(client, "get_hevy_routines", {});
      const history = await callJson(client, "get_hevy_exercise_history", {
        exerciseTemplateId: "template-exact"
      });
      const concept2 = await callJson(client, "get_concept2_results", {
        start: "2026-05-18",
        end: "2026-08-15",
        page: 2,
        pageSize: 100
      });
      const summary = await callJson(client, "get_training_summary", {});

      expect(status).toEqual({
        providers: [
          { provider: "hevy", connected: true, checkedAt: now.toISOString() },
          { provider: "concept2", connected: false, checkedAt: now.toISOString() }
        ]
      });
      expect(workouts).toMatchObject({
        provider: "hevy",
        retrievedAt: now.toISOString(),
        range: { start: "2026-08-09", end: "2026-08-15" },
        page: 1,
        pageSize: 5,
        items: [{ id: "workout-1" }]
      });
      expect(routines).toMatchObject({
        provider: "hevy",
        retrievedAt: now.toISOString(),
        page: 1,
        pageSize: 5,
        items: [{ id: "routine-1" }]
      });
      expect(history).toMatchObject({
        provider: "hevy",
        retrievedAt: now.toISOString(),
        exerciseTemplateId: "template-exact",
        range: { start: "2026-08-09", end: "2026-08-15" },
        items: [{ exerciseTemplateId: "template-exact" }]
      });
      expect(concept2).toMatchObject({
        provider: "concept2",
        retrievedAt: now.toISOString(),
        range: { start: "2026-05-18", end: "2026-08-15" },
        page: 2,
        pageSize: 100,
        items: [{ id: 1 }]
      });
      expect(summary).toMatchObject({
        range: { start: "2026-08-09", end: "2026-08-15" },
        retrievedAt: now.toISOString(),
        records: []
      });
    } finally {
      await client.close();
    }
  });

  it("rejects invalid page, page size, range, and exercise-template arguments", async () => {
    const client = await connectedClient();

    try {
      await expectToolError(client, "get_hevy_routines", { page: 0 });
      await expectToolError(client, "get_hevy_routines", { pageSize: 101 });
      await expectToolError(client, "get_hevy_workouts", {
        start: "2026-05-17",
        end: "2026-08-15"
      });
      await expectToolError(client, "get_hevy_exercise_history", { exerciseTemplateId: "" });
    } finally {
      await client.close();
    }
  });

  it("returns credential-free JSON errors from provider failures", async () => {
    const secret = "test-provider-secret";
    const client = await connectedClient({
      hevy: hevyClient({ routinesError: new ProviderError("hevy", "auth", 401, `Bearer ${secret}`) })
    });

    try {
      const response = await client.callTool({ name: "get_hevy_routines", arguments: {} });

      expect(response.isError).toBe(true);
      expect(JSON.parse(text(response))).toEqual({
        error: { provider: "hevy", category: "auth", retryable: false }
      });
      expect(JSON.stringify(response)).not.toContain(secret);
    } finally {
      await client.close();
    }
  });

  it("excludes every configured secret from every tool response", async () => {
    const secrets = {
      status: "test-status-secret",
      routines: "test-routines-secret",
      workouts: "test-workouts-secret",
      history: "test-history-secret",
      concept2: "test-concept2-secret",
      summary: "test-summary-secret"
    };
    const client = await connectedClient({
      hevy: hevyClient({
        routinesError: new ProviderError("hevy", "auth", 401, `Bearer ${secrets.routines}`),
        workoutsError: new ProviderError("hevy", "unavailable", 503, secrets.workouts),
        historyError: new ProviderError("hevy", "schema", 422, secrets.history)
      }),
      concept2: concept2Client([], {
        error: new ProviderError("concept2", "forbidden", 403, secrets.concept2)
      }),
      training: trainingService({
        statusError: new Error(secrets.status),
        summaryError: new Error(secrets.summary)
      })
    });
    const calls = [
      { name: "connection_status" },
      { name: "get_hevy_routines", arguments: {} },
      { name: "get_hevy_workouts", arguments: {} },
      { name: "get_hevy_exercise_history", arguments: { exerciseTemplateId: "template-exact" } },
      { name: "get_concept2_results", arguments: {} },
      { name: "get_training_summary", arguments: {} }
    ];

    try {
      for (const call of calls) {
        const response = await client.callTool(call);

        expect(response.isError).toBe(true);
        expect(() => JSON.parse(text(response))).not.toThrow();

        const serialized = JSON.stringify(response);
        for (const secret of Object.values(secrets)) {
          expect(serialized).not.toContain(secret);
        }
      }
    } finally {
      await client.close();
    }
  });
});

async function connectedClient(overrides: Partial<FitnessDeps> = {}): Promise<Client> {
  const server = createFitnessMcpServer({
    hevy: hevyClient(),
    concept2: concept2Client(),
    training: trainingService(),
    parseDateRange: (input) => parseDateRange(input, now),
    now: () => now,
    ...overrides
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fitness-mcp-test", version: "1.0.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function callJson(client: Client, name: string, args?: Record<string, unknown>): Promise<unknown> {
  const response = await client.callTool({ name, arguments: args });
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  return JSON.parse(text(response));
}

async function expectToolError(client: Client, name: string, args: Record<string, unknown>): Promise<void> {
  const response = await client.callTool({ name, arguments: args });
  expect(response.isError).toBe(true);
}

type ToolCallResponse = Awaited<ReturnType<Client["callTool"]>>;

function text(response: ToolCallResponse): string {
  if (!("content" in response)) {
    throw new Error("Expected a direct tool result");
  }

  const content = (response as { content: unknown[] }).content[0] as { type?: unknown; text?: unknown } | undefined;
  expect(content?.type).toBe("text");
  expect(typeof content?.text).toBe("string");
  return content?.text as string;
}

type FitnessDeps = {
  hevy: HevyClient;
  concept2: Concept2Client;
  training: TrainingService;
  parseDateRange: typeof parseDateRange;
  now: () => Date;
};

function hevyClient(overrides: {
  routines?: HevyRoutine[];
  workouts?: HevyWorkout[];
  history?: HevyExercisePerformance[];
  routinesError?: Error;
  workoutsError?: Error;
  historyError?: Error;
  expectedRoutines?: { page: number; pageSize: number };
  expectedWorkouts?: { range: { start: string; end: string }; page: number; pageSize: number };
  expectedHistory?: { exerciseTemplateId: string; range: { start: string; end: string } };
} = {}): HevyClient {
  return {
    async getRoutines(page = 1, pageSize = 5) {
      if (overrides.routinesError !== undefined) {
        throw overrides.routinesError;
      }

      if (overrides.expectedRoutines !== undefined &&
        (page !== overrides.expectedRoutines.page || pageSize !== overrides.expectedRoutines.pageSize)) {
        throw new Error("Unexpected Hevy routines query");
      }

      return { items: overrides.routines ?? [] };
    },
    async getWorkouts(range, page = 1, pageSize = 5) {
      if (overrides.workoutsError !== undefined) {
        throw overrides.workoutsError;
      }

      if (overrides.expectedWorkouts !== undefined &&
        (JSON.stringify({ range, page, pageSize }) !== JSON.stringify(overrides.expectedWorkouts))) {
        throw new Error("Unexpected Hevy workouts query");
      }

      return { items: overrides.workouts ?? [] };
    },
    async getExerciseHistory(exerciseTemplateId, range) {
      if (overrides.historyError !== undefined) {
        throw overrides.historyError;
      }

      if (overrides.expectedHistory !== undefined &&
        (JSON.stringify({ exerciseTemplateId, range }) !== JSON.stringify(overrides.expectedHistory))) {
        throw new Error("Unexpected Hevy exercise-history query");
      }

      return overrides.history ?? [];
    },
    async ping() {}
  };
}

function concept2Client(
  items: Concept2Result[] = [],
  options: {
    expected?: { range: { start: string; end: string }; page: number; pageSize: number };
    error?: Error;
  } = {}
): Concept2Client {
  return {
    async getResults(range, page = 1, pageSize = 50) {
      if (options.error !== undefined) {
        throw options.error;
      }

      if (options.expected !== undefined &&
        JSON.stringify({ range, page, pageSize }) !== JSON.stringify(options.expected)) {
        throw new Error("Unexpected Concept2 results query");
      }

      return { items };
    },
    async ping() {}
  };
}

function trainingService(
  options: {
    status?: ConnectionStatus[];
    summary?: TrainingSummary;
    statusError?: Error;
    summaryError?: Error;
  } = {}
): TrainingService {
  return {
    async connectionStatus() {
      if (options.statusError !== undefined) {
        throw options.statusError;
      }

      return options.status ?? [];
    },
    async getSummary() {
      if (options.summaryError !== undefined) {
        throw options.summaryError;
      }

      return options.summary ?? {
        range: { start: "2026-08-09", end: "2026-08-15" },
        retrievedAt: now.toISOString(),
        records: [],
        possibleDuplicates: []
      };
    }
  };
}

function routine(): HevyRoutine {
  return {
    id: "routine-1",
    title: "Strength",
    updatedAt: now.toISOString(),
    createdAt: now.toISOString(),
    exercises: []
  };
}

function workout(): HevyWorkout {
  return {
    id: "workout-1",
    title: "Strength",
    startTime: now.toISOString(),
    endTime: now.toISOString(),
    updatedAt: now.toISOString(),
    createdAt: now.toISOString(),
    exercises: []
  };
}

function performance(): HevyExercisePerformance {
  return {
    workoutId: "workout-1",
    workoutStartedAt: now.toISOString(),
    exerciseTemplateId: "template-exact",
    exerciseTitle: "Bench Press",
    set: { index: 0, type: "normal" }
  };
}

function result(): Concept2Result {
  return {
    id: 1,
    date: "2026-08-15 12:00:00",
    dateUtc: "2026-08-15 12:00:00",
    machineType: "rower",
    distanceMeters: 5_000,
    durationTenths: 1_200,
    formattedTime: "2:00.0"
  };
}
