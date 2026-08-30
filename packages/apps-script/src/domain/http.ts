export interface HttpRequest {
  url: string;
  method: "get";
  headers?: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

export interface HttpTransport {
  fetch(request: HttpRequest): HttpResponse;
}

export class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
  }
}

export class HttpBudgetExceeded extends Error {
  constructor() {
    super("HTTP_RETRY_BUDGET_EXHAUSTED");
  }
}

export interface RetryRuntime {
  sleep(ms: number): void;
  random(): number;
  remainingMs?(): number;
}

export function executeGetWithRetry(
  request: HttpRequest,
  transport: HttpTransport,
  runtime: RetryRuntime,
  maxAttempts = 4,
): HttpResponse {
  if (request.method !== "get") throw new Error("READ_ONLY_CLIENT_REJECTED_NON_GET");
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = transport.fetch(request);
      if (response.status >= 200 && response.status < 300) return response;
      if (response.status === 401 || response.status === 403) {
        throw new HttpFailure(response.status, false, `AUTHENTICATION_FAILED_${response.status}`);
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable) throw new HttpFailure(response.status, false, `HTTP_${response.status}`);
      if (attempt === maxAttempts) throw new HttpFailure(response.status, true, `HTTP_${response.status}_RETRIES_EXHAUSTED`);
      sleepWithinBudget(runtime, retryDelayMs(response, attempt, runtime.random()));
    } catch (error) {
      if (error instanceof HttpBudgetExceeded) throw error;
      if (error instanceof HttpFailure && !error.retryable) throw error;
      lastError = error;
      if (attempt === maxAttempts) {
        if (error instanceof HttpFailure) throw error;
        throw new HttpFailure(0, true, "NETWORK_RETRIES_EXHAUSTED");
      }
      if (!(error instanceof HttpFailure)) sleepWithinBudget(runtime, exponentialBackoffMs(attempt, runtime.random()));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("HTTP_RETRY_FAILED");
}

function sleepWithinBudget(runtime: RetryRuntime, delayMs: number): void {
  const remaining = runtime.remainingMs?.();
  if (remaining !== undefined && (!Number.isFinite(remaining) || delayMs >= remaining - 15_000)) {
    throw new HttpBudgetExceeded();
  }
  runtime.sleep(delayMs);
}

export function retryDelayMs(response: HttpResponse, attempt: number, random: number): number {
  const retryAfter = headerValue(response.headers, "retry-after");
  if (response.status === 429 && retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return exponentialBackoffMs(attempt, random);
}

export function exponentialBackoffMs(attempt: number, random: number): number {
  const base = Math.min(30_000, 500 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base + base * 0.25 * Math.min(1, Math.max(0, random)));
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return match?.[1];
}

export function parseJson<T>(response: HttpResponse, shapeName: string): T {
  try {
    return JSON.parse(response.body) as T;
  } catch {
    throw new HttpFailure(response.status, false, `SCHEMA_MISMATCH:${shapeName}:invalid_json`);
  }
}

export function queryString(params: Record<string, string | number | boolean | undefined>): string {
  return Object.entries(params)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}
