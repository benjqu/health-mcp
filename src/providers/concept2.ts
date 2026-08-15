import { z } from "zod";
import type { DateRange } from "../date-range";
import { CallerValidationError, ProviderError } from "../errors";

const BASE_URL = "https://log.concept2.com";
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 250;
const UTC_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?:Z)?$/;

const heartRateSchema = z.object({
  average: z.number().int().optional(),
  min: z.number().int().optional(),
  max: z.number().int().optional(),
  ending: z.number().int().optional(),
  rest: z.number().int().optional(),
  recovery: z.number().int().optional()
}).passthrough();

const intervalSchema = z.object({
  distance: z.number().int(),
  time: z.number().int(),
  type: z.string().optional(),
  rest_time: z.number().int().optional(),
  rest_distance: z.number().int().optional(),
  stroke_rate: z.number().int().optional(),
  calories_total: z.number().int().optional(),
  wattminutes_total: z.number().int().optional(),
  heart_rate: heartRateSchema.optional(),
  machine: z.union([z.string(), z.number().int()]).optional()
}).passthrough();

const resultSchema = z.object({
  id: z.number().int(),
  date: z.string(),
  date_utc: z.string().nullable().optional(),
  distance: z.number().int(),
  type: z.string(),
  time: z.number().int(),
  time_formatted: z.string(),
  pace: z.union([z.string(), z.number()]).nullable().optional(),
  calories_total: z.number().int().nullable().optional(),
  stroke_rate: z.number().int().nullable().optional(),
  drag_factor: z.number().int().nullable().optional(),
  heart_rate: heartRateSchema.nullable().optional(),
  comments: z.string().nullable().optional(),
  verified: z.boolean().nullable().optional(),
  ranked: z.boolean().nullable().optional(),
  workout_type: z.string().nullable().optional(),
  workout: z.object({
    intervals: z.array(intervalSchema).optional()
  }).passthrough().nullable().optional()
}).passthrough();

const paginationLinksSchema = z.union([
  z.object({ next: z.string().nullable().optional() }).passthrough(),
  z.array(z.unknown())
]);

const resultsPageSchema = z.object({
  data: z.array(resultSchema),
  meta: z.object({
    pagination: z.object({
      links: paginationLinksSchema
    }).passthrough()
  }).passthrough().optional()
}).passthrough();

const userSchema = z.object({
  data: z.object({ id: z.number().int() }).passthrough()
}).passthrough();

type ProviderHeartRate = z.infer<typeof heartRateSchema>;
type ProviderInterval = z.infer<typeof intervalSchema>;
type ProviderResult = z.infer<typeof resultSchema>;
type ResultsPage = z.infer<typeof resultsPageSchema>;

export interface Concept2HeartRate {
  average?: number;
  min?: number;
  max?: number;
  ending?: number;
  rest?: number;
  recovery?: number;
}

export interface Concept2Interval {
  distanceMeters: number;
  durationTenths: number;
  intervalType?: string;
  restDurationTenths?: number;
  restDistanceMeters?: number;
  strokeRate?: number;
  calories?: number;
  wattMinutes?: number;
  heartRate?: Concept2HeartRate;
  machine?: string | number;
}

export interface Concept2Result {
  id: number;
  date: string;
  dateUtc?: string;
  machineType: string;
  distanceMeters: number;
  durationTenths: number;
  formattedTime: string;
  pace?: string | number;
  calories?: number;
  strokeRate?: number;
  dragFactor?: number;
  heartRate?: Concept2HeartRate;
  comments?: string;
  verified?: boolean;
  ranked?: boolean;
  workoutType?: string;
  intervals?: Concept2Interval[];
}

export interface Concept2Client {
  getResults(range: DateRange, page?: number, pageSize?: number): Promise<{ items: Concept2Result[]; nextPage?: number }>;
  ping(): Promise<void>;
}

/** Create a read-only client for the Concept2 Logbook API. */
export function createConcept2Client(token: string, request: typeof fetch = fetch): Concept2Client {
  return {
    async getResults(range, page = DEFAULT_PAGE, pageSize = DEFAULT_PAGE_SIZE) {
      validatePagination(page, pageSize);

      const url = new URL("/api/users/me/results", BASE_URL);
      url.searchParams.set("from", range.start);
      url.searchParams.set("to", range.end);
      url.searchParams.set("page", String(page));
      url.searchParams.set("number", String(pageSize));

      const response = parseProviderPayload(
        await getJson(token, request, url),
        resultsPageSchema
      );
      const items = response.data
        .map(normalizeResult)
        .filter((result) => isInRange(result, range));

      return { items, ...nextPage(response) };
    },

    async ping() {
      const url = new URL("/api/users/me", BASE_URL);
      parseProviderPayload(await getJson(token, request, url), userSchema);
    }
  };
}

async function getJson(token: string, request: typeof fetch, url: URL): Promise<unknown> {
  let response: Response;
  try {
    response = await request(new Request(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      }
    }));
  } catch {
    throw new ProviderError("concept2", "unavailable");
  }

  if (!response.ok) {
    throw new ProviderError("concept2", response.status, undefined, retryAt(response.headers.get("Retry-After")));
  }

  try {
    return await response.json();
  } catch {
    throw new ProviderError("concept2", "schema");
  }
}

function parseProviderPayload<T extends z.ZodType>(payload: unknown, schema: T): z.output<T> {
  try {
    return schema.parse(payload);
  } catch {
    throw new ProviderError("concept2", "schema");
  }
}

function normalizeResult(result: ProviderResult): Concept2Result {
  return normalizeProviderObject(() => ({
    id: result.id,
    date: result.date,
    ...optionalValue("dateUtc", result.date_utc),
    machineType: result.type,
    distanceMeters: result.distance,
    durationTenths: result.time,
    formattedTime: result.time_formatted,
    ...optionalValue("pace", result.pace),
    ...optionalValue("calories", result.calories_total),
    ...optionalValue("strokeRate", result.stroke_rate),
    ...optionalValue("dragFactor", result.drag_factor),
    ...(result.heart_rate === undefined || result.heart_rate === null
      ? {}
      : { heartRate: normalizeHeartRate(result.heart_rate) }),
    ...optionalValue("comments", result.comments),
    ...optionalValue("verified", result.verified),
    ...optionalValue("ranked", result.ranked),
    ...optionalValue("workoutType", result.workout_type),
    ...(result.workout?.intervals === undefined
      ? {}
      : { intervals: result.workout.intervals.map(normalizeInterval) })
  }));
}

function normalizeInterval(interval: ProviderInterval): Concept2Interval {
  return {
    distanceMeters: interval.distance,
    durationTenths: interval.time,
    ...optionalValue("intervalType", interval.type),
    ...optionalValue("restDurationTenths", interval.rest_time),
    ...optionalValue("restDistanceMeters", interval.rest_distance),
    ...optionalValue("strokeRate", interval.stroke_rate),
    ...optionalValue("calories", interval.calories_total),
    ...optionalValue("wattMinutes", interval.wattminutes_total),
    ...(interval.heart_rate === undefined ? {} : { heartRate: normalizeHeartRate(interval.heart_rate) }),
    ...optionalValue("machine", interval.machine)
  };
}

function normalizeHeartRate(heartRate: ProviderHeartRate): Concept2HeartRate {
  return {
    ...optionalValue("average", heartRate.average),
    ...optionalValue("min", heartRate.min),
    ...optionalValue("max", heartRate.max),
    ...optionalValue("ending", heartRate.ending),
    ...optionalValue("rest", heartRate.rest),
    ...optionalValue("recovery", heartRate.recovery)
  };
}

function normalizeProviderObject<T>(normalize: () => T): T {
  try {
    return normalize();
  } catch {
    throw new ProviderError("concept2", "schema");
  }
}

function isInRange(result: Concept2Result, range: DateRange): boolean {
  const date = utcCalendarDate(result.dateUtc);
  if (date === undefined) {
    return false;
  }

  return date >= range.start && date <= range.end;
}

function utcCalendarDate(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const match = value.match(UTC_TIMESTAMP);
  if (match === null) {
    return undefined;
  }

  const date = new Date(`${match[1]}T${match[2]}Z`);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  const calendarDate = date.toISOString().slice(0, 10);
  return calendarDate === match[1] ? calendarDate : undefined;
}

function nextPage(response: ResultsPage): { nextPage?: number } {
  const links = response.meta?.pagination.links;
  if (!links || Array.isArray(links) || links.next === undefined || links.next === null) {
    return {};
  }

  try {
    const page = Number(new URL(links.next, BASE_URL).searchParams.get("page"));
    if (!Number.isInteger(page) || page < 1) {
      throw new Error("Invalid Concept2 next page");
    }
    return { nextPage: page };
  } catch {
    throw new ProviderError("concept2", "schema");
  }
}

function validatePagination(page: number, pageSize: number): void {
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > MAX_PAGE_SIZE
  ) {
    throw new CallerValidationError("Invalid Concept2 pagination");
  }
}

function optionalValue<Key extends string, Value>(
  key: Key,
  value: Value | null | undefined
): { [K in Key]: Value } | Record<string, never> {
  return value === undefined || value === null ? {} : { [key]: value } as { [K in Key]: Value };
}

function retryAt(value: string | null): string | undefined {
  if (value === null) {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return new Date(Date.now() + seconds * 1_000).toISOString();
  }

  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? undefined : timestamp.toISOString();
}
