import type { SheetRecord } from "../domain/types";
import {
  allowExistingBlankProfileResponseIds,
  assertAccessGrantIdentityIntegrity,
  assertCrossTableIdentityIntegrity,
  assertMemberIdentityIntegrity,
  assertPersistedIdentityRows,
  assertSubscriptionIdentityIntegrity,
  type SupplementalBlankProfileResponseIdPolicy,
} from "../domain/identity-integrity";
import {
  definitionFor,
  PROFILE_RAW_SHEET_NAME,
  SHEET_DEFINITIONS,
  type SheetDefinition,
} from "./sheet-schema";
import { ensureGridCapacity, safelyReplaceSheetContents, type SheetWritePort } from "./safe-sheet-write";

type RawSheetRecord = Record<string, unknown>;

type IdentityPreflight =
  | {
    kind: "single-sheet";
    sheet: GoogleAppsScript.Spreadsheet.Sheet;
    targetRows: RawSheetRecord[];
  }
  | {
    kind: "cross-table";
    sheet: GoogleAppsScript.Spreadsheet.Sheet;
    targetRows: RawSheetRecord[];
    memberRows: RawSheetRecord[];
    subscriptionRows: RawSheetRecord[];
    accessGrantRows: RawSheetRecord[];
    supplementalRows: RawSheetRecord[];
    blankProfileResponseIdPolicy: SupplementalBlankProfileResponseIdPolicy;
  };

const CROSS_TABLE_IDENTITY_SHEETS = new Set([
  "10_Members",
  "20_Subscriptions",
  "21_AccessGrants",
  "40_Supplemental",
]);

export interface UpsertCounts {
  inserted: number;
  updated: number;
  unchanged: number;
}

export interface RepositoryIdentityContext {
  ghostSiteId: string;
  stripeAccountId: string;
  livemode: boolean;
}

export class SheetsRepository {
  private readonly spreadsheet: GoogleAppsScript.Spreadsheet.Spreadsheet;

  constructor(
    spreadsheetId: string,
    spreadsheet?: GoogleAppsScript.Spreadsheet.Spreadsheet,
    private readonly identityContext?: RepositoryIdentityContext,
  ) {
    this.spreadsheet = spreadsheet ?? SpreadsheetApp.openById(spreadsheetId);
  }

  initialize(): void {
    // Validate every existing tab before creating anything. Explicit
    // initialization may create missing/blank tabs, but it must never repair a
    // malformed or duplicate-key table by overwriting it.
    const existingRows = new Map<string, RawSheetRecord[]>();
    for (const definition of SHEET_DEFINITIONS) {
      const sheet = this.spreadsheet.getSheetByName(definition.name);
      if (sheet && sheet.getLastRow() > 0) {
        this.validateSheet(sheet, definition);
        const rows = this.rawRecords(sheet);
        existingRows.set(definition.name, rows);
        if (!CROSS_TABLE_IDENTITY_SHEETS.has(definition.name)) {
          this.assertIdentityRows(definition.name, rows);
        }
      }
    }
    const memberRows = existingRows.get("10_Members") ?? [];
    const subscriptionRows = existingRows.get("20_Subscriptions") ?? [];
    const accessGrantRows = existingRows.get("21_AccessGrants") ?? [];
    const supplementalRows = existingRows.get("40_Supplemental") ?? [];
    assertCrossTableIdentityIntegrity({
      memberRows,
      subscriptionRows,
      accessGrantRows,
      supplementalRows,
      blankProfileResponseIdPolicy: persistedBlankProfileResponseIdPolicy(supplementalRows),
      ...(this.identityContext ? {
        expectedGhostSiteId: this.identityContext.ghostSiteId,
        expectedStripeContext: {
          stripeAccountId: this.identityContext.stripeAccountId,
          livemode: this.identityContext.livemode,
        },
      } : {}),
    });
    // 30_Profile_RAW is deliberately absent from SHEET_DEFINITIONS. Google
    // Forms owns its variable native headers and cells, so initialization must
    // neither create nor inspect that tab.
    for (const definition of SHEET_DEFINITIONS) {
      this.initializeSheet(definition);
    }
    this.writeNonSecretConfigNotice();
  }

  read<T extends SheetRecord>(sheetName: string): T[] {
    assertRepositorySheetAccess(sheetName, "read");
    const preflight = this.preflightExistingIdentity(sheetName);
    return preflight.targetRows.map(normalizeRecord) as T[];
  }

  upsert<T extends SheetRecord>(sheetName: string, incoming: T[], ownedColumns?: string[]): UpsertCounts {
    assertRepositorySheetAccess(sheetName, "generic_write");
    const definition = definitionFor(sheetName);
    const existing = this.read<SheetRecord>(sheetName);
    assertRecordKeys(sheetName, definition.keyColumn, incoming);
    const byKey = new Map(existing.map((row) => [String(row[definition.keyColumn] ?? ""), row]));
    const columns = ownedColumns ?? definition.columns;
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;

    for (const row of incoming) {
      const key = String(row[definition.keyColumn] ?? "");
      if (!key) throw new Error(`MISSING_PRIMARY_KEY:${sheetName}:${definition.keyColumn}`);
      const previous = byKey.get(key);
      if (!previous) {
        byKey.set(key, { ...row });
        inserted += 1;
        continue;
      }
      const merged = { ...previous };
      for (const column of columns) {
        if (column in row) merged[column] = row[column] ?? "";
      }
      if (JSON.stringify(merged) === JSON.stringify(previous)) unchanged += 1;
      else updated += 1;
      byKey.set(key, merged);
    }

    this.writeAll(sheetName, [...byKey.values()]);
    return { inserted, updated, unchanged };
  }

  replace<T extends SheetRecord>(sheetName: string, rows: T[]): void {
    assertRepositorySheetAccess(sheetName, "generic_write");
    this.writeAll(sheetName, rows);
  }

  appendSyncLog(row: SheetRecord): void {
    this.upsert("90_SyncLog", [row]);
  }

  preflightEnvironmentMarker(marker: string, allowMissingForExplicitInitialize = false): void {
    const sheet = this.spreadsheet.getSheetByName("99_Config");
    if (!sheet) {
      if (allowMissingForExplicitInitialize) return;
      throw new Error("SHEET_ENVIRONMENT_MARKER_MISSING");
    }
    const values = sheet.getDataRange().getValues();
    if (allowMissingForExplicitInitialize && sheet.getLastRow() === 0) return;
    const definition = definitionFor("99_Config");
    this.validateSheet(sheet, definition);
    const headers = values[0]?.map(String) ?? [];
    const keyIndex = headers.indexOf("config_key");
    const valueIndex = headers.indexOf("config_value_non_secret");
    if (keyIndex < 0 || valueIndex < 0) throw new Error("SCHEMA_MISMATCH:99_Config.headers");
    const markerRow = values.slice(1).find((row) => row[keyIndex] === "SYNC_ENVIRONMENT_MARKER");
    if (!markerRow) {
      if (allowMissingForExplicitInitialize) return;
      throw new Error("SHEET_ENVIRONMENT_MARKER_MISSING");
    }
    if (markerRow[valueIndex] !== marker) throw new Error("SHEET_ENVIRONMENT_MARKER_MISMATCH");
  }

  initializeEnvironmentMarker(marker: string, nowIso: string): void {
    const existing = this.read<SheetRecord>("99_Config")
      .find((row) => row.config_key === "SYNC_ENVIRONMENT_MARKER");
    if (existing && existing.config_value_non_secret !== marker) {
      throw new Error("SHEET_ENVIRONMENT_MARKER_MISMATCH");
    }
    if (!existing) {
      this.upsertOwnedRowsInPlace("99_Config", [{
        config_key: "SYNC_ENVIRONMENT_MARKER",
        config_value_non_secret: marker,
        description: "Ghost site / Stripe account / livemode write boundary",
        updated_at: nowIso,
        updated_by: "system",
      }], ["config_value_non_secret", "description", "updated_at"]);
    }
  }

  insertIfAbsent(sheetName: string, row: SheetRecord): boolean {
    assertRepositorySheetAccess(sheetName, "generic_write");
    const definition = definitionFor(sheetName);
    const preflight = this.preflightExistingIdentity(sheetName);
    assertRecordKeys(sheetName, definition.keyColumn, [row]);
    const key = exactRecordKey(row, definition.keyColumn);
    const existingIndex = preflight.targetRows.findIndex(
      (existing) => exactRecordKey(existing, definition.keyColumn) === key,
    );
    const prospectiveRows = existingIndex < 0
      ? [...preflight.targetRows, row]
      : preflight.targetRows.map((existing, index) => index === existingIndex ? row : existing);
    this.assertProspectiveIdentity(sheetName, prospectiveRows, preflight);
    if (existingIndex >= 0) return false;

    const headers = definition.columns;
    const appendRow = Math.max(2, preflight.sheet.getLastRow() + 1);
    ensureGridCapacity(asWritePort(preflight.sheet), appendRow, headers.length);
    preflight.sheet.getRange(appendRow, 1, 1, headers.length).setValues([
      headers.map((header) => toSafeSheetValue(row[header])),
    ]);
    return true;
  }

  /** The sole formula-authorized write path. */
  insertSupplementalIfAbsent(row: SheetRecord): boolean {
    const sheetName = "40_Supplemental";
    const definition = definitionFor(sheetName);
    const preflight = this.preflightExistingIdentity(sheetName);
    assertRecordKeys(sheetName, definition.keyColumn, [row]);
    const key = exactRecordKey(row, definition.keyColumn);
    const existingIndex = preflight.targetRows.findIndex(
      (existing) => exactRecordKey(existing, definition.keyColumn) === key,
    );
    const prospectiveRows = existingIndex < 0
      ? [...preflight.targetRows, row]
      : preflight.targetRows.map((existing, index) => index === existingIndex ? row : existing);
    this.assertProspectiveIdentity(sheetName, prospectiveRows, preflight);
    if (existingIndex >= 0) return false;

    const headers = definition.columns;
    const appendRow = Math.max(2, preflight.sheet.getLastRow() + 1);
    const next = headers.map((header) => toSafeSheetValue(row[header]));
    for (const [effective, override, form] of [
      ["effective_affiliation", "override_affiliation", "form_affiliation"],
      ["effective_title_or_role", "override_title_or_role", "form_title_or_role"],
      ["effective_participant_type", "override_participant_type", "form_participant_type"],
    ] as const) {
      const effectiveIndex = headers.indexOf(effective);
      const overrideIndex = headers.indexOf(override);
      const formIndex = headers.indexOf(form);
      if (effectiveIndex < 0 || overrideIndex < 0 || formIndex < 0) {
        throw new Error(`SCHEMA_MISMATCH:${sheetName}.${effective}`);
      }
      // These are repository-owned formulas assembled exclusively from schema
      // column indices and the numeric target row. External values were
      // escaped above and can never become formula source text. Keeping values
      // and all three formulas in one setValues call prevents a half-created
      // Supplemental row from becoming an unrecoverable idempotent no-op.
      const overrideCell = `${a1Column(overrideIndex + 1)}${appendRow}`;
      const formCell = `${a1Column(formIndex + 1)}${appendRow}`;
      next[effectiveIndex] = `=IF(${overrideCell}<>"",${overrideCell},${formCell})`;
    }
    ensureGridCapacity(asWritePort(preflight.sheet), appendRow, headers.length);
    preflight.sheet.getRange(appendRow, 1, 1, headers.length).setValues([next]);
    return true;
  }

  writeDashboard(metrics: Array<{ metric: string; value: string | number; description: string }>, nowIso: string): void {
    const definition = definitionFor("00_Dashboard");
    const required = definition.requiredMetrics ?? [];
    const actual = metrics.map(({ metric }) => metric);
    if (
      new Set(actual).size !== actual.length ||
      required.length !== actual.length ||
      required.some((metric) => !actual.includes(metric))
    ) {
      throw new Error("DASHBOARD_REQUIRED_METRICS_MISMATCH");
    }
    const sheet = this.requireSheet(definition);
    const rows = metrics.map(({ metric, value, description }) =>
      [metric, value, nowIso, description].map(toSafeSheetValue),
    );
    safelyReplaceSheetContents(asWritePort(sheet), [definition.columns, ...rows]);
  }

  private preflightExistingIdentity(sheetName: string): IdentityPreflight {
    const targetDefinition = definitionFor(sheetName);
    const targetSheet = this.requireSheet(targetDefinition);
    const targetValidationRows = this.rawRecords(targetSheet);
    const targetRows = populatedRows(targetValidationRows);

    // Surface corruption in the requested identity table before consulting
    // companion tabs. This keeps failures deterministic if several are bad.
    if (sheetName !== "40_Supplemental" && CROSS_TABLE_IDENTITY_SHEETS.has(sheetName)) {
      this.assertIdentityRows(sheetName, targetValidationRows);
    }

    if (!CROSS_TABLE_IDENTITY_SHEETS.has(sheetName)) {
      this.assertIdentityRows(sheetName, targetValidationRows);
      return { kind: "single-sheet", sheet: targetSheet, targetRows };
    }

    const rowsFor = (name: string): RawSheetRecord[] => name === sheetName
      ? targetValidationRows
      : this.rawRecords(this.requireSheet(definitionFor(name)));
    const memberRows = rowsFor("10_Members");
    const subscriptionRows = rowsFor("20_Subscriptions");
    const accessGrantRows = rowsFor("21_AccessGrants");
    const supplementalRows = rowsFor("40_Supplemental");
    const blankProfileResponseIdPolicy = persistedBlankProfileResponseIdPolicy(supplementalRows);
    assertCrossTableIdentityIntegrity({
      memberRows,
      subscriptionRows,
      accessGrantRows,
      supplementalRows,
      blankProfileResponseIdPolicy,
      ...(this.identityContext ? {
        expectedGhostSiteId: this.identityContext.ghostSiteId,
        expectedStripeContext: {
          stripeAccountId: this.identityContext.stripeAccountId,
          livemode: this.identityContext.livemode,
        },
      } : {}),
    });
    return {
      kind: "cross-table",
      sheet: targetSheet,
      targetRows,
      memberRows,
      subscriptionRows,
      accessGrantRows,
      supplementalRows,
      blankProfileResponseIdPolicy,
    };
  }

  private assertProspectiveIdentity(
    sheetName: string,
    prospectiveRows: ReadonlyArray<RawSheetRecord>,
    preflight: IdentityPreflight,
  ): void {
    if (CROSS_TABLE_IDENTITY_SHEETS.has(sheetName)) {
      if (preflight.kind !== "cross-table") throw new Error("IDENTITY_PREFLIGHT_CONTEXT_MISSING");
      assertCrossTableIdentityIntegrity({
        memberRows: sheetName === "10_Members" ? prospectiveRows : preflight.memberRows,
        subscriptionRows: sheetName === "20_Subscriptions" ? prospectiveRows : preflight.subscriptionRows,
        accessGrantRows: sheetName === "21_AccessGrants" ? prospectiveRows : preflight.accessGrantRows,
        supplementalRows: sheetName === "40_Supplemental" ? prospectiveRows : preflight.supplementalRows,
        blankProfileResponseIdPolicy: preflight.blankProfileResponseIdPolicy,
        ...(this.identityContext ? {
          expectedGhostSiteId: this.identityContext.ghostSiteId,
          expectedStripeContext: {
            stripeAccountId: this.identityContext.stripeAccountId,
            livemode: this.identityContext.livemode,
          },
        } : {}),
      });
      return;
    }
    this.assertIdentityRows(sheetName, prospectiveRows);
  }

  preflightIdentityIntegrity(): void {
    // Every cross-table identity read validates the complete graph.
    this.read<SheetRecord>("10_Members");
  }

  private assertIdentityRows(sheetName: string, rows: ReadonlyArray<RawSheetRecord>): void {
    switch (sheetName) {
      case "10_Members":
        assertMemberIdentityIntegrity(rows, this.identityContext?.ghostSiteId);
        return;
      case "20_Subscriptions":
        assertSubscriptionIdentityIntegrity(rows, this.identityContext
          ? { stripeAccountId: this.identityContext.stripeAccountId, livemode: this.identityContext.livemode }
          : undefined);
        return;
      case "21_AccessGrants":
        assertAccessGrantIdentityIntegrity(rows, this.identityContext?.ghostSiteId);
        return;
      default:
        assertPersistedIdentityRows(sheetName, rows);
    }
  }

  private rawRecords(sheet: GoogleAppsScript.Spreadsheet.Sheet): RawSheetRecord[] {
    const values = sheet.getDataRange().getValues();
    if (values.length <= 1) return [];
    const headers = values[0]?.map(String) ?? [];
    return values.slice(1).map((row) => {
      const record: RawSheetRecord = {};
      headers.forEach((header, index) => {
        record[header] = row[index];
      });
      return record;
    });
  }

  private writeAll(sheetName: string, rows: SheetRecord[]): void {
    const definition = definitionFor(sheetName);
    const preflight = this.preflightExistingIdentity(sheetName);
    assertRecordKeys(sheetName, definition.keyColumn, rows);
    this.assertProspectiveIdentity(sheetName, rows, preflight);
    const values = rows.map((row) => definition.columns.map((header) => toSafeSheetValue(row[header])));
    safelyReplaceSheetContents(asWritePort(preflight.sheet), [definition.columns, ...values]);
  }

  private initializeSheet(definition: SheetDefinition): GoogleAppsScript.Spreadsheet.Sheet {
    const sheet = this.spreadsheet.getSheetByName(definition.name) ?? this.spreadsheet.insertSheet(definition.name);
    if (sheet.getLastRow() === 0) {
      ensureGridCapacity(asWritePort(sheet), 1, definition.columns.length);
      sheet.getRange(1, 1, 1, definition.columns.length).setValues([definition.columns]);
      sheet.setFrozenRows(1);
    }
    return sheet;
  }

  private requireSheet(definition: SheetDefinition): GoogleAppsScript.Spreadsheet.Sheet {
    const sheet = this.spreadsheet.getSheetByName(definition.name);
    if (!sheet) throw new Error(`SHEET_MISSING:${definition.name}`);
    this.validateSheet(sheet, definition);
    return sheet;
  }

  private validateSheet(sheet: GoogleAppsScript.Spreadsheet.Sheet, definition: SheetDefinition): void {
    const values = sheet.getDataRange().getValues();
    const headers = values[0]?.map(String) ?? [];
    if (headers.length !== definition.columns.length ||
      definition.columns.some((column, index) => headers[index] !== column)) {
      throw new Error(`SCHEMA_MISMATCH:${definition.name}.headers`);
    }
    // Supplemental identity validation owns exact type/whitespace/uniqueness
    // errors so they remain row-specific instead of being collapsed into a
    // trimmed generic primary-key error here.
    if (definition.name === "40_Supplemental") return;
    const keyIndex = definition.columns.indexOf(definition.keyColumn);
    const keys = new Set<string>();
    for (const row of values.slice(1).filter((candidate) => candidate.some((cell) => cell !== ""))) {
      const key = String(row[keyIndex] ?? "").trim();
      if (!key) throw new Error(`MISSING_PRIMARY_KEY:${definition.name}:${definition.keyColumn}`);
      if (keys.has(key)) throw new Error(`DUPLICATE_PRIMARY_KEY:${definition.name}:${definition.keyColumn}`);
      keys.add(key);
    }
  }

  private writeNonSecretConfigNotice(): void {
    const nowIso = new Date().toISOString();
    this.upsertOwnedRowsInPlace("99_Config", [
      { config_key: "SECRET_STORAGE", config_value_non_secret: "Script Properties only", description: "秘密値をこのタブへ保存しない", updated_at: nowIso, updated_by: "system" },
      { config_key: "SCHEMA_VERSION", config_value_non_secret: "1", description: "台帳スキーマ版", updated_at: nowIso, updated_by: "system" },
    ], ["config_value_non_secret", "description", "updated_at"]);
  }

  /** Update only system-owned rows; never rewrite operator-owned Config rows. */
  upsertOwnedRowsInPlace(
    sheetName: string,
    incoming: SheetRecord[],
    ownedColumns: string[],
  ): void {
    assertRepositorySheetAccess(sheetName, "generic_write");
    const definition = definitionFor(sheetName);
    const preflight = this.preflightExistingIdentity(sheetName);
    assertRecordKeys(sheetName, definition.keyColumn, incoming);
    const prospectiveByKey = new Map(
      preflight.targetRows.map((row) => [exactRecordKey(row, definition.keyColumn), { ...row }]),
    );
    for (const record of incoming) {
      const key = exactRecordKey(record, definition.keyColumn);
      const previous = prospectiveByKey.get(key);
      if (!previous) {
        prospectiveByKey.set(key, { ...record });
        continue;
      }
      const next = { ...previous };
      for (const column of ownedColumns) {
        if (column in record) next[column] = record[column] ?? "";
      }
      prospectiveByKey.set(key, next);
    }
    this.assertProspectiveIdentity(sheetName, [...prospectiveByKey.values()], preflight);

    const sheet = preflight.sheet;
    const values = sheet.getDataRange().getValues();
    const headers = definition.columns;
    const keyIndex = headers.indexOf(definition.keyColumn);
    const rowByKey = new Map<string, number>();
    values.slice(1).forEach((row, index) => rowByKey.set(String(row[keyIndex] ?? ""), index + 2));

    let appendRow = Math.max(2, sheet.getLastRow() + 1);
    ensureGridCapacity(asWritePort(sheet), appendRow + incoming.length - 1, headers.length);
    for (const record of incoming) {
      const key = exactRecordKey(record, definition.keyColumn);
      const existingRowNumber = rowByKey.get(key);
      if (existingRowNumber) {
        const current = sheet.getRange(existingRowNumber, 1, 1, headers.length).getValues()[0] ?? [];
        const next = [...current];
        for (const column of ownedColumns) {
          const index = headers.indexOf(column);
          if (index >= 0 && column in record) next[index] = toSafeSheetValue(record[column]);
        }
        sheet.getRange(existingRowNumber, 1, 1, headers.length).setValues([next]);
      } else {
        const next = headers.map((header) => toSafeSheetValue(record[header]));
        sheet.getRange(appendRow, 1, 1, headers.length).setValues([next]);
        rowByKey.set(key, appendRow);
        appendRow += 1;
      }
    }
  }
}

function asWritePort(sheet: GoogleAppsScript.Spreadsheet.Sheet): SheetWritePort {
  return sheet as unknown as SheetWritePort;
}

function assertRepositorySheetAccess(
  sheetName: string,
  operation: "read" | "generic_write",
): void {
  if (sheetName === PROFILE_RAW_SHEET_NAME) {
    throw new Error("FORM_RAW_REPOSITORY_ACCESS_FORBIDDEN");
  }
  if (sheetName === "40_Supplemental" && operation === "generic_write") {
    throw new Error("SUPPLEMENTAL_GENERIC_WRITE_FORBIDDEN");
  }
}

function normalizeRecord(row: RawSheetRecord): SheetRecord {
  const record: SheetRecord = {};
  for (const [header, value] of Object.entries(row)) {
    record[header] = value instanceof Date ? value.toISOString() : normalizeCell(value);
  }
  return record;
}

function a1Column(oneBasedColumn: number): string {
  if (!Number.isSafeInteger(oneBasedColumn) || oneBasedColumn < 1) {
    throw new Error("INVALID_SHEET_COLUMN");
  }
  let value = oneBasedColumn;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function populatedRows(rows: ReadonlyArray<RawSheetRecord>): RawSheetRecord[] {
  return rows.filter((row) => !isBlankRecord(row));
}

function isBlankRecord(row: RawSheetRecord): boolean {
  return Object.values(row).every((value) => value === "" || value === null || value === undefined);
}

function persistedBlankProfileResponseIdPolicy(
  supplementalRows: ReadonlyArray<RawSheetRecord>,
): SupplementalBlankProfileResponseIdPolicy {
  const legacyMinhosMemberIds = new Set<string>();
  for (const row of supplementalRows) {
    if (row.profile_response_id === "" && typeof row.minhos_member_id === "string") {
      legacyMinhosMemberIds.add(row.minhos_member_id);
    }
  }
  return allowExistingBlankProfileResponseIds(legacyMinhosMemberIds);
}

function exactRecordKey(row: Readonly<Record<string, unknown>>, keyColumn: string): string {
  const value = row[keyColumn];
  return typeof value === "string" ? value : String(value ?? "");
}

function normalizeCell(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

export function toSafeSheetValue(value: unknown): string | number | boolean {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return escapeFormulaLikeString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  return escapeFormulaLikeString(JSON.stringify(value));
}

function escapeFormulaLikeString(value: string): string {
  const detectionValue = value.replace(/^[\s\uFEFF\u200B-\u200D\u2060]+/u, "");
  return /^[=+\-@]/u.test(detectionValue) ? `'${value}` : value;
}

function assertRecordKeys(
  sheetName: string,
  keyColumn: string,
  rows: ReadonlyArray<SheetRecord>,
): void {
  const keys = new Set<string>();
  rows.forEach((row, index) => {
    const rawKey = row[keyColumn];
    if (sheetName === "40_Supplemental") {
      const rowNumber = index + 2;
      if (typeof rawKey !== "string") {
        throw new Error(`IDENTITY_INTEGRITY:40_Supplemental:row_${rowNumber}:MINHOS_MEMBER_ID_NON_STRING`);
      }
      if (!rawKey.trim()) {
        throw new Error(`IDENTITY_INTEGRITY:40_Supplemental:row_${rowNumber}:MINHOS_MEMBER_ID_BLANK`);
      }
      if (rawKey !== rawKey.trim()) {
        throw new Error(`IDENTITY_INTEGRITY:40_Supplemental:row_${rowNumber}:MINHOS_MEMBER_ID_WHITESPACE`);
      }
    }
    const key = String(rawKey ?? "").trim();
    if (!key) throw new Error(`MISSING_PRIMARY_KEY:${sheetName}:${keyColumn}`);
    if (keys.has(key)) {
      if (sheetName === "40_Supplemental") {
        throw new Error(
          `IDENTITY_INTEGRITY:40_Supplemental:row_${index + 2}:DUPLICATE_MINHOS_MEMBER_ID`,
        );
      }
      throw new Error(`DUPLICATE_PRIMARY_KEY:${sheetName}:${keyColumn}`);
    }
    keys.add(key);
  });
}
