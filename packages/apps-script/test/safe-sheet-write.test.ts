import { describe, expect, it } from "vitest";
import { safelyReplaceSheetContents, type SheetWritePort } from "../src/adapters/safe-sheet-write";
import { FakeSheet } from "./helpers/fake-spreadsheet";

describe("safe Sheets replacement", () => {
  it("expands grid before a wide 1000-row-plus write", () => {
    const sheet = new FakeSheet("wide");
    sheet.seed([["old_header"], ["old_value"]]);
    const matrix = Array.from({ length: 1002 }, (_, row) =>
      Array.from({ length: 40 }, (_, column) => `${row}:${column}`),
    );

    safelyReplaceSheetContents(sheet as unknown as SheetWritePort, matrix);

    const clearIndex = sheet.operations.indexOf("clearContents");
    expect(sheet.operations.findIndex((item) => item.startsWith("insertRows:"))).toBeLessThan(clearIndex);
    expect(sheet.operations.findIndex((item) => item.startsWith("insertColumns:"))).toBeLessThan(clearIndex);
    expect(sheet.getMaxRows()).toBeGreaterThanOrEqual(1002);
    expect(sheet.getMaxColumns()).toBeGreaterThanOrEqual(40);
    expect(sheet.cell(1002, 40)).toBe("1001:39");
  });

  it("preserves previous contents when the replacement write fails", () => {
    const sheet = new FakeSheet("rollback");
    const previous = [["key", "value"], ["operator", "keep me"], ["formula", "=1+1"]];
    sheet.seed(previous);
    sheet.failNextSetValues = true;

    expect(() => safelyReplaceSheetContents(
      sheet as unknown as SheetWritePort,
      [["key", "value"], ["new", "do not retain"]],
    )).toThrow("simulated write failure");

    expect(sheet.matrix()).toEqual(previous);
    expect(sheet.operations.filter((item) => item === "clearContents")).toHaveLength(2);
  });
});
