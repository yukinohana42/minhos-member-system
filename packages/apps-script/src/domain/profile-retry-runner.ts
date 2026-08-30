import { rescheduleProfileRetry, type ProfileRetryItem } from "./profile-retry";

export type ProfileRetryFailureKind = NonNullable<ProfileRetryItem["lastFailureKind"]>;

export interface ProfileRetryBatchPorts<Response> {
  expectedFormId: string;
  nowIso: string;
  items: readonly ProfileRetryItem[];
  responseFor: (responseId: string) => Response | undefined;
  process: (item: ProfileRetryItem, response: Response) => void;
  onSuccess: (item: ProfileRetryItem) => void;
  onFailure: (
    previous: ProfileRetryItem,
    next: ProfileRetryItem,
    kind: ProfileRetryFailureKind,
  ) => void;
  isCoordinationBusy: (error: unknown) => boolean;
}

export interface ProfileRetryBatchResult {
  firstNonBusyError?: unknown;
}

/**
 * Process each due item independently. A missing, malformed, or busy head may
 * never prevent a later valid response from being attempted in the same
 * bounded invocation.
 */
export function runProfileRetryBatch<Response>(
  ports: ProfileRetryBatchPorts<Response>,
): ProfileRetryBatchResult {
  let firstNonBusyError: unknown;
  for (const item of ports.items) {
    if (item.formId !== ports.expectedFormId) {
      const error = new Error("PROFILE_RETRY_FORM_MISMATCH");
      ports.onFailure(item, rescheduleProfileRetry(item, ports.nowIso, "processing_error"), "processing_error");
      firstNonBusyError ??= error;
      continue;
    }

    let response: Response | undefined;
    try {
      response = ports.responseFor(item.responseId);
    } catch (error) {
      ports.onFailure(item, rescheduleProfileRetry(item, ports.nowIso, "processing_error"), "processing_error");
      firstNonBusyError ??= error;
      continue;
    }
    if (!response) {
      const error = new Error("PROFILE_RETRY_RESPONSE_NOT_FOUND");
      ports.onFailure(item, rescheduleProfileRetry(item, ports.nowIso, "missing_response"), "missing_response");
      firstNonBusyError ??= error;
      continue;
    }

    try {
      ports.process(item, response);
      ports.onSuccess(item);
    } catch (error) {
      const kind: ProfileRetryFailureKind = ports.isCoordinationBusy(error)
        ? "coordination_busy"
        : "processing_error";
      ports.onFailure(item, rescheduleProfileRetry(item, ports.nowIso, kind), kind);
      if (kind !== "coordination_busy") firstNonBusyError ??= error;
    }
  }
  return firstNonBusyError === undefined ? {} : { firstNonBusyError };
}
