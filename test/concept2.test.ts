import { describe, expect, it } from "vitest";
import resultsFixture from "./fixtures/concept2-results.json" with { type: "json" };
import userFixture from "./fixtures/concept2-user.json" with { type: "json" };
import { ProviderError } from "../src/errors";
import { createConcept2Client } from "../src/providers/concept2";

const range = { start: "2026-08-10", end: "2026-08-12" };

describe("createConcept2Client", () => {
  it("normalizes RowErg, SkiErg, and BikeErg results without synthesizing optional measurements", async () => {
    const client = createConcept2Client("test-token", fetchFrom([resultsFixture]));

    const result = await client.getResults(range);

    expect(result).toEqual({
      items: [
        {
          id: 101,
          date: "2026-08-11 08:15:30",
          dateUtc: "2026-08-11 12:15:30",
          machineType: "rower",
          distanceMeters: 5000,
          durationTenths: 12345,
          formattedTime: "20:34.5",
          pace: "2:03.4",
          calories: 435,
          strokeRate: 26,
          dragFactor: 123,
          heartRate: { average: 151, min: 122, max: 173, ending: 168, recovery: 112 },
          comments: "Synthetic fixed intervals",
          verified: true,
          ranked: false,
          workoutType: "FixedDistanceInterval",
          intervals: [
            {
              distanceMeters: 2500,
              durationTenths: 6200,
              intervalType: "distance",
              restDurationTenths: 300,
              strokeRate: 27,
              calories: 216,
              heartRate: { average: 149, ending: 166, rest: 119 }
            },
            {
              distanceMeters: 2500,
              durationTenths: 6145,
              intervalType: "distance",
              restDurationTenths: 0,
              strokeRate: 26,
              calories: 219,
              heartRate: { average: 153, ending: 173 }
            }
          ]
        },
        {
          id: 102,
          date: "2026-08-12 09:00:00",
          dateUtc: "2026-08-12 13:00:00",
          machineType: "skierg",
          distanceMeters: 3600,
          durationTenths: 18000,
          formattedTime: "30:00.0",
          comments: "Synthetic variable intervals",
          verified: false,
          ranked: true,
          workoutType: "VariableInterval",
          intervals: [
            {
              distanceMeters: 1200,
              durationTenths: 6000,
              intervalType: "distance",
              restDurationTenths: 600,
              restDistanceMeters: 45
            },
            {
              distanceMeters: 2400,
              durationTenths: 12000,
              intervalType: "time",
              restDurationTenths: 0,
              restDistanceMeters: 0
            }
          ]
        },
        {
          id: 103,
          date: "2026-08-12 17:00:00",
          dateUtc: "2026-08-12 17:00:00",
          machineType: "bike",
          distanceMeters: 10000,
          durationTenths: 18000,
          formattedTime: "30:00.0",
          workoutType: "JustRow"
        }
      ],
      nextPage: 2
    });
    expect("future_provider_field" in result.items[0]).toBe(false);
    expect(result.items[2]).not.toHaveProperty("pace");
    expect(result.items[2]).not.toHaveProperty("intervals");
  });

  it("filters broad result pages to the requested inclusive UTC dates", async () => {
    const outsideRangeResult = {
      ...resultsFixture.data[0],
      id: 104,
      date: "2026-08-09 23:30:00",
      date_utc: "2026-08-09 23:30:00"
    };
    const client = createConcept2Client("test-token", fetchFrom([
      { ...resultsFixture, data: [...resultsFixture.data, outsideRangeResult] }
    ]));

    const result = await client.getResults(range);

    expect(result.items.map((item) => item.id)).toEqual([101, 102, 103]);
  });

  it("filters only records with provider-supplied UTC timestamps instead of inferring UTC from local dates", async () => {
    const localNearMidnightWithoutUtc = {
      ...resultsFixture.data[0],
      id: 105,
      date: "2026-08-10 23:59:00",
      date_utc: null
    };
    const validUtcBoundary = {
      ...resultsFixture.data[0],
      id: 106,
      date: "2026-08-11 01:00:00",
      date_utc: "2026-08-10 23:00:00"
    };
    const invalidUtcTimestamp = {
      ...resultsFixture.data[0],
      id: 107,
      date: "2026-08-10 12:00:00",
      date_utc: "2026-08-10 not-a-time"
    };
    const client = createConcept2Client("test-token", fetchFrom([
      { ...resultsFixture, data: [localNearMidnightWithoutUtc, validUtcBoundary, invalidUtcTimestamp] }
    ]));

    const result = await client.getResults({ start: "2026-08-10", end: "2026-08-10" });

    expect(result.items.map((item) => item.id)).toEqual([106]);
    expect(result.items[0]).toMatchObject({
      date: "2026-08-11 01:00:00",
      dateUtc: "2026-08-10 23:00:00"
    });
  });

  it("sends bearer-authenticated GET requests to the documented endpoints without mutation bodies", async () => {
    const requests: Request[] = [];
    const client = createConcept2Client("test-token", async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      requests.push(request);
      return jsonResponse(new URL(request.url).pathname === "/api/users/me" ? userFixture : resultsFixture);
    });

    await client.getResults(range, 2, 3);
    await client.ping();

    const resultRequest = requests.find((request) => new URL(request.url).pathname === "/api/users/me/results");
    expect(resultRequest).toBeDefined();
    expect(resultRequest?.headers.get("Authorization")).toBe("Bearer test-token");
    expect(resultRequest?.headers.get("Accept")).toBe("application/json");
    expect(resultRequest?.method).toBe("GET");
    expect(resultRequest?.body).toBeNull();
    const resultUrl = new URL(resultRequest?.url ?? "https://log.concept2.com");
    expect(resultUrl.searchParams.get("from")).toBe("2026-08-10");
    expect(resultUrl.searchParams.get("to")).toBe("2026-08-12");
    expect(resultUrl.searchParams.get("page")).toBe("2");
    expect(resultUrl.searchParams.get("number")).toBe("3");
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/users/me/results",
      "/api/users/me"
    ]);
    expect(requests.every((request) => request.method === "GET" && request.body === null)).toBe(true);
  });

  it("rejects non-positive or fractional Concept2 page numbers before issuing a request", async () => {
    let requestCount = 0;
    const client = createConcept2Client("test-token", async () => {
      requestCount += 1;
      return jsonResponse(resultsFixture);
    });

    await expect(client.getResults(range, 0)).rejects.toThrow("Invalid Concept2 pagination");
    await expect(client.getResults(range, 1.5)).rejects.toThrow("Invalid Concept2 pagination");

    expect(requestCount).toBe(0);
  });

  it("rejects result page sizes outside Concept2's one-through-250 range before issuing a request", async () => {
    let requestCount = 0;
    const client = createConcept2Client("test-token", async () => {
      requestCount += 1;
      return jsonResponse(resultsFixture);
    });

    await expect(client.getResults(range, 1, 0)).rejects.toThrow("Invalid Concept2 pagination");
    await expect(client.getResults(range, 1, 251)).rejects.toThrow("Invalid Concept2 pagination");

    expect(requestCount).toBe(0);
  });

  it("maps upstream failures without exposing the response body or bearer token", async () => {
    const client = createConcept2Client("test-token", async () => new Response("Bearer test-token", {
      status: 429,
      headers: { "Retry-After": "Sat, 15 Aug 2026 12:02:00 GMT" }
    }));

    await expect(client.getResults(range)).rejects.toMatchObject({
      name: "ProviderError",
      provider: "concept2",
      category: "rate_limit",
      status: 429,
      retryAt: "2026-08-15T12:02:00.000Z"
    } satisfies Partial<ProviderError>);
    await expect(client.getResults(range)).rejects.not.toThrow("test-token");
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
