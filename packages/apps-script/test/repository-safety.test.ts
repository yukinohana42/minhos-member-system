import { describe, expect, it } from "vitest";
import {
  DASHBOARD_REQUIRED_METRICS,
  definitionFor,
  PROFILE_RAW_SHEET_NAME,
  SHEET_DEFINITIONS,
} from "../src/adapters/sheet-schema";
import { SheetsRepository, toSafeSheetValue } from "../src/adapters/sheets-repository";
import type { SheetRecord } from "../src/domain/types";
import { FakeSheet, FakeSpreadsheet } from "./helpers/fake-spreadsheet";

describe("Sheets repository fail-closed boundary", () => {
  it("never auto-creates a missing tab outside explicit initialize", () => {
    const spreadsheet = new FakeSpreadsheet();
    const repository = injectedRepository(spreadsheet);

    expect(() => repository.read<SheetRecord>("10_Members")).toThrow("SHEET_MISSING:10_Members");
    expect(() => repository.replace("10_Members", [])).toThrow("SHEET_MISSING:10_Members");
    expect(spreadsheet.sheets.size).toBe(0);

    repository.initialize();
    expect([...spreadsheet.sheets.keys()].sort()).toEqual(
      SHEET_DEFINITIONS.map(({ name }) => name).sort(),
    );
    expect(spreadsheet.getSheetByName(PROFILE_RAW_SHEET_NAME)).toBeNull();
  });

  it("rejects header drift and preserves the existing member ID/table byte-for-byte", () => {
    const spreadsheet = new FakeSpreadsheet();
    const sheet = new FakeSheet("10_Members");
    const headers = [...definitionFor("10_Members").columns];
    headers[1] = "drifted_member_id_header";
    const existing = headers.map(() => "");
    existing[0] = "ghost:site:gm_1";
    existing[1] = "mm_existing_never_reissue";
    sheet.seed([headers, existing]);
    spreadsheet.sheets.set("10_Members", sheet);
    const before = sheet.matrix();
    const operationsBefore = [...sheet.operations];

    const repository = injectedRepository(spreadsheet);
    expect(() => repository.read<SheetRecord>("10_Members")).toThrow("SCHEMA_MISMATCH:10_Members.headers");
    expect(() => repository.upsert("10_Members", [{
      member_row_key: "ghost:site:gm_1", minhos_member_id: "mm_new_must_not_write",
    }])).toThrow("SCHEMA_MISMATCH:10_Members.headers");
    expect(sheet.matrix()).toEqual(before);
    expect(sheet.operations).toEqual(operationsBefore);
  });

  it("rejects empty or duplicate persisted and incoming primary keys without clearing data", () => {
    for (const keys of [["", "valid"], ["duplicate", "duplicate"]]) {
      const spreadsheet = new FakeSpreadsheet();
      const sheet = new FakeSheet("10_Members");
      const headers = definitionFor("10_Members").columns;
      const rows = keys.map((key) => headers.map((header) => header === "member_row_key" ? key : "preserve"));
      sheet.seed([headers, ...rows]);
      spreadsheet.sheets.set("10_Members", sheet);
      const before = sheet.matrix();
      expect(() => injectedRepository(spreadsheet).read<SheetRecord>("10_Members"))
        .toThrow(keys[0] ? "DUPLICATE_PRIMARY_KEY" : "MISSING_PRIMARY_KEY");
      expect(sheet.matrix()).toEqual(before);
      expect(sheet.operations).toEqual([]);
    }

    const spreadsheet = new FakeSpreadsheet();
    const repository = injectedRepository(spreadsheet);
    repository.initialize();
    expect(() => repository.upsert("10_Members", [
      { member_row_key: "same" }, { member_row_key: "same" },
    ])).toThrow("DUPLICATE_PRIMARY_KEY:10_Members:member_row_key");
  });

  it("rejects every generic Supplemental write and every repository API for the Form-owned RAW tab without mutation", () => {
    const spreadsheet = new FakeSpreadsheet();
    const raw = new FakeSheet(PROFILE_RAW_SHEET_NAME, 1000, 40);
    raw.seed([
      ["タイムスタンプ", "Ghost登録メールアドレス", "参加区分", "後から追加された設問"],
      ["2026/08/28 09:00:00", "member@example.invalid", "参加者", "native value"],
    ]);
    spreadsheet.sheets.set(PROFILE_RAW_SHEET_NAME, raw);
    const beforeRaw = raw.matrix();
    const repository = injectedRepository(spreadsheet);
    repository.initialize();
    const supplemental = spreadsheet.sheets.get("40_Supplemental")!;
    const beforeSupplemental = supplemental.matrix();
    const beforeSupplementalOperations = [...supplemental.operations];
    const genericSupplementalWrites: Array<() => unknown> = [
      () => repository.insertIfAbsent("40_Supplemental", {
        minhos_member_id: "mm_1", ghost_member_id: "gm_1", profile_response_id: "response_1",
      }),
      () => repository.upsert("40_Supplemental", [{
        minhos_member_id: "mm_1", ghost_member_id: "gm_1", profile_response_id: "response_1",
      }]),
      () => repository.replace("40_Supplemental", []),
      () => repository.upsertOwnedRowsInPlace("40_Supplemental", [{
        minhos_member_id: "mm_1", ghost_member_id: "gm_1", profile_response_id: "response_1",
      }], ["profile_response_id"]),
    ];
    for (const write of genericSupplementalWrites) {
      expect(write).toThrow("SUPPLEMENTAL_GENERIC_WRITE_FORBIDDEN");
    }
    expect(supplemental.matrix()).toEqual(beforeSupplemental);
    expect(supplemental.operations).toEqual(beforeSupplementalOperations);

    const rawRepositoryApis: Array<() => unknown> = [
      () => repository.read(PROFILE_RAW_SHEET_NAME),
      () => repository.insertIfAbsent(PROFILE_RAW_SHEET_NAME, { response_id: "response_1" }),
      () => repository.upsert(PROFILE_RAW_SHEET_NAME, [{ response_id: "response_1" }]),
      () => repository.replace(PROFILE_RAW_SHEET_NAME, []),
      () => repository.upsertOwnedRowsInPlace(PROFILE_RAW_SHEET_NAME, [{ response_id: "response_1" }], ["response_id"]),
    ];
    for (const api of rawRepositoryApis) {
      expect(api).toThrow("FORM_RAW_REPOSITORY_ACCESS_FORBIDDEN");
    }
    expect(raw.matrix()).toEqual(beforeRaw);
    expect(raw.operations).toEqual([]);
    expect(supplemental.matrix()).toEqual(beforeSupplemental);
    expect(supplemental.operations).toEqual(beforeSupplementalOperations);
  });
});

describe("formula injection prevention", () => {
  it("escapes every dangerous prefix after whitespace/BOM normalization", () => {
    for (const value of ["=cmd", "+cmd", "-cmd", "@cmd", "  =cmd", "\uFEFF+cmd", "\u200B-cmd", "\n@cmd"]) {
      expect(toSafeSheetValue(value)).toBe(`'${value}`);
    }
    expect(toSafeSheetValue("safe text")).toBe("safe text");
    expect(toSafeSheetValue(-100)).toBe(-100);
  });

  it("applies escaping to replace/upsert/append/in-place/Form and Dashboard write paths", () => {
    const spreadsheet = new FakeSpreadsheet();
    const repository = injectedRepository(spreadsheet);
    repository.initialize();

    repository.replace("10_Members", [{
      member_row_key: "ghost:site:gm_1", minhos_member_id: "member_1", ghost_site_id: "site",
      ghost_member_id: "gm_1", email: "=IMPORTDATA(1)",
    }, {
      member_row_key: "ghost:site:gm_2", minhos_member_id: "member_2", ghost_site_id: "site",
      ghost_member_id: "gm_2",
    }]);
    const members = spreadsheet.sheets.get("10_Members")!;
    expect(members.cell(2, definitionFor("10_Members").columns.indexOf("email") + 1)).toBe("'=IMPORTDATA(1)");

    repository.upsert("10_Members", [{ member_row_key: "ghost:site:gm_1", name: "  +SUM(1,1)" }]);
    expect(members.cell(2, definitionFor("10_Members").columns.indexOf("name") + 1)).toBe("'  +SUM(1,1)");

    repository.appendSyncLog({ run_id: "run_1", error_summary: "@malicious" });
    const syncLog = spreadsheet.sheets.get("90_SyncLog")!;
    expect(syncLog.cell(2, definitionFor("90_SyncLog").columns.indexOf("error_summary") + 1)).toBe("'@malicious");

    repository.insertIfAbsent("10_Members", {
      member_row_key: "ghost:site:gm_1", minhos_member_id: "member_1",
      ghost_site_id: "site", ghost_member_id: "gm_1",
    });
    repository.insertSupplementalIfAbsent({
      minhos_member_id: "member_1", ghost_member_id: "gm_1", profile_response_id: "response_1",
      form_affiliation: "\uFEFF=HYPERLINK(1)",
    });
    const supplemental = spreadsheet.sheets.get("40_Supplemental")!;
    expect(supplemental.cell(2, definitionFor("40_Supplemental").columns.indexOf("form_affiliation") + 1))
      .toBe("'\uFEFF=HYPERLINK(1)");

    repository.insertSupplementalIfAbsent({
      minhos_member_id: "member_2", ghost_member_id: "gm_2", profile_response_id: "response_2",
      form_affiliation: "+unsafe",
      form_title_or_role: "safe", form_participant_type: "safe",
      effective_affiliation: "=attacker-controlled",
    });
    const supplementalColumns = definitionFor("40_Supplemental").columns;
    expect(supplemental.cell(3, supplementalColumns.indexOf("form_affiliation") + 1)).toBe("'+unsafe");
    expect(supplemental.cell(3, supplementalColumns.indexOf("effective_affiliation") + 1))
      .toBe('=IF(J3<>"",J3,G3)');
    const insertedValues = supplemental.setValuesPayloads.find((matrix) =>
      matrix[0]?.[supplementalColumns.indexOf("profile_response_id")] === "response_2");
    expect(insertedValues?.[0]?.[supplementalColumns.indexOf("effective_affiliation")])
      .toBe('=IF(J3<>"",J3,G3)');
    expect(insertedValues?.[0]?.[supplementalColumns.indexOf("override_affiliation")]).toBe("");
    expect(supplemental.operations.filter((operation) => operation.startsWith("setFormulaR1C1:")))
      .toHaveLength(0);

    repository.upsertOwnedRowsInPlace("99_Config", [{
      config_key: "SYSTEM_TEST", description: "-formula",
    }], ["description"]);
    const config = spreadsheet.sheets.get("99_Config")!;
    const configRows = config.matrix();
    const configDescriptionIndex = definitionFor("99_Config").columns.indexOf("description");
    expect(configRows.find((row) => row[0] === "SYSTEM_TEST")?.[configDescriptionIndex]).toBe("'-formula");

    repository.writeDashboard(DASHBOARD_REQUIRED_METRICS.map((metric, index) => ({
      metric,
      value: index === 0 ? "=1+1" : 0,
      description: index === 1 ? " @evil" : "safe",
    })), "2026-08-28T00:00:00.000Z");
    const dashboard = spreadsheet.sheets.get("00_Dashboard")!;
    expect(dashboard.cell(2, 2)).toBe("'=1+1");
    expect(dashboard.cell(3, 4)).toBe("' @evil");
  });
});

function injectedRepository(spreadsheet: FakeSpreadsheet): SheetsRepository {
  return new SheetsRepository(
    "injected-test-sheet",
    spreadsheet as unknown as GoogleAppsScript.Spreadsheet.Spreadsheet,
  );
}
