import type { DateRange } from "./date-range";
import { toSafeError, type SafeError } from "./errors";
import type { Concept2Client, Concept2Result } from "./providers/concept2";
import type { HevyClient, HevyWorkout } from "./providers/hevy";

const TWO_MINUTES_MS = 2 * 60 * 1_000;
const CONCEPT2_UTC_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?:Z)?$/;

export type TrainingSource = "hevy" | "concept2";

interface TrainingRecordBase {
  source: TrainingSource;
  sourceId: string;
  startTime?: string;
  durationSeconds?: number;
  activityType: string;
}

export interface HevyTrainingRecord extends TrainingRecordBase {
  source: "hevy";
  startTime: string;
  workout: HevyWorkout;
}

export interface Concept2TrainingRecord extends TrainingRecordBase {
  source: "concept2";
  result: Concept2Result;
}

/** A provider payload labeled with stable source metadata and comparable summary fields. */
export type TrainingRecord = HevyTrainingRecord | Concept2TrainingRecord;

/** A cross-provider match that is strong enough to review, but never auto-removed. */
export interface DuplicateCandidate {
  records: [TrainingRecord, TrainingRecord];
  evidence: {
    startTimeDifferenceSeconds: number;
    durationSeconds: number;
    activityType: string;
  };
}

export interface TrainingSummary {
  range: DateRange;
  retrievedAt: string;
  records: TrainingRecord[];
  possibleDuplicates: DuplicateCandidate[];
  providerErrors?: SafeError[];
}

export interface ConnectionStatus {
  provider: TrainingSource;
  connected: boolean;
  checkedAt: string;
  error?: SafeError;
}

export interface TrainingService {
  connectionStatus(): Promise<ConnectionStatus[]>;
  getSummary(range: DateRange): Promise<TrainingSummary>;
}

type Clock = () => Date;

/** Combine read-only provider records without making uncertain deduplication decisions. */
export function createTrainingService(
  hevy: HevyClient,
  concept2: Concept2Client,
  now: Clock = () => new Date()
): TrainingService {
  return {
    async connectionStatus() {
      const checkedAt = timestamp(now);
      const results = await Promise.allSettled([hevy.ping(), concept2.ping()]);

      return results.map((result, index): ConnectionStatus => {
        const provider: TrainingSource = index === 0 ? "hevy" : "concept2";

        if (result.status === "fulfilled") {
          return { provider, connected: true, checkedAt };
        }

        return { provider, connected: false, checkedAt, error: toSafeError(result.reason) };
      });
    },

    async getSummary(range) {
      const results = await Promise.allSettled([
        getAllHevyWorkouts(hevy, range),
        getAllConcept2Results(concept2, range)
      ]);
      const retrievedAt = timestamp(now);
      const records = deduplicateSameSourceIds([
        ...(results[0].status === "fulfilled" ? results[0].value.map(toHevyTrainingRecord) : []),
        ...(results[1].status === "fulfilled" ? results[1].value.map(toConcept2TrainingRecord) : [])
      ]).sort(compareRecords);
      const providerErrors = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => toSafeError(result.reason));

      return {
        range,
        retrievedAt,
        records,
        possibleDuplicates: findPossibleDuplicates(records),
        ...(providerErrors.length === 0 ? {} : { providerErrors })
      };
    }
  };
}

async function getAllHevyWorkouts(client: HevyClient, range: DateRange): Promise<HevyWorkout[]> {
  const items: HevyWorkout[] = [];
  let page: number | undefined;

  do {
    const result = page === undefined
      ? await client.getWorkouts(range)
      : await client.getWorkouts(range, page);
    items.push(...result.items);
    page = result.nextPage;
  } while (page !== undefined);

  return items;
}

async function getAllConcept2Results(client: Concept2Client, range: DateRange): Promise<Concept2Result[]> {
  const items: Concept2Result[] = [];
  let page: number | undefined;

  do {
    const result = page === undefined
      ? await client.getResults(range)
      : await client.getResults(range, page);
    items.push(...result.items);
    page = result.nextPage;
  } while (page !== undefined);

  return items;
}

function toHevyTrainingRecord(workout: HevyWorkout): HevyTrainingRecord {
  return {
    source: "hevy",
    sourceId: workout.id,
    startTime: workout.startTime,
    ...optionalDuration(durationBetween(workout.startTime, workout.endTime)),
    activityType: workout.title,
    workout
  };
}

function toConcept2TrainingRecord(result: Concept2Result): Concept2TrainingRecord {
  return {
    source: "concept2",
    sourceId: String(result.id),
    ...optionalValue("startTime", normalizeConcept2Utc(result.dateUtc)),
    ...optionalDuration(result.durationTenths >= 0 ? result.durationTenths / 10 : undefined),
    activityType: result.machineType,
    result
  };
}

function deduplicateSameSourceIds(records: TrainingRecord[]): TrainingRecord[] {
  const seen = new Set<string>();

  return records.filter((record) => {
    const key = `${record.source}:${record.sourceId}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function findPossibleDuplicates(records: TrainingRecord[]): DuplicateCandidate[] {
  const candidates: DuplicateCandidate[] = [];

  for (let leftIndex = 0; leftIndex < records.length; leftIndex += 1) {
    const left = records[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < records.length; rightIndex += 1) {
      const right = records[rightIndex];
      const candidate = duplicateCandidate(left, right);
      if (candidate !== undefined) {
        candidates.push(candidate);
      }
    }
  }

  return candidates;
}

function duplicateCandidate(left: TrainingRecord, right: TrainingRecord): DuplicateCandidate | undefined {
  if (
    left.source === right.source ||
    left.startTime === undefined ||
    right.startTime === undefined ||
    left.durationSeconds === undefined ||
    right.durationSeconds === undefined ||
    left.activityType === "" ||
    left.activityType !== right.activityType ||
    left.durationSeconds !== right.durationSeconds
  ) {
    return undefined;
  }

  const startTimeDifferenceMs = Math.abs(Date.parse(left.startTime) - Date.parse(right.startTime));
  if (!Number.isFinite(startTimeDifferenceMs) || startTimeDifferenceMs > TWO_MINUTES_MS) {
    return undefined;
  }

  return {
    records: [left, right],
    evidence: {
      startTimeDifferenceSeconds: startTimeDifferenceMs / 1_000,
      durationSeconds: left.durationSeconds,
      activityType: left.activityType
    }
  };
}

function compareRecords(left: TrainingRecord, right: TrainingRecord): number {
  const byStartTime = (left.startTime ?? "").localeCompare(right.startTime ?? "");
  if (byStartTime !== 0) {
    return byStartTime;
  }

  const bySource = left.source.localeCompare(right.source);
  return bySource === 0 ? left.sourceId.localeCompare(right.sourceId) : bySource;
}

function durationBetween(start: string, end: string): number | undefined {
  const milliseconds = Date.parse(end) - Date.parse(start);
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds / 1_000 : undefined;
}

function normalizeConcept2Utc(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const match = value.match(CONCEPT2_UTC_TIMESTAMP);
  if (match === null) {
    return undefined;
  }

  const date = new Date(`${match[1]}T${match[2]}Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== match[1]) {
    return undefined;
  }

  return date.toISOString();
}

function optionalDuration(value: number | undefined): { durationSeconds: number } | Record<string, never> {
  return value === undefined ? {} : { durationSeconds: value };
}

function optionalValue<Key extends string, Value>(
  key: Key,
  value: Value | undefined
): { [K in Key]: Value } | Record<string, never> {
  return value === undefined ? {} : { [key]: value } as { [K in Key]: Value };
}

function timestamp(now: Clock): string {
  return now().toISOString();
}
