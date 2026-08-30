import { describe, expect, it, vi } from "vitest";
import type { ProfileRetryItem } from "../src/domain/profile-retry";
import { runProfileRetryBatch } from "../src/domain/profile-retry-runner";

const NOW = "2026-08-28T00:00:00.000Z";

describe("profile retry batch runner", () => {
  it("does not let a missing head block a later valid response", () => {
    const processed: string[] = [];
    const succeeded: string[] = [];
    const failures: Array<{ id: string; kind: string; count: number }> = [];
    const result = runProfileRetryBatch({
      expectedFormId: "form_1",
      nowIso: NOW,
      items: [item("missing", 0), item("valid", 1)],
      responseFor: (id) => id === "valid" ? { id } : undefined,
      process: (_queued, response) => processed.push(response.id),
      onSuccess: (queued) => succeeded.push(queued.responseId),
      onFailure: (previous, next, kind) => failures.push({
        id: previous.responseId,
        kind,
        count: next.failureCount ?? 0,
      }),
      isCoordinationBusy: () => false,
    });

    expect(processed).toEqual(["valid"]);
    expect(succeeded).toEqual(["valid"]);
    expect(failures).toEqual([{ id: "missing", kind: "missing_response", count: 1 }]);
    expect(result.firstNonBusyError).toEqual(new Error("PROFILE_RETRY_RESPONSE_NOT_FOUND"));
  });

  it("retains a busy head and still attempts a later valid response", () => {
    const failures: string[] = [];
    const successes: string[] = [];
    const process = vi.fn((queued: ProfileRetryItem) => {
      if (queued.responseId === "busy") throw new Error("SCRIPT_COORDINATION_LOCK_BUSY");
    });
    const result = runProfileRetryBatch({
      expectedFormId: "form_1",
      nowIso: NOW,
      items: [item("busy", 0), item("valid", 1)],
      responseFor: (id) => ({ id }),
      process,
      onSuccess: (queued) => successes.push(queued.responseId),
      onFailure: (queued, _next, kind) => failures.push(`${queued.responseId}:${kind}`),
      isCoordinationBusy: (error) => error instanceof Error && error.message === "SCRIPT_COORDINATION_LOCK_BUSY",
    });

    expect(process.mock.calls.map(([queued]) => queued.responseId)).toEqual(["busy", "valid"]);
    expect(failures).toEqual(["busy:coordination_busy"]);
    expect(successes).toEqual(["valid"]);
    expect(result).toEqual({});
  });

  it("retains nonbusy failures, continues siblings, and returns the first error", () => {
    const first = new Error("PROFILE_PROCESSING_FAILED_FIRST");
    const second = new Error("PROFILE_PROCESSING_FAILED_SECOND");
    const attempted: string[] = [];
    const failures: string[] = [];
    const result = runProfileRetryBatch({
      expectedFormId: "form_1",
      nowIso: NOW,
      items: [item("first", 0), item("second", 1), item("valid", 2)],
      responseFor: (id) => ({ id }),
      process: (queued) => {
        attempted.push(queued.responseId);
        if (queued.responseId === "first") throw first;
        if (queued.responseId === "second") throw second;
      },
      onSuccess: vi.fn(),
      onFailure: (queued, _next, kind) => failures.push(`${queued.responseId}:${kind}`),
      isCoordinationBusy: () => false,
    });

    expect(attempted).toEqual(["first", "second", "valid"]);
    expect(failures).toEqual(["first:processing_error", "second:processing_error"]);
    expect(result.firstNonBusyError).toBe(first);
  });

  it("isolates a point-lookup failure and still processes a later response", () => {
    const lookupError = new Error("FORM_RESPONSE_LOOKUP_FAILED");
    const processed: string[] = [];
    const failures: string[] = [];
    const result = runProfileRetryBatch({
      expectedFormId: "form_1",
      nowIso: NOW,
      items: [item("lookup-fails", 0), item("valid", 1)],
      responseFor: (id) => {
        if (id === "lookup-fails") throw lookupError;
        return { id };
      },
      process: (_queued, response) => processed.push(response.id),
      onSuccess: vi.fn(),
      onFailure: (queued, _next, kind) => failures.push(`${queued.responseId}:${kind}`),
      isCoordinationBusy: () => false,
    });

    expect(processed).toEqual(["valid"]);
    expect(failures).toEqual(["lookup-fails:processing_error"]);
    expect(result.firstNonBusyError).toBe(lookupError);
  });

  it("treats a wrong queued Form as a permanent item failure without exposing IDs", () => {
    const onFailure = vi.fn();
    const process = vi.fn();
    const result = runProfileRetryBatch({
      expectedFormId: "expected",
      nowIso: NOW,
      items: [{ ...item("response-secret", 0), formId: "wrong-form-secret" }],
      responseFor: () => ({ id: "unused" }),
      process,
      onSuccess: vi.fn(),
      onFailure,
      isCoordinationBusy: () => false,
    });

    expect(process).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ responseId: "response-secret" }),
      expect.objectContaining({ lastFailureKind: "processing_error", failureCount: 1 }),
      "processing_error",
    );
    expect(String(result.firstNonBusyError)).toBe("Error: PROFILE_RETRY_FORM_MISMATCH");
    expect(String(result.firstNonBusyError)).not.toContain("secret");
  });
});

function item(responseId: string, seconds: number): ProfileRetryItem {
  return {
    formId: "form_1",
    responseId,
    queuedAt: new Date(Date.parse(NOW) + seconds * 1_000).toISOString(),
  };
}
