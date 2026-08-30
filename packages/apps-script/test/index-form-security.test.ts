import { afterEach, describe, expect, it, vi } from "vitest";
import {
  definitionFor,
  PROFILE_RAW_SHEET_NAME,
  SHEET_DEFINITIONS,
} from "../src/adapters/sheet-schema";
import { loadConfig } from "../src/config";
import { profileRetryPropertyName, type ProfileRetryItem } from "../src/domain/profile-retry";
import { profileRetrySuccessorPropertyName } from "../src/domain/profile-retry-successor";
import { environmentMarker, environmentNamespace } from "../src/domain/sync-context";
import { installMinhosTriggers, onProfileFormSubmit, retryProfileFormSubmissions } from "../src/index";
import { FakeSheet, FakeSpreadsheet } from "./helpers/fake-spreadsheet";

const FORM_ID = "form_expected";
const SPREADSHEET_ID = "spreadsheet_expected";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Form entrypoint trust boundary", () => {
  it.each([
    ["missing UID", undefined, exactFormTrigger("uid_exact")],
    ["unknown UID", "uid_unknown", exactFormTrigger("uid_exact")],
    ["wrong event tuple", "uid_wrong", trigger("uid_wrong", "onProfileFormSubmit", "CLOCK", "CLOCK", "")],
    ["wrong Form source tuple", "uid_wrong", trigger("uid_wrong", "onProfileFormSubmit", "ON_FORM_SUBMIT", "FORMS", "other_form")],
  ])("rejects %s before any Spreadsheet or property mutation", (_label, triggerUid, installed) => {
    const harness = installGlobals([installed]);
    expect(() => onProfileFormSubmit({
      response: response("response_1"),
      source: formSource(),
      ...(triggerUid ? { triggerUid } : {}),
    })).toThrow(/INSTALLABLE_TRIGGER_/);

    expect(harness.openSpreadsheet).not.toHaveBeenCalled();
    expect(harness.properties.setProperty).not.toHaveBeenCalled();
    expect(harness.properties.deleteProperty).not.toHaveBeenCalled();
  });

  it("rejects a destination mismatch before opening or writing the Spreadsheet", () => {
    const installed = exactFormTrigger("uid_exact");
    const harness = installGlobals([installed]);
    expect(() => onProfileFormSubmit({
      triggerUid: "uid_exact",
      response: response("response_1"),
      source: formSource({ destinationId: "wrong_spreadsheet" }),
    })).toThrow("PROFILE_FORM_DESTINATION_MISMATCH");

    expect(harness.openSpreadsheet).not.toHaveBeenCalled();
    expect(harness.properties.setProperty).not.toHaveBeenCalled();
  });

  it("durably queues and schedules a trusted event when the native RAW tab is missing", () => {
    const harness = installGlobals([exactFormTrigger("uid_exact")], { rawSheetExists: false });
    expect(() => onProfileFormSubmit({
      triggerUid: "uid_exact",
      response: response("response_1"),
      source: formSource(),
    })).toThrow("PROFILE_RAW_SHEET_MISSING");

    expect(harness.openSpreadsheet).toHaveBeenCalledWith(SPREADSHEET_ID);
    expect(harness.properties.setProperty).toHaveBeenCalledWith(
      expect.stringContaining("PROFILE_FORM_RETRY_QUEUE_JSON:"),
      expect.stringContaining("response_1"),
    );
    expect(harness.properties.deleteProperty).not.toHaveBeenCalled();
    expect(harness.lifecycle).toContain("create:retryProfileFormSubmissions");
    expect(harness.properties.setProperty).toHaveBeenCalledWith(
      expect.stringContaining("PROFILE_FORM_RETRY_SUCCESSOR_UID:"),
      "uid_created_1",
    );
  });

  it("rejects a non-CLOCK retry trigger before reading Form or Spreadsheet state", () => {
    const installed = trigger("uid_wrong", "retryProfileFormSubmissions", "ON_FORM_SUBMIT", "FORMS", FORM_ID);
    const harness = installGlobals([installed]);
    expect(() => retryProfileFormSubmissions({ triggerUid: "uid_wrong" }))
      .toThrow("INSTALLABLE_TRIGGER_IDENTITY_MISMATCH");
    expect(harness.openForm).not.toHaveBeenCalled();
    expect(harness.openSpreadsheet).not.toHaveBeenCalled();
    expect(harness.properties.setProperty).not.toHaveBeenCalled();
  });

  it("creates C when marked B overlaps running A, before a later preflight failure", () => {
    const item: ProfileRetryItem = {
      formId: FORM_ID,
      responseId: "response_queued",
      queuedAt: "2026-08-28T00:00:00.000Z",
    };
    const harness = installGlobals([
      exactRetryTrigger("uid_a"),
      exactRetryTrigger("uid_b"),
    ], {
      mutableTriggers: true,
      rawSheetExists: false,
      retryQueueItem: item,
      successorUid: "uid_b",
    });

    expect(() => retryProfileFormSubmissions({ triggerUid: "uid_b" }))
      .toThrow("PROFILE_RAW_SHEET_MISSING");
    expect(harness.lifecycle).toContain("create:retryProfileFormSubmissions");
    expect(harness.propertyValues()[harness.successorPropertyName]).toBe("uid_created_1");
    expect(harness.currentTriggers()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        uniqueId: "uid_created_1",
        handlerFunction: "retryProfileFormSubmissions",
        eventType: "CLOCK",
        triggerSource: "CLOCK",
      }),
    ]));
  });

  it("preserves the durable queue and created exact successor when marker setProperty throws", () => {
    const item: ProfileRetryItem = {
      formId: FORM_ID,
      responseId: "response_set_failure",
      queuedAt: "2026-08-28T00:00:00.000Z",
    };
    const harness = installGlobals([
      exactRetryTrigger("uid_a"),
      exactRetryTrigger("uid_b"),
    ], {
      mutableTriggers: true,
      retryQueueItem: item,
      successorUid: "uid_b",
      successorWriteFailure: "throw",
    });

    expect(() => retryProfileFormSubmissions({ triggerUid: "uid_b" }))
      .toThrow("SIMULATED_SUCCESSOR_MARKER_SET_FAILURE");
    expect(harness.propertyValues()[harness.retryQueuePropertyName(item)])
      .toBe(JSON.stringify(item));
    expect(harness.propertyValues()[harness.successorPropertyName]).toBe("uid_b");
    expect(harness.lifecycle).toEqual(["create:retryProfileFormSubmissions"]);
    expect(harness.currentTriggers()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        uniqueId: "uid_created_1",
        handlerFunction: "retryProfileFormSubmissions",
        eventType: "CLOCK",
        triggerSource: "CLOCK",
        triggerSourceId: "",
      }),
    ]));
  });

  it("preserves the durable queue and created exact successor when marker read-back mismatches", () => {
    const item: ProfileRetryItem = {
      formId: FORM_ID,
      responseId: "response_read_back_failure",
      queuedAt: "2026-08-28T00:00:00.000Z",
    };
    const harness = installGlobals([
      exactRetryTrigger("uid_a"),
      exactRetryTrigger("uid_b"),
    ], {
      mutableTriggers: true,
      retryQueueItem: item,
      successorUid: "uid_b",
      successorWriteFailure: "read_back_mismatch",
    });

    expect(() => retryProfileFormSubmissions({ triggerUid: "uid_b" }))
      .toThrow("PROFILE_RETRY_SUCCESSOR_WRITE_NOT_DURABLE");
    expect(harness.propertyValues()[harness.retryQueuePropertyName(item)])
      .toBe(JSON.stringify(item));
    expect(harness.propertyValues()[harness.successorPropertyName]).toBe("uid_b");
    expect(harness.lifecycle).toEqual(["create:retryProfileFormSubmissions"]);
    expect(harness.currentTriggers()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        uniqueId: "uid_created_1",
        handlerFunction: "retryProfileFormSubmissions",
        eventType: "CLOCK",
        triggerSource: "CLOCK",
        triggerSourceId: "",
      }),
    ]));
  });
});

describe("managed trigger installation", () => {
  it("accepts variable Google Forms native headers without inspecting or mutating RAW cells", () => {
    const harness = installGlobals([
      trigger("uid_hourly", "hourlySync", "CLOCK", "CLOCK", ""),
      trigger("uid_nightly", "nightlySync", "CLOCK", "CLOCK", ""),
      trigger("uid_daily", "dailyBackup", "CLOCK", "CLOCK", ""),
      trigger("uid_monthly", "monthlyBackup", "CLOCK", "CLOCK", ""),
      exactFormTrigger("uid_form"),
    ]);
    const raw = harness.spreadsheet.sheets.get(PROFILE_RAW_SHEET_NAME)!;
    const before = raw.matrix();

    installMinhosTriggers();

    expect(raw.matrix()).toEqual(before);
    expect(raw.operations).toEqual([]);
    expect(harness.lifecycle).toEqual([]);
  });

  it("creates a missing exact tuple before deleting stale same-handler triggers", () => {
    const stale = trigger("uid_stale", "hourlySync", "ON_FORM_SUBMIT", "FORMS", "other_form");
    const installed = [
      stale,
      trigger("uid_nightly", "nightlySync", "CLOCK", "CLOCK", ""),
      trigger("uid_daily", "dailyBackup", "CLOCK", "CLOCK", ""),
      trigger("uid_monthly", "monthlyBackup", "CLOCK", "CLOCK", ""),
      exactFormTrigger("uid_form"),
    ];
    const harness = installGlobals(installed, { mutableTriggers: true });

    installMinhosTriggers();

    expect(harness.lifecycle).toEqual(["create:hourlySync", "delete:uid_stale"]);
    expect(harness.currentTriggers()).toEqual(expect.arrayContaining([
      expect.objectContaining({ handlerFunction: "hourlySync", eventType: "CLOCK", triggerSource: "CLOCK" }),
    ]));
    expect(harness.currentTriggers().filter((candidate) => candidate.handlerFunction === "hourlySync"))
      .toHaveLength(1);
  });

  it("does not delete any existing trigger when replacement creation fails", () => {
    const stale = trigger("uid_stale", "hourlySync", "ON_FORM_SUBMIT", "FORMS", "other_form");
    const harness = installGlobals([stale], { mutableTriggers: true, failCreateHandler: "hourlySync" });

    expect(() => installMinhosTriggers()).toThrow("SIMULATED_TRIGGER_CREATE_FAILURE");
    expect(harness.lifecycle).toEqual(["create_failed:hourlySync"]);
    expect(harness.currentTriggers()).toContainEqual(expect.objectContaining({
      uniqueId: stale.uniqueId,
      handlerFunction: stale.handlerFunction,
      eventType: stale.eventType,
      triggerSource: stale.triggerSource,
      triggerSourceId: stale.triggerSourceId,
    }));
  });

  it("fails destination/RAW preflight without creating or deleting triggers", () => {
    const harness = installGlobals([], {
      mutableTriggers: true,
      formDestinationId: "wrong_spreadsheet",
    });
    expect(() => installMinhosTriggers()).toThrow("PROFILE_FORM_DESTINATION_MISMATCH");
    expect(harness.lifecycle).toEqual([]);
  });

  it("fails an environment marker mismatch before creating or deleting triggers", () => {
    const harness = installGlobals([], {
      mutableTriggers: true,
      environmentMarkerValue: "wrong_environment",
    });
    expect(() => installMinhosTriggers()).toThrow("SHEET_ENVIRONMENT_MARKER_MISMATCH");
    expect(harness.lifecycle).toEqual([]);
  });
});

interface FakeTrigger {
  handlerFunction: string;
  uniqueId: string;
  eventType: string;
  triggerSource: string;
  triggerSourceId: string;
  getHandlerFunction(): string;
  getUniqueId(): string;
  getEventType(): string;
  getTriggerSource(): string;
  getTriggerSourceId(): string;
}

function trigger(
  uniqueId: string,
  handlerFunction: string,
  eventType: string,
  triggerSource: string,
  triggerSourceId: string,
): FakeTrigger {
  return {
    handlerFunction,
    uniqueId,
    eventType,
    triggerSource,
    triggerSourceId,
    getHandlerFunction: () => handlerFunction,
    getUniqueId: () => uniqueId,
    getEventType: () => eventType,
    getTriggerSource: () => triggerSource,
    getTriggerSourceId: () => triggerSourceId,
  };
}

function exactFormTrigger(uniqueId: string): FakeTrigger {
  return trigger(uniqueId, "onProfileFormSubmit", "ON_FORM_SUBMIT", "FORMS", FORM_ID);
}

function exactRetryTrigger(uniqueId: string): FakeTrigger {
  return trigger(uniqueId, "retryProfileFormSubmissions", "CLOCK", "CLOCK", "");
}

function formSource(overrides: { destinationId?: string } = {}) {
  return {
    getId: () => FORM_ID,
    getDestinationType: () => "SPREADSHEET",
    getDestinationId: () => overrides.destinationId ?? SPREADSHEET_ID,
    getResponses: () => [],
  };
}

function response(responseId: string) {
  return {
    getId: () => responseId,
    getTimestamp: () => new Date("2026-08-28T00:00:00.000Z"),
    getItemResponses: () => [],
  };
}

function installGlobals(
  initialTriggers: FakeTrigger[],
  options: {
    mutableTriggers?: boolean;
    rawSheetExists?: boolean;
    formDestinationId?: string;
    failCreateHandler?: string;
    environmentMarkerValue?: string;
    retryQueueItem?: ProfileRetryItem;
    successorUid?: string;
    successorWriteFailure?: "throw" | "read_back_mismatch";
  } = {},
) {
  const values = configValues();
  const store = new Map(Object.entries(values));
  let successorPropertyName = "";
  const properties = {
    getProperty: vi.fn((name: string) => store.get(name) ?? null),
    getProperties: vi.fn(() => Object.fromEntries(store)),
    setProperty: vi.fn((name: string, value: string) => {
      if (name === successorPropertyName && options.successorWriteFailure === "throw") {
        throw new Error("SIMULATED_SUCCESSOR_MARKER_SET_FAILURE");
      }
      if (name === successorPropertyName && options.successorWriteFailure === "read_back_mismatch") {
        return;
      }
      store.set(name, value);
    }),
    deleteProperty: vi.fn((name: string) => { store.delete(name); }),
  };
  const lifecycle: string[] = [];
  const triggers = [...initialTriggers];
  let nextId = 1;
  const loadedConfig = loadConfig(properties as unknown as GoogleAppsScript.Properties.Properties);
  const namespace = environmentNamespace(loadedConfig);
  successorPropertyName = profileRetrySuccessorPropertyName(namespace);
  if (options.retryQueueItem) {
    store.set(
      profileRetryPropertyName(options.retryQueueItem, namespace),
      JSON.stringify(options.retryQueueItem),
    );
  }
  if (options.successorUid) store.set(successorPropertyName, options.successorUid);

  const spreadsheet = configuredFakeSpreadsheet(
    options.rawSheetExists !== false,
    options.environmentMarkerValue ?? environmentMarker(loadedConfig),
  );
  const openSpreadsheet = vi.fn(() => spreadsheet);
  const source = formSource(options.formDestinationId === undefined
    ? {}
    : { destinationId: options.formDestinationId });
  const openForm = vi.fn(() => source);

  vi.stubGlobal("PropertiesService", { getScriptProperties: () => properties });
  vi.stubGlobal("LockService", {
    getScriptLock: () => ({ tryLock: () => true, releaseLock: () => undefined }),
  });
  vi.stubGlobal("FormApp", {
    DestinationType: { SPREADSHEET: "SPREADSHEET" },
    openById: openForm,
  });
  vi.stubGlobal("SpreadsheetApp", { openById: openSpreadsheet });
  vi.stubGlobal("ScriptApp", {
    EventType: { CLOCK: "CLOCK", ON_FORM_SUBMIT: "ON_FORM_SUBMIT" },
    TriggerSource: { CLOCK: "CLOCK", FORMS: "FORMS" },
    getProjectTriggers: vi.fn(() => [...triggers]),
    deleteTrigger: vi.fn((candidate: FakeTrigger) => {
      lifecycle.push(`delete:${candidate.uniqueId}`);
      const index = triggers.findIndex((item) => item.uniqueId === candidate.uniqueId);
      if (index >= 0) triggers.splice(index, 1);
    }),
    newTrigger: vi.fn((handlerFunction: string) => triggerBuilder(handlerFunction)),
  });

  function triggerBuilder(handlerFunction: string) {
    let eventType = "CLOCK";
    let triggerSource = "CLOCK";
    let triggerSourceId = "";
    const builder = {
      timeBased: () => builder,
      everyHours: (_hours: number) => builder,
      everyDays: (_days: number) => builder,
      atHour: (_hour: number) => builder,
      onMonthDay: (_day: number) => builder,
      after: (_milliseconds: number) => builder,
      forForm: (_form: unknown) => {
        eventType = "ON_FORM_SUBMIT";
        triggerSource = "FORMS";
        triggerSourceId = FORM_ID;
        return builder;
      },
      onFormSubmit: () => builder,
      create: () => {
        if (options.failCreateHandler === handlerFunction) {
          lifecycle.push(`create_failed:${handlerFunction}`);
          throw new Error("SIMULATED_TRIGGER_CREATE_FAILURE");
        }
        lifecycle.push(`create:${handlerFunction}`);
        const created = trigger(
          `uid_created_${nextId++}`,
          handlerFunction,
          eventType,
          triggerSource,
          triggerSourceId,
        );
        if (options.mutableTriggers) triggers.push(created);
        return created;
      },
    };
    return builder;
  }

  return {
    properties,
    spreadsheet,
    openSpreadsheet,
    openForm,
    lifecycle,
    successorPropertyName,
    retryQueuePropertyName: (item: ProfileRetryItem) => profileRetryPropertyName(item, namespace),
    propertyValues: () => Object.fromEntries(store),
    currentTriggers: () => triggers.map(({ handlerFunction, uniqueId, eventType, triggerSource, triggerSourceId }) => ({
      handlerFunction, uniqueId, eventType, triggerSource, triggerSourceId,
    })),
  };
}

function configuredFakeSpreadsheet(rawSheetExists: boolean, marker: string): FakeSpreadsheet {
  const spreadsheet = new FakeSpreadsheet();
  for (const definition of SHEET_DEFINITIONS) {
    const sheet = new FakeSheet(definition.name, 1000, Math.max(26, definition.columns.length));
    const rows: unknown[][] = [[...definition.columns]];
    if (definition.name === "99_Config") {
      const markerRow = definition.columns.map((column) => ({
        config_key: "SYNC_ENVIRONMENT_MARKER",
        config_value_non_secret: marker,
        description: "test boundary",
        updated_at: "2026-08-28T00:00:00.000Z",
        updated_by: "system",
      } as Record<string, string>)[column] ?? "");
      rows.push(markerRow);
    }
    sheet.seed(rows);
    spreadsheet.sheets.set(definition.name, sheet);
  }
  if (rawSheetExists) {
    const raw = new FakeSheet(PROFILE_RAW_SHEET_NAME, 1000, 40);
    raw.seed([
      ["タイムスタンプ", "Ghost登録メールアドレス", "所属", "追加された設問", "列順変更もForm所有"],
      ["2026/08/28 09:00:00", "member@example.invalid", "みんほす", "native value", "native value 2"],
    ]);
    spreadsheet.sheets.set(PROFILE_RAW_SHEET_NAME, raw);
  }
  // Keep the schema import exercised explicitly so a renamed Config tab fails
  // this harness during compilation rather than silently weakening preflight.
  definitionFor("99_Config");
  return spreadsheet;
}

function configValues(): Record<string, string> {
  return {
    SPREADSHEET_ID,
    GOOGLE_FORM_ID: FORM_ID,
    GHOST_ADMIN_URL: "https://ghost.example.invalid",
    GHOST_SITE_ID: "ghost_site",
    STRIPE_ACCOUNT_ID: "acct_test",
    STRIPE_API_VERSION: "2025-02-24.acacia",
    STRIPE_LIVEMODE: "false",
    STRIPE_PRICE_ALLOWLIST: "price_test",
    STRIPE_PRODUCT_ALLOWLIST: "prod_test",
    OPS_NOTIFICATION_EMAIL: "ops@example.invalid",
    BACKUP_FOLDER_ID: "backup_folder",
  };
}
