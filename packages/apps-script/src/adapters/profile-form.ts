import type { ProfileSubmission } from "../domain/profile";

export interface FormItemResponseLike {
  getItem(): { getTitle(): string };
  getResponse(): unknown;
}

export interface FormResponseLike {
  getId(): string;
  getTimestamp(): Date;
  getItemResponses(): FormItemResponseLike[];
}

export interface FormSourceLike {
  getId(): string;
  getDestinationType?(): unknown;
  getDestinationId?(): string | null;
}

export interface ProfileFieldTitles {
  email: string;
  affiliation: string;
  titleOrRole: string;
  participantType: string;
  privacyAcknowledgement: string;
}

export const DEFAULT_PROFILE_FIELD_TITLES: ProfileFieldTitles = {
  email: "Ghost登録メールアドレス",
  affiliation: "所属",
  titleOrRole: "肩書き・役割",
  participantType: "参加区分",
  privacyAcknowledgement: "利用目的と窓口を確認しました",
};

export function extractProfileSubmission(
  response: FormResponseLike,
  titles: ProfileFieldTitles,
): ProfileSubmission {
  if (!response || typeof response.getId !== "function" ||
    typeof response.getTimestamp !== "function" || typeof response.getItemResponses !== "function") {
    throw new Error("FORM_RESPONSE_SHAPE_INVALID");
  }
  const responseIdValue = response.getId();
  if (typeof responseIdValue !== "string" || !responseIdValue.trim()) {
    throw new Error("FORM_RESPONSE_ID_INVALID");
  }
  const itemResponses = response.getItemResponses();
  if (!Array.isArray(itemResponses)) throw new Error("FORM_ITEM_RESPONSES_INVALID");
  const byTitle = new Map<string, string>();
  for (const itemResponse of itemResponses) {
    if (!itemResponse || typeof itemResponse.getItem !== "function" || typeof itemResponse.getResponse !== "function") {
      throw new Error("FORM_ITEM_RESPONSE_SHAPE_INVALID");
    }
    const item = itemResponse.getItem();
    if (!item || typeof item.getTitle !== "function") throw new Error("FORM_ITEM_SHAPE_INVALID");
    const titleValue = item.getTitle();
    if (typeof titleValue !== "string" || !titleValue.trim()) throw new Error("FORM_ITEM_TITLE_INVALID");
    const title = titleValue.trim();
    if (byTitle.has(title)) throw new Error("FORM_ITEM_TITLE_DUPLICATE");
    byTitle.set(title, responseText(itemResponse.getResponse()));
  }
  const timestamp = response.getTimestamp();
  if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
    throw new Error("FORM_RESPONSE_TIMESTAMP_INVALID");
  }
  return {
    responseId: responseIdValue.trim(),
    submittedAt: timestamp.toISOString(),
    email: byTitle.get(titles.email) ?? "",
    affiliation: byTitle.get(titles.affiliation) ?? "",
    titleOrRole: byTitle.get(titles.titleOrRole) ?? "",
    participantType: byTitle.get(titles.participantType) ?? "",
    privacyAcknowledgement: byTitle.get(titles.privacyAcknowledgement) ?? "",
  };
}

export function assertProfileFormSource(source: FormSourceLike | undefined, expectedFormId: string): void {
  if (!source || typeof source.getId !== "function") throw new Error("PROFILE_FORM_SOURCE_MISMATCH");
  const value = source.getId();
  const actual = typeof value === "string" ? value.trim() : "";
  if (!actual || actual !== expectedFormId.trim()) throw new Error("PROFILE_FORM_SOURCE_MISMATCH");
}

export function assertProfileFormDestination(
  source: FormSourceLike,
  expectedSpreadsheetId: string,
  spreadsheetDestinationType = "SPREADSHEET",
): void {
  if (typeof source.getDestinationType !== "function" || typeof source.getDestinationId !== "function") {
    throw new Error("PROFILE_FORM_DESTINATION_MISMATCH");
  }
  const destinationType = source.getDestinationType();
  const destinationId = source.getDestinationId();
  if (String(destinationType) !== spreadsheetDestinationType ||
    typeof destinationId !== "string" || destinationId.trim() !== expectedSpreadsheetId.trim()) {
    throw new Error("PROFILE_FORM_DESTINATION_MISMATCH");
  }
}

function responseText(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.some((item) => !isScalarResponse(item))) throw new Error("FORM_RESPONSE_VALUE_INVALID");
    return value.map(String).join(",").trim();
  }
  if (value === null || value === undefined) return "";
  if (!isScalarResponse(value)) throw new Error("FORM_RESPONSE_VALUE_INVALID");
  return String(value).trim();
}

function isScalarResponse(value: unknown): value is string | number | boolean {
  return typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean";
}
