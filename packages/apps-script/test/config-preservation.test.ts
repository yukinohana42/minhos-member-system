import { describe, expect, it } from "vitest";
import { SheetsRepository } from "../src/adapters/sheets-repository";
import { definitionFor } from "../src/adapters/sheet-schema";
import { FakeSheet, FakeSpreadsheet } from "./helpers/fake-spreadsheet";

describe("99_Config ownership", () => {
  it("initialize preserves every canonical 99_Config operator row", () => {
    const spreadsheet = new FakeSpreadsheet();
    const configSheet = new FakeSheet("99_Config");
    const headers = definitionFor("99_Config").columns;
    const operatorRows = [
      ["GHOST_STAFF_COUNT_MANUAL", 2, "manual staff count", "2026-08-01T00:00:00.000Z", "owner@example.invalid"],
      ["GHOST_PENDING_INVITATION_COUNT_MANUAL", 1, "manual pending count", "2026-08-02T00:00:00.000Z", "admin@example.invalid"],
    ];
    const existingNotice = ["SECRET_STORAGE", "old notice", "old description", "2026-01-01T00:00:00.000Z", "preserve-this-actor"];
    configSheet.seed([headers, ...operatorRows, existingNotice]);
    spreadsheet.sheets.set("99_Config", configSheet);

    new SheetsRepository(
      "injected-test-sheet",
      spreadsheet as unknown as GoogleAppsScript.Spreadsheet.Spreadsheet,
    ).initialize();

    const rows = configSheet.matrix();
    expect(rows.slice(1, 3)).toEqual(operatorRows);
    expect(rows.find((row) => row[0] === "SECRET_STORAGE")?.[4]).toBe("preserve-this-actor");
    expect(rows.some((row) => row[0] === "SCHEMA_VERSION")).toBe(true);
    expect(configSheet.operations).not.toContain("clearContents");

    const repository = new SheetsRepository(
      "injected-test-sheet",
      spreadsheet as unknown as GoogleAppsScript.Spreadsheet.Spreadsheet,
    );
    repository.initializeEnvironmentMarker("marker_a", "2026-08-28T00:00:00.000Z");
    repository.preflightEnvironmentMarker("marker_a");
    const operationsBeforeMismatch = [...configSheet.operations];
    expect(() => repository.preflightEnvironmentMarker("marker_b"))
      .toThrow("SHEET_ENVIRONMENT_MARKER_MISMATCH");
    expect(configSheet.operations).toEqual(operationsBeforeMismatch);
  });

  it("performs a read-only marker preflight before explicit initialization", () => {
    const missing = new FakeSpreadsheet();
    const missingRepository = new SheetsRepository(
      "injected-test-sheet",
      missing as unknown as GoogleAppsScript.Spreadsheet.Spreadsheet,
    );
    missingRepository.preflightEnvironmentMarker("marker_a", true);
    expect(missing.sheets.size).toBe(0);

    const spreadsheet = new FakeSpreadsheet();
    const configSheet = new FakeSheet("99_Config");
    configSheet.seed([
      definitionFor("99_Config").columns,
      ["SYNC_ENVIRONMENT_MARKER", "marker_existing", "boundary", "2026-08-01T00:00:00.000Z", "system"],
    ]);
    spreadsheet.sheets.set("99_Config", configSheet);
    const repository = new SheetsRepository(
      "injected-test-sheet",
      spreadsheet as unknown as GoogleAppsScript.Spreadsheet.Spreadsheet,
    );
    const before = [...configSheet.operations];
    expect(() => repository.preflightEnvironmentMarker("marker_other", true))
      .toThrow("SHEET_ENVIRONMENT_MARKER_MISMATCH");
    expect(configSheet.operations).toEqual(before);
    expect(spreadsheet.sheets.size).toBe(1);
  });
});
