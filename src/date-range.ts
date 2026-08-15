export interface DateRange {
  start: string;
  end: string;
}

export type DateRangeInput = Partial<DateRange>;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_RANGE_DAYS = 90;
const DEFAULT_RANGE_DAYS = 7;

/**
 * Parse a bounded range of UTC calendar dates. Both endpoints are inclusive.
 * Missing endpoints default to a seven-day range ending today (UTC).
 */
export function parseDateRange(input: DateRangeInput = {}, now: Date = new Date()): DateRange {
  if (input === null || typeof input !== "object") {
    throw new Error("Invalid date range");
  }

  const today = toUtcDateOnly(now);
  const requestedStart = readDate(input.start);
  const requestedEnd = readDate(input.end);
  const end = requestedEnd ?? today;
  const start = requestedStart ?? addUtcDays(end, -(DEFAULT_RANGE_DAYS - 1));

  if (end.getTime() < start.getTime()) {
    throw new Error("Date range end cannot be before start");
  }

  const inclusiveDays = Math.floor((end.getTime() - start.getTime()) / DAY_MS) + 1;
  if (inclusiveDays > MAX_RANGE_DAYS) {
    throw new Error("Date range cannot exceed 90 days");
  }

  return { start: formatDate(start), end: formatDate(end) };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function readDate(value: unknown): Date | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    throw new Error("Invalid ISO date");
  }

  const [, yearText, monthText, dayText] = value.match(ISO_DATE) as RegExpMatchArray;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error("Invalid ISO date");
  }

  return date;
}

function toUtcDateOnly(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("Invalid current date");
  }

  const date = new Date(value.getTime());
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function addUtcDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
