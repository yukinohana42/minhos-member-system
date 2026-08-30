export class SyncYieldRequested extends Error {
  constructor() {
    super("SYNC_YIELD_REQUESTED");
  }
}

export function isRuntimeBudgetExhausted(nowMs: number, deadlineMs: number, reserveMs = 15_000): boolean {
  return nowMs >= deadlineMs - reserveMs;
}

export function shouldRenewLease(
  nowMs: number,
  lastRenewedAtMs: number,
  force = false,
  intervalMs = 30_000,
): boolean {
  return force || lastRenewedAtMs === 0 || nowMs - lastRenewedAtMs >= intervalMs;
}
