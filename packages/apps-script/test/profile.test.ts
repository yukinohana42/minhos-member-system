import { describe, expect, it } from "vitest";
import { assertProfileFormDestination, assertProfileFormSource, extractProfileSubmission } from "../src/adapters/profile-form";
import { deriveProfileStatus, planProfileSubmission, type ProfileSubmission } from "../src/domain/profile";
import {
  dueProfileRetryItems,
  enqueueProfileRetry,
  parseProfileRetryProperties,
  parseProfileRetryQueue,
  profileRetryPropertyName,
  profileRetryQuarantinePropertyName,
  profileRetryQuarantineRecord,
  removeProfileRetry,
  rescheduleProfileRetry,
  serializeProfileRetryItem,
  serializeProfileRetryQuarantine,
  shouldQuarantineProfileRetry,
} from "../src/domain/profile-retry";
import { SAFE_PROPERTY_VALUE_BYTES, utf8ByteLength } from "../src/domain/property-quota";
import type { MemberRow, SheetRecord } from "../src/domain/types";

const nowIso = "2026-08-28T00:00:00.000Z";
const submission: ProfileSubmission = {
  responseId: "response_1",
  submittedAt: nowIso,
  email: " Member@Example.Invalid ",
  affiliation: "所属A",
  titleOrRole: "役割A",
  participantType: "参加者",
  privacyAcknowledgement: "同意",
};

describe("profile Form matching", () => {
  it("extracts the persistent Form response ID and canonical fields", () => {
    const responses = new Map([
      ["Email", " Member@Example.Invalid "],
      ["Affiliation", "所属A"],
      ["Role", "役割A"],
      ["Type", "参加者"],
      ["Privacy", "同意"],
    ]);
    const result = extractProfileSubmission({
      getId: () => "response_1",
      getTimestamp: () => new Date(nowIso),
      getItemResponses: () => [...responses].map(([title, response]) => ({
        getItem: () => ({ getTitle: () => title }),
        getResponse: () => response,
      })),
    }, { email: "Email", affiliation: "Affiliation", titleOrRole: "Role", participantType: "Type", privacyAcknowledgement: "Privacy" });
    expect(result).toEqual({ ...submission, email: "Member@Example.Invalid" });
  });

  it("creates one unverified Supplemental row after trim/lowercase exact match", () => {
    const plan = planProfileSubmission({ submission, members: [member("member@example.invalid")], supplementalRows: [] });
    expect(plan.kind).toBe("insert");
    if (plan.kind !== "insert") return;
    expect(plan.supplemental).toMatchObject({
      minhos_member_id: "mm_1",
      ghost_member_id: "gm_1",
      profile_response_id: "response_1",
      profile_email_at_submission: "member@example.invalid",
      match_basis: "normalized_email_exact",
      verification_status: "unverified",
    });
  });

  it("returns exceptions for unmatched, ambiguous, and repeat answers without an overwrite row", () => {
    const unmatched = planProfileSubmission({ submission, members: [member("other@example.invalid")], supplementalRows: [] });
    expect(unmatched).toMatchObject({
      kind: "exception", finding: { exceptionType: "PROFILE_SUBMISSION_UNMATCHED", immediate: true },
    });

    const ambiguous = planProfileSubmission({
      submission,
      members: [member("member@example.invalid"), { ...member("member@example.invalid"), member_row_key: "ghost:site:gm_2", ghost_member_id: "gm_2", minhos_member_id: "mm_2" }],
      supplementalRows: [],
    });
    expect(ambiguous).toMatchObject({
      kind: "exception", finding: { exceptionType: "PROFILE_SUBMISSION_AMBIGUOUS", immediate: true },
    });

    const existing: SheetRecord = { minhos_member_id: "mm_1", profile_response_id: "old_response", ops_note: "operator-owned" };
    const repeated = planProfileSubmission({ submission, members: [member("member@example.invalid")], supplementalRows: [existing] });
    expect(repeated).toMatchObject({
      kind: "exception", finding: { exceptionType: "PROFILE_SUBMISSION_REPEAT", immediate: true },
    });
    expect(existing).toEqual({ minhos_member_id: "mm_1", profile_response_id: "old_response", ops_note: "operator-owned" });

    const occupiedLegacy: SheetRecord = { minhos_member_id: "mm_1", profile_response_id: "", ops_note: "operator-owned" };
    expect(planProfileSubmission({ submission, members: [member("member@example.invalid")], supplementalRows: [occupiedLegacy] }))
      .toMatchObject({ kind: "exception", finding: { exceptionType: "PROFILE_SUBMISSION_REPEAT" } });
    expect(occupiedLegacy).toEqual({ minhos_member_id: "mm_1", profile_response_id: "", ops_note: "operator-owned" });
  });

  it("treats a retried event with the same response ID as an idempotent no-op", () => {
    expect(planProfileSubmission({
      submission,
      members: [member("member@example.invalid")],
      supplementalRows: [{ minhos_member_id: "mm_1", profile_response_id: "response_1" }],
    })).toEqual({ kind: "noop_duplicate_event" });
  });

  it("derives only not_submitted, review_required, or matched from Supplemental", () => {
    expect(deriveProfileStatus("mm_1", [])).toBe("not_submitted");
    expect(deriveProfileStatus("mm_1", [{
      minhos_member_id: "mm_1", profile_response_id: "response", verification_status: "unverified",
    }])).toBe("review_required");
    expect(deriveProfileStatus("mm_1", [{
      minhos_member_id: "mm_1", profile_response_id: "response", verification_status: "verified",
    }])).toBe("matched");
    expect(deriveProfileStatus("mm_1", [
      { minhos_member_id: "mm_1", profile_response_id: "response_1", verification_status: "verified" },
      { minhos_member_id: "mm_1", profile_response_id: "response_2", verification_status: "verified" },
    ])).toBe("review_required");
  });

  it("rejects a missing or different Form event source before matching", () => {
    expect(() => assertProfileFormSource(undefined, "form_expected")).toThrow("PROFILE_FORM_SOURCE_MISMATCH");
    expect(() => assertProfileFormSource({ getId: () => "form_other" }, "form_expected"))
      .toThrow("PROFILE_FORM_SOURCE_MISMATCH");
    expect(() => assertProfileFormSource({ getId: () => "form_expected" }, "form_expected")).not.toThrow();
  });

  it("requires the configured Spreadsheet destination and strict response identity", () => {
    const source = {
      getId: () => "form_expected",
      getDestinationType: () => "SPREADSHEET",
      getDestinationId: () => "sheet_expected",
    };
    expect(() => assertProfileFormDestination(source, "sheet_expected")).not.toThrow();
    expect(() => assertProfileFormDestination({ ...source, getDestinationId: () => "sheet_other" }, "sheet_expected"))
      .toThrow("PROFILE_FORM_DESTINATION_MISMATCH");
    expect(() => assertProfileFormDestination({ ...source, getDestinationType: () => "NONE" }, "sheet_expected"))
      .toThrow("PROFILE_FORM_DESTINATION_MISMATCH");

    const baseResponse = {
      getId: () => "response_1",
      getTimestamp: () => new Date(nowIso),
      getItemResponses: () => [],
    };
    expect(() => extractProfileSubmission({ ...baseResponse, getId: () => "" }, {
      email: "Email", affiliation: "Affiliation", titleOrRole: "Role", participantType: "Type", privacyAcknowledgement: "Privacy",
    })).toThrow("FORM_RESPONSE_ID_INVALID");
    expect(() => extractProfileSubmission({
      ...baseResponse,
      getItemResponses: () => ["one", "two"].map(() => ({
        getItem: () => ({ getTitle: () => "Email" }), getResponse: () => "value",
      })),
    }, {
      email: "Email", affiliation: "Affiliation", titleOrRole: "Role", participantType: "Type", privacyAcknowledgement: "Privacy",
    })).toThrow("FORM_ITEM_TITLE_DUPLICATE");
  });

  it("persists only Form/response IDs in an idempotent retry queue", () => {
    const item = { formId: "form_1", responseId: "response_1", queuedAt: nowIso };
    const queued = enqueueProfileRetry([], item);
    expect(enqueueProfileRetry(queued, item)).toEqual(queued);
    expect(JSON.stringify(queued)).not.toContain("member@example.invalid");
    expect(parseProfileRetryQueue(JSON.stringify(queued))).toEqual([item]);
    expect(removeProfileRetry(queued, item)).toEqual([]);
    expect(() => parseProfileRetryQueue('[{"formId":"form_1","responseId":"response_1","queuedAt":"bad"}]'))
      .toThrow("INVALID_PROFILE_RETRY_QUEUE");
  });

  it("stores a Form burst one response per quota-safe property", () => {
    const namespace = "context";
    const items = Array.from({ length: 200 }, (_, index) => ({
      formId: "form_1", responseId: `response_${index}`, queuedAt: nowIso,
    }));
    const properties = Object.fromEntries(items.map((item) => [
      profileRetryPropertyName(item, namespace), serializeProfileRetryItem(item),
    ]));
    expect(Object.keys(properties)).toHaveLength(200);
    expect(Math.max(...Object.values(properties).map(utf8ByteLength))).toBeLessThanOrEqual(SAFE_PROPERTY_VALUE_BYTES);
    expect(parseProfileRetryProperties(properties, namespace)).toEqual(expect.arrayContaining(items));
  });

  it("orders due retries by time, skips a deferred head, and bounds permanent failures", () => {
    const olderDeferred = {
      formId: "form_1", responseId: "response_deferred", queuedAt: "2026-08-27T00:00:00.000Z",
      failureCount: 1, nextAttemptAt: "2026-08-28T02:00:00.000Z", lastFailureKind: "missing_response" as const,
    };
    const laterReady = {
      formId: "form_1", responseId: "response_ready", queuedAt: "2026-08-27T01:00:00.000Z",
    };
    expect(dueProfileRetryItems([olderDeferred, laterReady], "2026-08-28T01:00:00.000Z"))
      .toEqual([laterReady]);

    let failed = laterReady;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      failed = rescheduleProfileRetry(failed, `2026-08-28T0${attempt}:00:00.000Z`, "processing_error");
    }
    expect(failed).toMatchObject({ failureCount: 5, lastFailureKind: "processing_error" });
    expect(shouldQuarantineProfileRetry(failed)).toBe(true);
    expect(() => dueProfileRetryItems([laterReady], nowIso, 11)).toThrow("INVALID_PROFILE_RETRY_BATCH_LIMIT");

    const quarantine = profileRetryQuarantineRecord(failed, "processing_error", nowIso);
    const encoded = serializeProfileRetryQuarantine(quarantine);
    expect(profileRetryQuarantinePropertyName(quarantine, "context")).toContain(quarantine.quarantineId);
    expect(encoded).not.toContain(failed.formId);
    expect(encoded).not.toContain(failed.responseId);
  });
});

function member(email: string): MemberRow {
  return {
    member_row_key: "ghost:site:gm_1", minhos_member_id: "mm_1", ghost_site_id: "site", ghost_member_id: "gm_1",
    member_uuid: "uuid", email, name: "Member", ghost_member_status: "paid", ghost_access_state: "paid",
    tier_ids: "tier", stripe_customer_ids: "cus", stripe_customer_count: 1, qualifying_entitlement_count: 1,
    profile_status: "not_submitted", ops_flags: "", primary_ops_state: "OK", created_at: nowIso, updated_at: nowIso,
    last_synced_at: nowIso, source_present_ghost: true, source_missing_since: "", last_seen_ghost_run_id: "run",
    source_record_hash: "hash",
  };
}
