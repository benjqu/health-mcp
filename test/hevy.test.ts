import { describe, expect, it } from "vitest";
import routinesFixture from "./fixtures/hevy-routines.json" with { type: "json" };
import workoutsFixture from "./fixtures/hevy-workouts.json" with { type: "json" };
import { ProviderError } from "../src/errors";
import { createHevyClient } from "../src/providers/hevy";

const range = { start: "2026-08-10", end: "2026-08-12" };

describe("createHevyClient", () => {
  it("normalizes routines, retains source identifiers, and ignores additive provider fields", async () => {
    const client = createHevyClient("test-key", fetchFrom([routinesFixture]));

    const result = await client.getRoutines();

    expect(result).toEqual({
      items: [
        {
          id: "routine-synthetic-push",
          title: "Synthetic Push",
          folderId: 7,
          updatedAt: "2026-08-12T13:30:00.000Z",
          createdAt: "2026-08-01T13:30:00.000Z",
          exercises: [
            {
              id: "routine-exercise-bench",
              index: 0,
              title: "Bench Press (Barbell)",
              restSeconds: 90,
              exerciseTemplateId: "template-bench",
              sets: [
                {
                  id: "routine-set-warmup",
                  index: 0,
                  type: "warmup",
                  weight: { value: 40, unit: "kg" },
                  reps: 10
                },
                {
                  id: "routine-set-regular",
                  index: 1,
                  type: "normal",
                  weight: { value: 60, unit: "kg" },
                  reps: 8,
                  rpe: 8
                }
              ]
            }
          ]
        }
      ],
      nextPage: 2
    });
    expect("future_provider_field" in result.items[0]).toBe(false);
  });

  it("normalizes workouts inside the inclusive UTC range without synthesizing omitted optional fields", async () => {
    const outsideRangeWorkout = {
      ...workoutsFixture.workouts[0],
      id: "workout-outside-range",
      start_time: "2026-08-09T23:59:59Z"
    };
    const client = createHevyClient("test-key", fetchFrom([
      { ...workoutsFixture, workouts: [workoutsFixture.workouts[0], outsideRangeWorkout] }
    ]));

    const result = await client.getWorkouts(range);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: "workout-synthetic-lower",
      routineId: "routine-synthetic-lower",
      startTime: "2026-08-12T18:00:00.000Z",
      endTime: "2026-08-12T19:10:00.000Z",
      exercises: [
        {
          id: "workout-exercise-squat",
          exerciseTemplateId: "template-squat",
          sets: [
            { id: "set-warmup", type: "warmup", weight: { value: 60, unit: "kg" } },
            { id: "set-regular", type: "normal", rpe: 8.5 },
            { id: "set-drop", type: "dropset" },
            { id: "set-failure", type: "failure" }
          ]
        }
      ]
    });
    expect(result.items[0].exercises[0]).not.toHaveProperty("notes");
    expect(result.items[0].exercises[0].sets[0]).not.toHaveProperty("rpe");
    expect("future_provider_field" in result.items[0]).toBe(false);
    expect(result.nextPage).toBe(2);
  });

  it("returns chronological set history only for the exact exercise-template identifier across pages", async () => {
    const firstPage = {
      ...workoutsFixture,
      workouts: [
        {
          ...workoutsFixture.workouts[0],
          id: "workout-later",
          start_time: "2026-08-12T18:00:00Z",
          exercises: [
            workoutsFixture.workouts[0].exercises[0],
            {
              ...workoutsFixture.workouts[0].exercises[0],
              id: "matching-name-wrong-template",
              exercise_template_id: "template-other"
            }
          ]
        }
      ]
    };
    const secondPage = {
      ...workoutsFixture,
      page: 2,
      page_count: 2,
      workouts: [
        {
          ...workoutsFixture.workouts[0],
          id: "workout-earlier",
          start_time: "2026-08-10T18:00:00Z",
          exercises: [
            {
              ...workoutsFixture.workouts[0].exercises[0],
              sets: [workoutsFixture.workouts[0].exercises[0].sets[1]]
            }
          ]
        }
      ]
    };
    const client = createHevyClient("test-key", fetchFrom([firstPage, secondPage]));

    const history = await client.getExerciseHistory("template-squat", range);

    expect(history.map((entry) => [entry.workoutId, entry.set.id])).toEqual([
      ["workout-earlier", "set-regular"],
      ["workout-later", "set-warmup"],
      ["workout-later", "set-regular"],
      ["workout-later", "set-drop"],
      ["workout-later", "set-failure"]
    ]);
    expect(history.every((entry) => entry.exerciseTemplateId === "template-squat")).toBe(true);
  });

  it("sends authenticated GET requests to the documented Hevy endpoints and never sends a mutation method", async () => {
    const requests: Request[] = [];
    const client = createHevyClient("test-key", async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      requests.push(request);
      const url = new URL(request.url);
      const path = url.pathname;
      const requestedPage = Number(url.searchParams.get("page"));
      const body = path === "/v1/routines"
        ? { ...routinesFixture, page: requestedPage, page_count: requestedPage }
        : { ...workoutsFixture, page: requestedPage, page_count: requestedPage };
      return jsonResponse(body);
    });

    await client.getRoutines(2, 3);
    await client.getWorkouts(range, 2, 3);
    await client.getExerciseHistory("template-squat", range);
    await client.ping();

    const workoutRequest = requests.find((request) => new URL(request.url).pathname === "/v1/workouts");
    expect(workoutRequest).toBeDefined();
    expect(workoutRequest?.headers.get("api-key")).toBe("test-key");
    expect(workoutRequest?.method).toBe("GET");
    expect(workoutRequest?.url).toContain("/v1/workouts");
    expect(new URL(workoutRequest?.url ?? "https://api.hevyapp.com").searchParams.get("page")).toBe("2");
    expect(new URL(workoutRequest?.url ?? "https://api.hevyapp.com").searchParams.get("pageSize")).toBe("3");
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    expect(requests.some((request) => ["POST", "PUT", "PATCH", "DELETE"].includes(request.method))).toBe(false);
  });

  it("rejects non-positive or fractional page numbers before issuing a request", async () => {
    let requestCount = 0;
    const client = createHevyClient("test-key", async () => {
      requestCount += 1;
      return jsonResponse(routinesFixture);
    });

    await expect(client.getRoutines(0)).rejects.toThrow("Invalid Hevy pagination");
    await expect(client.getWorkouts(range, 1.5)).rejects.toThrow("Invalid Hevy pagination");

    expect(requestCount).toBe(0);
  });

  it("rejects unsupported Hevy page sizes before issuing a request", async () => {
    let requestCount = 0;
    const client = createHevyClient("test-key", async () => {
      requestCount += 1;
      return jsonResponse(routinesFixture);
    });

    await expect(client.getRoutines(1, 0)).rejects.toThrow("Invalid Hevy pagination");
    await expect(client.getRoutines(1, 11)).rejects.toThrow("Invalid Hevy pagination");

    expect(requestCount).toBe(0);
  });

  it("maps upstream HTTP failures without exposing provider bodies or request headers", async () => {
    const client = createHevyClient("test-key", async () => new Response("api-key: test-key", {
      status: 429,
      headers: { "Retry-After": "Sat, 15 Aug 2026 12:02:00 GMT" }
    }));

    await expect(client.getRoutines()).rejects.toMatchObject({
      name: "ProviderError",
      provider: "hevy",
      category: "rate_limit",
      status: 429,
      retryAt: "2026-08-15T12:02:00.000Z"
    } satisfies Partial<ProviderError>);
    await expect(client.getRoutines()).rejects.not.toThrow("test-key");
  });
});

function fetchFrom(bodies: unknown[]): typeof fetch {
  let index = 0;
  return async () => jsonResponse(bodies[Math.min(index++, bodies.length - 1)]);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" }
  });
}
