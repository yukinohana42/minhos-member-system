import { exceptionKey } from "./keys";
import type { BillingSignalRow, ExceptionRow } from "./types";

export interface TrackedSignalPage {
  rows: BillingSignalRow[];
  hasMore: boolean;
}

/**
 * Produces a deterministic, resumable page. An operator-resolved/ignored
 * exception is an explicit decision and must not trigger repeated Stripe
 * retrievals on every full run.
 */
export function planTrackedSignalPage(input: {
  signals: BillingSignalRow[];
  exceptions: ExceptionRow[];
  afterKey?: string;
  limit: number;
}): TrackedSignalPage {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new Error("INVALID_TRACKED_SIGNAL_PAGE_LIMIT");
  }
  const suppressed = new Set(
    input.exceptions
      .filter((row) => row.status === "ignored" || row.status === "resolved")
      .map((row) => row.exception_key),
  );
  const afterKey = input.afterKey ?? "";
  const candidates = input.signals
    .filter((row) => row.needs_action && (row.object_type === "refund" || row.object_type === "dispute"))
    .filter((row) => row.signal_key > afterKey)
    .filter((row) => !suppressed.has(signalExceptionKey(row)))
    .sort((left, right) => left.signal_key < right.signal_key ? -1 : left.signal_key > right.signal_key ? 1 : 0);
  return {
    rows: candidates.slice(0, input.limit),
    hasMore: candidates.length > input.limit,
  };
}

function signalExceptionKey(row: BillingSignalRow): string {
  return row.object_type === "refund"
    ? exceptionKey("REFUND_REVIEW_REQUIRED", row.refund_id)
    : exceptionKey("OPEN_DISPUTE", row.dispute_id);
}
