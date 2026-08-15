export type ProviderName = "hevy" | "concept2" | "mcp";

export type ErrorCategory =
  | "auth"
  | "forbidden"
  | "rate_limit"
  | "unavailable"
  | "schema"
  | "invalid_request";

export type SafeError = {
  provider: ProviderName;
  category: ErrorCategory;
  retryable: boolean;
  retryAt?: string;
};

/** A caller-input failure whose detail must not cross the MCP boundary. */
export class CallerValidationError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "CallerValidationError";
  }
}

/** An error at a provider boundary. Its details are intentionally not safe to return to callers. */
export class ProviderError extends Error {
  readonly provider: ProviderName;
  readonly category: ErrorCategory;
  readonly status?: number;
  readonly retryAt?: string;

  constructor(
    provider: ProviderName,
    category: ErrorCategory,
    status?: number,
    detail?: string,
    retryAt?: string
  );
  constructor(provider: ProviderName, status: number, detail?: string, retryAt?: string);
  constructor(
    provider: ProviderName,
    categoryOrStatus: ErrorCategory | number,
    statusOrDetail?: number | string,
    detailOrRetryAt?: string,
    retryAt?: string
  ) {
    const status = typeof categoryOrStatus === "number" ? categoryOrStatus :
      typeof statusOrDetail === "number" ? statusOrDetail : undefined;
    const explicitCategory = typeof categoryOrStatus === "string" ? categoryOrStatus : undefined;
    const detail = typeof categoryOrStatus === "number"
      ? typeof statusOrDetail === "string" ? statusOrDetail : undefined
      : detailOrRetryAt;
    const retryTime = typeof categoryOrStatus === "number" ? detailOrRetryAt : retryAt;
    const category: ErrorCategory = status === undefined
      ? explicitCategory ?? "unavailable"
      : categoryForStatus(status) ?? explicitCategory ?? "unavailable";

    super(detail ?? `${provider} provider request failed`);
    this.name = "ProviderError";
    this.provider = provider;
    this.category = category;
    this.status = status;
    this.retryAt = retryTime;
  }
}

/** Convert internal/provider failures to the small, credential-free public error shape. */
export function toSafeError(error: unknown): SafeError {
  if (error instanceof ProviderError) {
    const safe: SafeError = {
      provider: error.provider,
      category: error.category,
      retryable: isRetryable(error.category)
    };

    if (safe.retryable && error.retryAt !== undefined) {
      safe.retryAt = error.retryAt;
    }

    return safe;
  }

  if (isSchemaError(error)) {
    return { provider: "mcp", category: "schema", retryable: false };
  }

  if (isCallerValidationError(error)) {
    return { provider: "mcp", category: "invalid_request", retryable: false };
  }

  return { provider: "mcp", category: "unavailable", retryable: false };
}

function categoryForStatus(status: number): ErrorCategory | undefined {
  switch (status) {
    case 400:
    case 422:
      return "schema";
    case 401:
      return "auth";
    case 403:
      return "forbidden";
    case 429:
      return "rate_limit";
    case 500:
    case 503:
      return "unavailable";
    default:
      return undefined;
  }
}

function isRetryable(category: ErrorCategory): boolean {
  return category === "rate_limit" || category === "unavailable";
}

function isSchemaError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { name?: unknown; issues?: unknown };
  return candidate.name === "ZodError" || Array.isArray(candidate.issues);
}

function isCallerValidationError(error: unknown): boolean {
  if (error instanceof CallerValidationError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return /^(Invalid ISO date|Invalid date range|Date range |Invalid Hevy pagination$)/.test(error.message);
}
