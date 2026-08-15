import { z } from "zod";
import type { DateRange } from "../date-range";
import { ProviderError } from "../errors";

const BASE_URL = "https://api.hevyapp.com";
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 5;
const HISTORY_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 10;

const setTypeSchema = z.enum(["normal", "warmup", "dropset", "failure"]);

const providerSetSchema = z.object({
  id: z.string().optional(),
  index: z.number().int(),
  type: setTypeSchema,
  weight_kg: z.number().nullable().optional(),
  reps: z.number().nullable().optional(),
  rpe: z.number().nullable().optional(),
  distance_meters: z.number().nullable().optional(),
  duration_seconds: z.number().nullable().optional(),
  custom_metric: z.number().nullable().optional(),
  rep_range: z.object({
    start: z.number().nullable().optional(),
    end: z.number().nullable().optional()
  }).passthrough().nullable().optional()
}).passthrough();

const providerExerciseSchema = z.object({
  id: z.string().optional(),
  index: z.number().int(),
  title: z.string(),
  notes: z.string().nullable().optional(),
  rest_seconds: z.union([z.number(), z.string()]).nullable().optional(),
  exercise_template_id: z.string(),
  supersets_id: z.number().nullable().optional(),
  sets: z.array(providerSetSchema)
}).passthrough();

const providerRoutineSchema = z.object({
  id: z.string(),
  title: z.string(),
  folder_id: z.number().nullable().optional(),
  updated_at: z.string(),
  created_at: z.string(),
  exercises: z.array(providerExerciseSchema)
}).passthrough();

const providerWorkoutSchema = z.object({
  id: z.string(),
  title: z.string(),
  routine_id: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  start_time: z.string(),
  end_time: z.string(),
  updated_at: z.string(),
  created_at: z.string(),
  exercises: z.array(providerExerciseSchema)
}).passthrough();

const routinesPageSchema = z.object({
  page: z.number().int().positive(),
  page_count: z.number().int().positive(),
  routines: z.array(providerRoutineSchema)
}).passthrough();

const workoutsPageSchema = z.object({
  page: z.number().int().positive(),
  page_count: z.number().int().positive(),
  workouts: z.array(providerWorkoutSchema)
}).passthrough();

type ProviderSet = z.infer<typeof providerSetSchema>;
type ProviderExercise = z.infer<typeof providerExerciseSchema>;
type ProviderRoutine = z.infer<typeof providerRoutineSchema>;
type ProviderWorkout = z.infer<typeof providerWorkoutSchema>;

export type HevySetType = z.infer<typeof setTypeSchema>;

export interface HevyWeight {
  value: number;
  unit: "kg";
}

export interface HevySet {
  id?: string;
  index: number;
  type: HevySetType;
  weight?: HevyWeight;
  reps?: number;
  rpe?: number;
  distanceMeters?: number;
  durationSeconds?: number;
  customMetric?: number;
  repRange?: {
    start?: number;
    end?: number;
  };
}

export interface HevyExercise {
  id?: string;
  index: number;
  title: string;
  notes?: string;
  restSeconds?: number | string;
  exerciseTemplateId: string;
  supersetId?: number;
  sets: HevySet[];
}

export interface HevyRoutine {
  id: string;
  title: string;
  folderId?: number;
  updatedAt: string;
  createdAt: string;
  exercises: HevyExercise[];
}

export interface HevyWorkout {
  id: string;
  title: string;
  routineId?: string;
  description?: string;
  startTime: string;
  endTime: string;
  updatedAt: string;
  createdAt: string;
  exercises: HevyExercise[];
}

export interface HevyExercisePerformance {
  workoutId: string;
  workoutStartedAt: string;
  exerciseId?: string;
  exerciseTemplateId: string;
  exerciseTitle: string;
  set: HevySet;
}

export interface HevyClient {
  getRoutines(page?: number, pageSize?: number): Promise<{ items: HevyRoutine[]; nextPage?: number }>;
  getWorkouts(range: DateRange, page?: number, pageSize?: number): Promise<{ items: HevyWorkout[]; nextPage?: number }>;
  getExerciseHistory(exerciseTemplateId: string, range: DateRange): Promise<HevyExercisePerformance[]>;
  ping(): Promise<void>;
}

/** Create a read-only client for Hevy's public API. */
export function createHevyClient(apiKey: string, request: typeof fetch = fetch): HevyClient {
  return {
    async getRoutines(page = DEFAULT_PAGE, pageSize = DEFAULT_PAGE_SIZE) {
      const response = await getRoutinesPage(apiKey, request, page, pageSize);
      return {
        items: response.routines.map(normalizeRoutine),
        ...nextPage(response.page, response.page_count)
      };
    },

    async getWorkouts(range, page = DEFAULT_PAGE, pageSize = DEFAULT_PAGE_SIZE) {
      const response = await getWorkoutsPage(apiKey, request, page, pageSize);
      const items = response.workouts
        .map(normalizeWorkout)
        .filter((workout) => isInRange(workout.startTime, range));
      return { items, ...nextPage(response.page, response.page_count) };
    },

    async getExerciseHistory(exerciseTemplateId, range) {
      const workouts: HevyWorkout[] = [];
      let page: number | undefined = DEFAULT_PAGE;

      while (page !== undefined) {
        const result = await this.getWorkouts(range, page, HISTORY_PAGE_SIZE);
        workouts.push(...result.items);
        page = result.nextPage;
      }

      return workouts
        .flatMap((workout) => workout.exercises
          .filter((exercise) => exercise.exerciseTemplateId === exerciseTemplateId)
          .flatMap((exercise) => exercise.sets.map((set) => ({
            workoutId: workout.id,
            workoutStartedAt: workout.startTime,
            ...(exercise.id === undefined ? {} : { exerciseId: exercise.id }),
            exerciseTemplateId: exercise.exerciseTemplateId,
            exerciseTitle: exercise.title,
            set
          }))))
        .sort((left, right) =>
          left.workoutStartedAt.localeCompare(right.workoutStartedAt) || left.set.index - right.set.index);
    },

    async ping() {
      await this.getRoutines(DEFAULT_PAGE, 1);
    }
  };
}

async function getRoutinesPage(
  apiKey: string,
  request: typeof fetch,
  page: number,
  pageSize: number
): Promise<z.infer<typeof routinesPageSchema>> {
  return parseProviderPayload(
    await getPage(apiKey, request, "/v1/routines", page, pageSize),
    routinesPageSchema
  );
}

async function getWorkoutsPage(
  apiKey: string,
  request: typeof fetch,
  page: number,
  pageSize: number
): Promise<z.infer<typeof workoutsPageSchema>> {
  return parseProviderPayload(
    await getPage(apiKey, request, "/v1/workouts", page, pageSize),
    workoutsPageSchema
  );
}

async function getPage(
  apiKey: string,
  request: typeof fetch,
  path: "/v1/routines" | "/v1/workouts",
  page: number,
  pageSize: number
): Promise<unknown> {
  validatePagination(page, pageSize);

  const url = new URL(path, BASE_URL);
  url.searchParams.set("page", String(page));
  url.searchParams.set("pageSize", String(pageSize));

  let response: Response;
  try {
    response = await request(new Request(url, {
      method: "GET",
      headers: { "api-key": apiKey }
    }));
  } catch {
    throw new ProviderError("hevy", "unavailable");
  }

  if (!response.ok) {
    throw new ProviderError("hevy", response.status, undefined, retryAt(response.headers.get("Retry-After")));
  }

  try {
    return await response.json();
  } catch {
    throw new ProviderError("hevy", "schema");
  }
}

function parseProviderPayload<T extends z.ZodType>(payload: unknown, schema: T): z.output<T> {
  try {
    return schema.parse(payload);
  } catch {
    throw new ProviderError("hevy", "schema");
  }
}

function normalizeRoutine(routine: ProviderRoutine): HevyRoutine {
  return normalizeProviderObject(() => ({
    id: routine.id,
    title: routine.title,
    ...optionalValue("folderId", routine.folder_id),
    updatedAt: normalizeTimestamp(routine.updated_at),
    createdAt: normalizeTimestamp(routine.created_at),
    exercises: routine.exercises.map(normalizeExercise)
  }));
}

function normalizeWorkout(workout: ProviderWorkout): HevyWorkout {
  return normalizeProviderObject(() => ({
    id: workout.id,
    title: workout.title,
    ...optionalValue("routineId", workout.routine_id),
    ...optionalValue("description", workout.description),
    startTime: normalizeTimestamp(workout.start_time),
    endTime: normalizeTimestamp(workout.end_time),
    updatedAt: normalizeTimestamp(workout.updated_at),
    createdAt: normalizeTimestamp(workout.created_at),
    exercises: workout.exercises.map(normalizeExercise)
  }));
}

function normalizeExercise(exercise: ProviderExercise): HevyExercise {
  return {
    ...optionalValue("id", exercise.id),
    index: exercise.index,
    title: exercise.title,
    ...optionalValue("notes", exercise.notes),
    ...optionalValue("restSeconds", exercise.rest_seconds),
    exerciseTemplateId: exercise.exercise_template_id,
    ...optionalValue("supersetId", exercise.supersets_id),
    sets: exercise.sets.map(normalizeSet)
  };
}

function normalizeSet(set: ProviderSet): HevySet {
  const repRange = set.rep_range === undefined || set.rep_range === null ? undefined : {
    ...optionalValue("start", set.rep_range.start),
    ...optionalValue("end", set.rep_range.end)
  };
  return {
    ...optionalValue("id", set.id),
    index: set.index,
    type: set.type,
    ...(set.weight_kg === undefined || set.weight_kg === null
      ? {}
      : { weight: { value: set.weight_kg, unit: "kg" } }),
    ...optionalValue("reps", set.reps),
    ...optionalValue("rpe", set.rpe),
    ...optionalValue("distanceMeters", set.distance_meters),
    ...optionalValue("durationSeconds", set.duration_seconds),
    ...optionalValue("customMetric", set.custom_metric),
    ...(repRange === undefined ? {} : { repRange })
  };
}

function normalizeTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error("Invalid provider timestamp");
  }

  return timestamp.toISOString();
}

function normalizeProviderObject<T>(normalize: () => T): T {
  try {
    return normalize();
  } catch {
    throw new ProviderError("hevy", "schema");
  }
}

function isInRange(timestamp: string, range: DateRange): boolean {
  const date = timestamp.slice(0, 10);
  return date >= range.start && date <= range.end;
}

function nextPage(page: number, pageCount: number): { nextPage?: number } {
  return page < pageCount ? { nextPage: page + 1 } : {};
}

function validatePagination(page: number, pageSize: number): void {
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > MAX_PAGE_SIZE
  ) {
    throw new Error("Invalid Hevy pagination");
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
