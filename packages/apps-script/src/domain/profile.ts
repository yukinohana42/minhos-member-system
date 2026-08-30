import { exceptionKey } from "./keys";
import type { ExceptionFinding, MemberRow, SheetRecord } from "./types";
import type { ProfileStatus } from "./types";
import { normalizeEmail } from "./values";

export interface ProfileSubmission {
  responseId: string;
  submittedAt: string;
  email: string;
  affiliation: string;
  titleOrRole: string;
  participantType: string;
  privacyAcknowledgement: string;
}

export type ProfileSubmissionPlan =
  | { kind: "noop_duplicate_event" }
  | { kind: "insert"; supplemental: SheetRecord }
  | { kind: "exception"; finding: ExceptionFinding };

export function deriveProfileStatus(minhosMemberId: string, supplementalRows: SheetRecord[]): ProfileStatus {
  const rows = supplementalRows.filter(
    (candidate) => candidate.minhos_member_id === minhosMemberId && Boolean(candidate.profile_response_id),
  );
  if (rows.length === 0) return "not_submitted";
  if (rows.length !== 1) return "review_required";
  const verification = String(rows[0]?.verification_status ?? "").trim().toLowerCase();
  return ["matched", "verified", "approved"].includes(verification)
    ? "matched"
    : "review_required";
}

export function planProfileSubmission(input: {
  submission: ProfileSubmission;
  members: MemberRow[];
  supplementalRows: SheetRecord[];
}): ProfileSubmissionPlan {
  const submission = input.submission;
  if (!submission.responseId.trim()) throw new Error("FORM_RESPONSE_ID_REQUIRED");
  if (input.supplementalRows.some((row) => row.profile_response_id === submission.responseId)) {
    return { kind: "noop_duplicate_event" };
  }

  const email = normalizeEmail(submission.email);
  const candidates = input.members.filter(
    (member) => member.source_present_ghost && normalizeEmail(member.email) === email,
  );
  if (candidates.length !== 1) {
    const type = candidates.length === 0 ? "PROFILE_SUBMISSION_UNMATCHED" : "PROFILE_SUBMISSION_AMBIGUOUS";
    return {
      kind: "exception",
      finding: {
        exceptionKey: exceptionKey(type, submission.responseId),
        exceptionType: type,
        severity: "P2",
        summary: candidates.length === 0
          ? "Form回答をGhost会員へ完全一致で照合できません。"
          : "Form回答メールに一致するGhost会員が複数あります。",
        immediate: true,
      },
    };
  }

  const member = candidates[0]!;
  const existing = input.supplementalRows.find((row) => row.minhos_member_id === member.minhos_member_id);
  if (existing) {
    return {
      kind: "exception",
      finding: {
        exceptionKey: exceptionKey("PROFILE_SUBMISSION_REPEAT", submission.responseId),
        exceptionType: "PROFILE_SUBMISSION_REPEAT",
        severity: "P2",
        summary: "同じ会員の再回答を検出しました。既存プロフィールは上書きしていません。",
        minhosMemberId: member.minhos_member_id,
        ghostMemberId: member.ghost_member_id,
        immediate: true,
      },
    };
  }

  return {
    kind: "insert",
    supplemental: {
      minhos_member_id: member.minhos_member_id,
      ghost_member_id: member.ghost_member_id,
      profile_response_id: submission.responseId,
      profile_email_at_submission: email,
      match_basis: "normalized_email_exact",
      verification_status: "unverified",
      form_affiliation: submission.affiliation,
      form_title_or_role: submission.titleOrRole,
      form_participant_type: submission.participantType,
      override_affiliation: "",
      override_title_or_role: "",
      override_participant_type: "",
      effective_affiliation: "",
      effective_title_or_role: "",
      effective_participant_type: "",
      profile_updated_at: submission.submittedAt,
      ops_owner: "",
      ops_note: "",
    },
  };
}
