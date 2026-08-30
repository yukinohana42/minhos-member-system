import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PROFILE_RAW_SHEET_CONTRACT,
  SHEET_DEFINITIONS,
} from "../src/adapters/sheet-schema";

interface CanonicalSchema {
  tabs: Array<{
    name: string;
    primaryKey: string | null;
    columns: string[];
    schemaMode?: string;
    owner?: string;
    writeMode?: string;
    nativeContract?: Record<string, unknown>;
    requiredMetrics?: string[];
  }>;
}

describe("canonical Sheets schema alignment", () => {
  it("matches every managed tab and keeps the Form-owned RAW tab native and opaque", () => {
    const path = fileURLToPath(new URL("../../../config/sheets-schema.json", import.meta.url));
    const canonical = JSON.parse(readFileSync(path, "utf8")) as CanonicalSchema;
    const managedTabs = canonical.tabs.filter(({ name }) => name !== PROFILE_RAW_SHEET_CONTRACT.name);
    const raw = canonical.tabs.find(({ name }) => name === PROFILE_RAW_SHEET_CONTRACT.name);

    expect(SHEET_DEFINITIONS.map(({ name, primaryKey, columns }) => ({ name, primaryKey, columns }))).toEqual(
      managedTabs.map(({ name, primaryKey, columns }) => ({ name, primaryKey, columns })),
    );
    expect(SHEET_DEFINITIONS.some(({ name }) => name === PROFILE_RAW_SHEET_CONTRACT.name)).toBe(false);
    expect(raw).toMatchObject(PROFILE_RAW_SHEET_CONTRACT);
    expect(raw?.primaryKey).toBeNull();
    expect(raw?.columns).toEqual([]);
    expect(raw?.nativeContract?.responseIdColumn).toBe(false);
    expect(raw?.nativeContract?.responseIdSource).toBe("FormResponse.getId()");
    expect(raw?.nativeContract?.responseIdTarget).toBe("40_Supplemental.profile_response_id");
    expect(SHEET_DEFINITIONS.find(({ name }) => name === "00_Dashboard")?.requiredMetrics).toEqual(
      canonical.tabs.find(({ name }) => name === "00_Dashboard")?.requiredMetrics,
    );
  });
});
