import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/errors";
import type { Concept2Client, Concept2Result } from "../src/providers/concept2";
import type { HevyClient, HevyWorkout } from "../src/providers/hevy";
import { createTrainingService } from "../src/training";

const range = { start: "2026-08-10", end: "2026-08-12" };
const retrievedAt = "2026-08-15T12:00:00.000Z";

describe("createTrainingService", () => {
  it("labels every record and retains healthy-provider records with a sanitized outage error", async () => {
    const service = createTrainingService(
      hevyClient([hevyWorkout({ id: "hevy-1" })]),
      concept2Client([], new ProviderError("concept2", "auth", 401, "Bearer private-token")),
      clock
    );

    const summary = await service.getSummary(range);

    expect(summary).toMatchObject({
      range,
      retrievedAt,
      records: [
        {
          source: "hevy",
          sourceId: "hevy-1",
          startTime: "2026-08-11T12:00:00.000Z",
          durationSeconds: 1800,
          activityType: "rower"
        }
      ],
      providerErrors: [{ provider: "concept2", category: "auth", retryable: false }]
    });
    expect(JSON.stringify(summary)).not.toContain("private-token");
  });

  it("combines every page returned by each provider", async () => {
    const hevy = {
      ...hevyClient([]),
      async getWorkouts(_range: typeof range, page = 1) {
        return page === 1
          ? { items: [hevyWorkout({ id: "hevy-page-1", title: "strength" })], nextPage: 2 }
          : { items: [hevyWorkout({ id: "hevy-page-2", title: "strength", startTime: "2026-08-11T13:00:00.000Z", endTime: "2026-08-11T13:30:00.000Z" })] };
      }
    } satisfies HevyClient;
    const concept2 = {
      ...concept2Client([]),
      async getResults(_range: typeof range, page = 1) {
        return page === 1
          ? { items: [concept2Result({ id: 1, dateUtc: "2026-08-11 14:00:00", machineType: "rower" })], nextPage: 2 }
          : { items: [concept2Result({ id: 2, dateUtc: "2026-08-11 15:00:00", machineType: "rower" })] };
      }
    } satisfies Concept2Client;
    const service = createTrainingService(hevy, concept2, clock);

    const summary = await service.getSummary(range);

    expect(summary.records.map((record) => [record.source, record.sourceId])).toEqual(expect.arrayContaining([
      ["hevy", "hevy-page-1"],
      ["hevy", "hevy-page-2"],
      ["concept2", "1"],
      ["concept2", "2"]
    ]));
  });

  it("collapses only records with the same provider and source identifier", async () => {
    const first = hevyWorkout({ id: "same-id", title: "first copy" });
    const repeated = hevyWorkout({ id: "same-id", title: "second copy" });
    const service = createTrainingService(
      hevyClient([first, repeated]),
      concept2Client([concept2Result({ id: 9, machineType: "bike" })]),
      clock
    );

    const summary = await service.getSummary(range);

    expect(summary.records).toHaveLength(2);
    expect(summary.records.map((record) => [record.source, record.sourceId])).toEqual(expect.arrayContaining([
      ["hevy", "same-id"],
      ["concept2", "9"]
    ]));
    expect(summary.records.find((record) => record.source === "hevy")).toMatchObject({
      activityType: "first copy"
    });
    expect(summary.possibleDuplicates).toEqual([]);
  });

  it("keeps strong cross-provider matches and returns their matching evidence", async () => {
    const service = createTrainingService(
      hevyClient([hevyWorkout({ id: "hevy-row", title: "rower" })]),
      concept2Client([
        concept2Result({
          id: 44,
          dateUtc: "2026-08-11 12:01:00",
          machineType: "rower",
          durationTenths: 18_000
        })
      ]),
      clock
    );

    const summary = await service.getSummary(range);

    expect(summary.records).toHaveLength(2);
    expect(summary.possibleDuplicates).toEqual([
      {
        records: [
          expect.objectContaining({ source: "hevy", sourceId: "hevy-row" }),
          expect.objectContaining({ source: "concept2", sourceId: "44" })
        ],
        evidence: {
          startTimeDifferenceSeconds: 60,
          durationSeconds: 1800,
          activityType: "rower"
        }
      }
    ]);
  });

  it("does not flag cross-provider records without all three strong-match conditions", async () => {
    const service = createTrainingService(
      hevyClient([
        hevyWorkout({ id: "outside-time", startTime: "2026-08-11T12:02:01.000Z", endTime: "2026-08-11T12:32:01.000Z" }),
        hevyWorkout({ id: "different-duration", startTime: "2026-08-11T13:00:00.000Z", endTime: "2026-08-11T13:31:00.000Z" }),
        hevyWorkout({ id: "different-activity", startTime: "2026-08-11T14:00:00.000Z", endTime: "2026-08-11T14:30:00.000Z", title: "strength" })
      ]),
      concept2Client([
        concept2Result({ id: 1, dateUtc: "2026-08-11 12:00:00", machineType: "rower", durationTenths: 18_000 }),
        concept2Result({ id: 2, dateUtc: "2026-08-11 13:00:00", machineType: "rower", durationTenths: 18_000 }),
        concept2Result({ id: 3, dateUtc: "2026-08-11 14:00:00", machineType: "rower", durationTenths: 18_000 })
      ]),
      clock
    );

    const summary = await service.getSummary(range);

    expect(summary.records).toHaveLength(6);
    expect(summary.possibleDuplicates).toEqual([]);
  });

  it("reports both provider checks without allowing one ping failure to hide the other", async () => {
    const service = createTrainingService(
      hevyClient([], undefined, new ProviderError("hevy", "rate_limit", 429, "key=private", "2026-08-15T12:05:00.000Z")),
      concept2Client([]),
      clock
    );

    await expect(service.connectionStatus()).resolves.toEqual([
      {
        provider: "hevy",
        connected: false,
        checkedAt: retrievedAt,
        error: {
          provider: "hevy",
          category: "rate_limit",
          retryable: true,
          retryAt: "2026-08-15T12:05:00.000Z"
        }
      },
      { provider: "concept2", connected: true, checkedAt: retrievedAt }
    ]);
  });
});

function clock(): Date {
  return new Date(retrievedAt);
}

function hevyClient(
  items: HevyWorkout[],
  workoutsError?: Error,
  pingError?: Error
): HevyClient {
  return {
    async getRoutines() {
      return { items: [] };
    },
    async getWorkouts() {
      if (workoutsError !== undefined) {
        throw workoutsError;
      }
      return { items };
    },
    async getExerciseHistory() {
      return [];
    },
    async ping() {
      if (pingError !== undefined) {
        throw pingError;
      }
    }
  };
}

function concept2Client(items: Concept2Result[], resultsError?: Error): Concept2Client {
  return {
    async getResults() {
      if (resultsError !== undefined) {
        throw resultsError;
      }
      return { items };
    },
    async ping() {}
  };
}

function hevyWorkout(overrides: Partial<HevyWorkout> = {}): HevyWorkout {
  return {
    id: "hevy-workout",
    title: "rower",
    startTime: "2026-08-11T12:00:00.000Z",
    endTime: "2026-08-11T12:30:00.000Z",
    updatedAt: "2026-08-11T12:30:00.000Z",
    createdAt: "2026-08-11T12:00:00.000Z",
    exercises: [],
    ...overrides
  };
}

function concept2Result(overrides: Partial<Concept2Result> = {}): Concept2Result {
  return {
    id: 1,
    date: "2026-08-11 12:00:00",
    dateUtc: "2026-08-11 12:00:00",
    machineType: "rower",
    distanceMeters: 5_000,
    durationTenths: 18_000,
    formattedTime: "30:00.0",
    ...overrides
  };
}
