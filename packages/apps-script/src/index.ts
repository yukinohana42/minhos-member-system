import { AppsScriptHmacSigner, AppsScriptHttpTransport, appsScriptRetryRuntime } from "./adapters/apps-script-runtime";
import { backupPolicy, backupSpreadsheet } from "./adapters/backup";
import { GhostAdminClient } from "./adapters/ghost-admin-client";
import {
  assertProfileFormDestination,
  assertProfileFormSource,
  DEFAULT_PROFILE_FIELD_TITLES,
  extractProfileSubmission,
  type FormResponseLike,
  type FormSourceLike,
} from "./adapters/profile-form";
import { RunCoordinator } from "./adapters/run-coordination";
import { withScriptLock } from "./adapters/script-lock";
import { PROFILE_RAW_SHEET_NAME } from "./adapters/sheet-schema";
import { SheetsRepository } from "./adapters/sheets-repository";
import { StripeReadOnlyClient } from "./adapters/stripe-client";
import { loadConfig, loadSecrets } from "./config";
import { reconcileExceptionRows } from "./domain/exceptions";
import {
  completeNotificationOutboxItems,
  enqueueNotificationOutbox,
  markNotificationOutboxSent,
  notificationDecisionsForItems,
  notificationOutboxPropertyName,
  planNotificationOutboxDelivery,
  repairNotificationOutboxProperties,
  serializeNotificationOutboxItem,
  type NotificationOutboxItem,
} from "./domain/notification-outbox";
import { markNotificationsSent, planExceptionNotifications, type NotificationDecision } from "./domain/notifications";
import { planProfileSubmission } from "./domain/profile";
import {
  dueProfileRetryItems,
  enqueueProfileRetry,
  persistProfileRetryProcessingQuarantine,
  PROFILE_RETRY_PROPERTY_PREFIX,
  profileRetryQuarantineRecord,
  profileRetryItemId,
  profileRetryPropertyName,
  repairProfileRetryProperties,
  serializeProfileRetryItem,
  shouldQuarantineProfileRetry,
  type ProfileRetryItem,
  type ProfileRetryQuarantineRecord,
} from "./domain/profile-retry";
import { runProfileRetryBatch } from "./domain/profile-retry-runner";
import {
  clearProfileRetrySuccessorUid,
  persistProfileRetrySuccessorUid,
  planProfileRetrySuccessor,
  repairProfileRetrySuccessorUid,
} from "./domain/profile-retry-successor";
import { assertSafePropertyStoreWrites } from "./domain/property-quota";
import { environmentMarker, environmentNamespace, syncContextFingerprint } from "./domain/sync-context";
import {
  assertExecutingTrigger,
  planManagedTriggers,
  type ManagedTriggerSpec,
  type TriggerDescriptor as ManagedTriggerDescriptor,
} from "./domain/trigger-integrity";
import type { ExceptionRow, MemberRow, SheetRecord } from "./domain/types";
import { SyncService } from "./sync/sync-service";

export function hourlySync(): void {
  createSyncService().run("hourly");
}

export function nightlySync(): void {
  createSyncService().run("nightly");
}

export function manualSync(): void {
  createSyncService().run("manual");
}

export function resumeSync(event?: { triggerUid?: string }): void {
  assertExecutingTrigger(
    projectTriggerDescriptors(),
    event?.triggerUid,
    clockTriggerSpec("resumeSync"),
  );
  createSyncService(event?.triggerUid).run("resume");
}

export function dailyBackup(): void {
  runBackup("daily");
}

export function monthlyBackup(): void {
  runBackup("monthly");
}

export function initializeMinhosWorkbook(): void {
  const properties = PropertiesService.getScriptProperties();
  const config = loadConfig(properties);
  const repository = configuredRepository(config);
  // The only entrypoint allowed to accept a missing marker. A mismatch still
  // fails before initialize() creates or updates any Sheet cells.
  repository.preflightEnvironmentMarker(environmentMarker(config), true);
  repository.initialize();
  repository.initializeEnvironmentMarker(environmentMarker(config), new Date().toISOString());
}

interface ProfileFormSubmitEvent {
  response?: FormResponseLike;
  source?: FormSourceLike;
  triggerUid?: string;
}

export function onProfileFormSubmit(event?: ProfileFormSubmitEvent): void {
  if (!event?.response) throw new Error("FORM_SUBMIT_EVENT_REQUIRED");
  const properties = PropertiesService.getScriptProperties();
  const config = loadConfig(properties);
  const formId = requiredProperty(properties, "GOOGLE_FORM_ID");
  assertExecutingTrigger(
    projectTriggerDescriptors(),
    event.triggerUid,
    profileFormTriggerSpec(formId),
  );
  assertProfileFormSource(event.source, formId);
  assertProfileFormDestination(
    event.source!,
    config.spreadsheetId,
    String(FormApp.DestinationType.SPREADSHEET),
  );
  const retryItem = profileRetryItemForTrustedEvent(formId, event.response);
  try {
    assertNativeProfileRawSheet(config.spreadsheetId);
    const repository = configuredRepository(config);
    // Form writes obey the same environment boundary as scheduled sync. A
    // mismatch happens before the coordination transaction and before any Sheet
    // mutation (including exception recording).
    repository.preflightEnvironmentMarker(environmentMarker(config));
    const submission = extractProfileSubmission(event.response, profileFieldTitles(properties));
    processProfileSubmission(properties, repository, config, submission);
  } catch (error) {
    const namespace = environmentNamespace(config);
    try {
      queueProfileRetry(properties, namespace, retryItem);
    } finally {
      // If queue repair or insertion fails after an older item was already
      // durable, still preserve its one-shot retry chain.
      maintainProfileRetrySuccessor(properties, namespace);
    }
    if (!isProfileCoordinationBusy(error)) throw error;
  }
}

export function retryProfileFormSubmissions(event?: { triggerUid?: string }): void {
  const properties = PropertiesService.getScriptProperties();
  const config = loadConfig(properties);
  const formId = requiredProperty(properties, "GOOGLE_FORM_ID");
  assertExecutingTrigger(
    projectTriggerDescriptors(),
    event?.triggerUid,
    profileRetryTriggerSpec(),
  );
  const namespace = environmentNamespace(config);
  const nowIso = new Date().toISOString();
  // Consume this callback's marker and create the next exact successor before
  // any Form/Sheet/queue repair work. Only a marked UID counts as a future
  // trigger; another unmarked exact trigger may already be executing.
  if (!maintainProfileRetrySuccessor(properties, namespace, event?.triggerUid)) return;
  const queued = withScriptLock(() =>
    repairAndReadProfileRetryQueue(properties, namespace, nowIso));
  if (!queued.length) {
    maintainProfileRetrySuccessor(properties, namespace, event?.triggerUid);
    return;
  }

  const form = FormApp.openById(formId);
  assertProfileFormSource(form, formId);
  assertProfileFormDestination(
    form,
    config.spreadsheetId,
    String(FormApp.DestinationType.SPREADSHEET),
  );
  assertNativeProfileRawSheet(config.spreadsheetId);
  const due = dueProfileRetryItems(queued, nowIso);
  if (!due.length) return;
  const repository = configuredRepository(config);
  repository.preflightEnvironmentMarker(environmentMarker(config));
  let firstNonBusyError: unknown;
  try {
    const result = runProfileRetryBatch({
      expectedFormId: formId,
      nowIso,
      items: due,
      responseFor: (responseId) => form.getResponse(responseId) as unknown as FormResponseLike | undefined,
      process: (item, response) => {
        const submission = extractProfileSubmission(response, profileFieldTitles(properties));
        if (submission.responseId !== item.responseId) {
          throw new Error("PROFILE_RETRY_RESPONSE_ID_MISMATCH");
        }
        processProfileSubmission(properties, repository, config, submission);
      },
      onSuccess: (item) => removeQueuedProfileRetry(properties, namespace, item),
      onFailure: (item, next, failureKind) => {
        if (failureKind === "coordination_busy") {
          replaceQueuedProfileRetry(properties, namespace, item, next);
        } else {
          persistOrQuarantineProfileRetry(properties, namespace, item, next, failureKind, nowIso);
        }
      },
      isCoordinationBusy: isProfileCoordinationBusy,
    });
    firstNonBusyError = result.firstNonBusyError;
  } finally {
    // Remove an unnecessary future trigger when the queue drained; otherwise
    // retain the UID marker created at callback entry.
    maintainProfileRetrySuccessor(properties, namespace, event?.triggerUid);
  }
  if (firstNonBusyError !== undefined) throw firstNonBusyError;
}

function processProfileSubmission(
  properties: GoogleAppsScript.Properties.Properties,
  repository: SheetsRepository,
  config: ReturnType<typeof loadConfig>,
  submission: ReturnType<typeof extractProfileSubmission>,
): void {
  const coordinator = new RunCoordinator(properties, 120_000, undefined, environmentNamespace(config));
  const runId = `form_${submission.responseId}`;
  coordinator.claim(runId, Date.now(), runId);
  try {
    withScriptLock(() => {
      repository.preflightIdentityIntegrity();
      const members = repository.read<MemberRow>("10_Members");
      const supplementalRows = repository.read<SheetRecord>("40_Supplemental");
      let allExceptions = repository.read<ExceptionRow>("50_Exceptions");
      allExceptions = tryDeliverFormNotificationOutbox(properties, repository, config, allExceptions, submission.submittedAt);
      const plan = planProfileSubmission({
        submission,
        members,
        supplementalRows,
      });
      if (plan.kind === "noop_duplicate_event") return;
      if (plan.kind === "exception") {
        const previous = allExceptions.find((row) => row.exception_key === plan.finding.exceptionKey);
        const row = reconcileExceptionRows({
          existing: previous ? [previous] : [],
          findings: [plan.finding],
          runId: `form_${submission.responseId}`,
          nowIso: submission.submittedAt,
          newId: () => Utilities.getUuid(),
        })[0];
        if (!row) return;
        const decisions = planExceptionNotifications({
          before: previous ? [previous] : [],
          after: [row],
          findings: [plan.finding],
          now: new Date(submission.submittedAt),
        });
        enqueueFormNotificationDecisions(properties, config, decisions, submission.submittedAt);
        repository.upsert("50_Exceptions", [row]);
        allExceptions = allExceptions.map((candidate) =>
          candidate.exception_key === row.exception_key ? row : candidate,
        );
        if (!previous) allExceptions.push(row);
        tryDeliverFormNotificationOutbox(properties, repository, config, allExceptions, submission.submittedAt);
        return;
      }
      if (!repository.insertSupplementalIfAbsent(plan.supplemental)) {
        throw new Error("PROFILE_SUPPLEMENTAL_INSERT_CONFLICT");
      }
    });
  } finally {
    coordinator.release(runId, runId);
  }
}

function enqueueFormNotificationDecisions(
  properties: GoogleAppsScript.Properties.Properties,
  config: ReturnType<typeof loadConfig>,
  decisions: NotificationDecision[],
  nowIso: string,
): void {
  if (!decisions.length) return;
  const outbox = readFormNotificationOutbox(properties, config, nowIso);
  const existingIds = new Set(outbox.map((item) => item.notificationId));
  const next = enqueueNotificationOutbox(outbox, decisions, nowIso);
  persistFormNotificationItems(properties, config, next.filter((item) => !existingIds.has(item.notificationId)));
}

function tryDeliverFormNotificationOutbox(
  properties: GoogleAppsScript.Properties.Properties,
  repository: SheetsRepository,
  config: ReturnType<typeof loadConfig>,
  rows: ExceptionRow[],
  nowIso: string,
): ExceptionRow[] {
  // Keep repair outside the delivery catch.  A quarantine write failure must
  // stop this transaction with the corrupt source intact (fail closed).
  let outbox = readFormNotificationOutbox(properties, config, nowIso);
  if (!outbox.length) return rows;
  let updatedRows = rows;
  try {
    const priorSent = planNotificationOutboxDelivery({ outbox, rows: updatedRows }).sentItems;
    if (priorSent.length) {
      updatedRows = acknowledgeFormNotificationItems(repository, updatedRows, priorSent, nowIso);
      outbox = completeNotificationOutboxItems(outbox, priorSent);
      deleteFormNotificationItems(properties, config, priorSent);
    }
    const plan = planNotificationOutboxDelivery({ outbox, rows: updatedRows });
    if (!plan.decisions.length) return updatedRows;
    sendFormNotifications(config.notificationEmail, plan.decisions, plan.deliverItems);
    outbox = markNotificationOutboxSent(outbox, plan.deliverItems);
    const deliveredIds = new Set(plan.deliverItems.map((item) => item.notificationId));
    persistFormNotificationItems(properties, config, outbox.filter((item) => deliveredIds.has(item.notificationId)));
    updatedRows = acknowledgeFormNotificationItems(repository, updatedRows, plan.deliverItems, nowIso);
    deleteFormNotificationItems(properties, config, plan.deliverItems);
    return updatedRows;
  } catch {
    return updatedRows;
  }
}

function acknowledgeFormNotificationItems(
  repository: SheetsRepository,
  rows: ExceptionRow[],
  items: NotificationOutboxItem[],
  nowIso: string,
): ExceptionRow[] {
  const decisions = notificationDecisionsForItems(items, rows);
  const updated = markNotificationsSent(rows, decisions, nowIso);
  const keys = new Set(decisions.map((decision) => decision.exceptionKey));
  repository.upsert("50_Exceptions", updated.filter((row) => keys.has(row.exception_key)));
  return updated;
}

function sendFormNotifications(
  to: string,
  decisions: NotificationDecision[],
  items: NotificationOutboxItem[],
): void {
  const lines = decisions.map((decision, index) =>
    `[${decision.severity}] ${decision.kind} ${decision.exceptionKey} (${items[index]?.notificationId ?? "no-id"}): ${decision.summary}`,
  );
  MailApp.sendEmail({
    to,
    subject: `[みんほす] Form照合通知 ${decisions.length}件`,
    body: ["Form回答の照合で運用確認が必要です。", "", ...lines, "", "回答値やAPI秘密鍵は通知キューへ保存していません。"].join("\n"),
  });
}

function readFormNotificationOutbox(
  properties: GoogleAppsScript.Properties.Properties,
  config: ReturnType<typeof loadConfig>,
  nowIso: string,
): NotificationOutboxItem[] {
  return repairNotificationOutboxProperties(properties, syncContextFingerprint(config), nowIso);
}

function persistFormNotificationItems(
  properties: GoogleAppsScript.Properties.Properties,
  config: ReturnType<typeof loadConfig>,
  items: NotificationOutboxItem[],
): void {
  const fingerprint = syncContextFingerprint(config);
  for (const item of items) {
    const name = notificationOutboxPropertyName(item.notificationId, fingerprint);
    setInternalProperty(properties, name, serializeNotificationOutboxItem(item));
  }
}

function deleteFormNotificationItems(
  properties: GoogleAppsScript.Properties.Properties,
  config: ReturnType<typeof loadConfig>,
  items: NotificationOutboxItem[],
): void {
  const fingerprint = syncContextFingerprint(config);
  for (const item of items) {
    const name = notificationOutboxPropertyName(item.notificationId, fingerprint);
    deleteInternalProperty(properties, name);
  }
}

export function installMinhosTriggers(): void {
  const properties = PropertiesService.getScriptProperties();
  const config = loadConfig(properties);
  const formId = requiredProperty(properties, "GOOGLE_FORM_ID");
  const form = FormApp.openById(formId);
  assertProfileFormSource(form, formId);
  assertProfileFormDestination(
    form,
    config.spreadsheetId,
    String(FormApp.DestinationType.SPREADSHEET),
  );
  assertNativeProfileRawSheet(config.spreadsheetId);
  const repository = configuredRepository(config);
  repository.preflightEnvironmentMarker(environmentMarker(config));
  repository.preflightIdentityIntegrity();

  const specs = persistentManagedTriggerSpecs(formId);
  const initialPlan = planManagedTriggers(projectTriggerDescriptors(), specs);
  // Create all missing exact tuples before deleting a stale or duplicate
  // managed trigger. A partial creation failure therefore preserves every
  // trigger which existed when installation began.
  for (const spec of initialPlan.missing) createManagedTrigger(spec, form);

  const afterCreateTriggers = ScriptApp.getProjectTriggers();
  const afterCreatePlan = planManagedTriggers(
    afterCreateTriggers.map(triggerDescriptor),
    specs,
  );
  if (afterCreatePlan.missing.length) throw new Error("MANAGED_TRIGGER_CREATE_NOT_OBSERVED");
  const byUniqueId = new Map(afterCreateTriggers.map((trigger) => [trigger.getUniqueId(), trigger]));
  for (const uniqueId of afterCreatePlan.deleteUniqueIds) {
    const trigger = byUniqueId.get(uniqueId);
    if (!trigger) throw new Error("MANAGED_TRIGGER_INVENTORY_CHANGED");
    ScriptApp.deleteTrigger(trigger);
  }

  const finalPlan = planManagedTriggers(projectTriggerDescriptors(), specs);
  if (finalPlan.missing.length || finalPlan.deleteUniqueIds.length) {
    throw new Error("MANAGED_TRIGGER_INSTALL_VERIFICATION_FAILED");
  }
}

function persistentManagedTriggerSpecs(formId: string): ManagedTriggerSpec[] {
  return [
    clockTriggerSpec("hourlySync"),
    clockTriggerSpec("nightlySync"),
    clockTriggerSpec("dailyBackup"),
    clockTriggerSpec("monthlyBackup"),
    profileFormTriggerSpec(formId),
  ];
}

function clockTriggerSpec(handlerFunction: string): ManagedTriggerSpec {
  return {
    handlerFunction,
    eventType: String(ScriptApp.EventType.CLOCK),
    triggerSource: String(ScriptApp.TriggerSource.CLOCK),
    triggerSourceId: "",
  };
}

function profileRetryTriggerSpec(): ManagedTriggerSpec {
  return clockTriggerSpec("retryProfileFormSubmissions");
}

function profileFormTriggerSpec(formId: string): ManagedTriggerSpec {
  return {
    handlerFunction: "onProfileFormSubmit",
    eventType: String(ScriptApp.EventType.ON_FORM_SUBMIT),
    triggerSource: String(ScriptApp.TriggerSource.FORMS),
    triggerSourceId: formId,
  };
}

function projectTriggerDescriptors(): ManagedTriggerDescriptor[] {
  return ScriptApp.getProjectTriggers().map(triggerDescriptor);
}

function triggerDescriptor(trigger: GoogleAppsScript.Script.Trigger): ManagedTriggerDescriptor {
  const sourceId = trigger.getTriggerSourceId();
  return {
    handlerFunction: trigger.getHandlerFunction(),
    uniqueId: trigger.getUniqueId(),
    eventType: String(trigger.getEventType()),
    triggerSource: String(trigger.getTriggerSource()),
    triggerSourceId: sourceId === null || sourceId === undefined ? "" : String(sourceId),
  };
}

function createManagedTrigger(
  spec: ManagedTriggerSpec,
  form: GoogleAppsScript.Forms.Form,
): void {
  switch (spec.handlerFunction) {
    case "hourlySync":
      ScriptApp.newTrigger(spec.handlerFunction).timeBased().everyHours(1).create();
      return;
    case "nightlySync":
      ScriptApp.newTrigger(spec.handlerFunction).timeBased().everyDays(1).atHour(2).create();
      return;
    case "dailyBackup":
      ScriptApp.newTrigger(spec.handlerFunction).timeBased().everyDays(1).atHour(3).create();
      return;
    case "monthlyBackup":
      ScriptApp.newTrigger(spec.handlerFunction).timeBased().onMonthDay(1).atHour(4).create();
      return;
    case "onProfileFormSubmit":
      ScriptApp.newTrigger(spec.handlerFunction).forForm(form).onFormSubmit().create();
      return;
    default:
      throw new Error(`UNSUPPORTED_MANAGED_TRIGGER:${spec.handlerFunction}`);
  }
}

function assertNativeProfileRawSheet(spreadsheetId: string): void {
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  // Form destination identity plus native-tab existence is the complete
  // preflight. Headers and column count are Google Forms-owned and may change;
  // inspecting or normalizing them would cross the RAW ownership boundary.
  if (!spreadsheet.getSheetByName(PROFILE_RAW_SHEET_NAME)) {
    throw new Error("PROFILE_RAW_SHEET_MISSING");
  }
}

function profileFieldTitles(properties: GoogleAppsScript.Properties.Properties) {
  return {
    email: propertyOr(properties, "PROFILE_EMAIL_ITEM_TITLE", DEFAULT_PROFILE_FIELD_TITLES.email),
    affiliation: propertyOr(properties, "PROFILE_AFFILIATION_ITEM_TITLE", DEFAULT_PROFILE_FIELD_TITLES.affiliation),
    titleOrRole: propertyOr(properties, "PROFILE_TITLE_OR_ROLE_ITEM_TITLE", DEFAULT_PROFILE_FIELD_TITLES.titleOrRole),
    participantType: propertyOr(properties, "PROFILE_PARTICIPANT_TYPE_ITEM_TITLE", DEFAULT_PROFILE_FIELD_TITLES.participantType),
    privacyAcknowledgement: propertyOr(properties, "PROFILE_PRIVACY_ACK_ITEM_TITLE", DEFAULT_PROFILE_FIELD_TITLES.privacyAcknowledgement),
  };
}

function profileRetryItemForTrustedEvent(
  formId: string,
  response: FormResponseLike,
): ProfileRetryItem {
  if (!response || typeof response.getId !== "function") throw new Error("FORM_RESPONSE_SHAPE_INVALID");
  const rawResponseId = response.getId();
  const responseId = typeof rawResponseId === "string" ? rawResponseId.trim() : "";
  if (!responseId) throw new Error("FORM_RESPONSE_ID_INVALID");
  let queuedAt = new Date().toISOString();
  try {
    const timestamp = response.getTimestamp();
    if (timestamp instanceof Date && Number.isFinite(timestamp.getTime())) {
      queuedAt = timestamp.toISOString();
    }
  } catch {
    // The durable retry identity remains usable even if an optional timestamp
    // accessor is temporarily unavailable. No response value is persisted.
  }
  return { formId, responseId, queuedAt };
}

function repairAndReadProfileRetryQueue(
  properties: GoogleAppsScript.Properties.Properties,
  namespace: string,
  nowIso: string,
): ProfileRetryItem[] {
  return repairProfileRetryProperties(properties, namespace, nowIso);
}

function hasProfileRetrySource(properties: Record<string, string>, namespace: string): boolean {
  const legacyName = `${PROFILE_RETRY_PROPERTY_PREFIX}${namespace}`;
  const itemPrefix = `${legacyName}:`;
  return Object.keys(properties).some((name) => name === legacyName || name.startsWith(itemPrefix));
}

function queueProfileRetry(
  properties: GoogleAppsScript.Properties.Properties,
  namespace: string,
  item: ProfileRetryItem,
): void {
  withScriptLock(() => {
    const existing = repairAndReadProfileRetryQueue(properties, namespace, new Date().toISOString());
    const next = enqueueProfileRetry(existing, item);
    if (next.length === existing.length) return;
    const name = profileRetryPropertyName(item, namespace);
    setInternalProperty(properties, name, serializeProfileRetryItem(item));
  });
}

function removeQueuedProfileRetry(
  properties: GoogleAppsScript.Properties.Properties,
  namespace: string,
  item: ProfileRetryItem,
): void {
  withScriptLock(() => {
    const existing = repairAndReadProfileRetryQueue(properties, namespace, new Date().toISOString());
    if (!existing.some((candidate) => profileRetryItemId(candidate) === profileRetryItemId(item))) return;
    const name = profileRetryPropertyName(item, namespace);
    deleteInternalProperty(properties, name);
  });
}

function replaceQueuedProfileRetry(
  properties: GoogleAppsScript.Properties.Properties,
  namespace: string,
  previous: ProfileRetryItem,
  next: ProfileRetryItem,
): void {
  if (profileRetryItemId(previous) !== profileRetryItemId(next)) {
    throw new Error("PROFILE_RETRY_IDENTITY_CHANGED");
  }
  withScriptLock(() => {
    const existing = repairAndReadProfileRetryQueue(properties, namespace, new Date().toISOString());
    if (!existing.some((candidate) => profileRetryItemId(candidate) === profileRetryItemId(previous))) return;
    const name = profileRetryPropertyName(previous, namespace);
    setInternalProperty(properties, name, serializeProfileRetryItem(next));
  });
}

function persistOrQuarantineProfileRetry(
  properties: GoogleAppsScript.Properties.Properties,
  namespace: string,
  previous: ProfileRetryItem,
  next: ProfileRetryItem,
  reason: ProfileRetryQuarantineRecord["reason"],
  nowIso: string,
): void {
  if (!shouldQuarantineProfileRetry(next)) {
    replaceQueuedProfileRetry(properties, namespace, previous, next);
    return;
  }
  withScriptLock(() => {
    const existing = repairAndReadProfileRetryQueue(properties, namespace, nowIso);
    const current = existing.find((candidate) => profileRetryItemId(candidate) === profileRetryItemId(previous));
    if (!current) return;
    const record = profileRetryQuarantineRecord(next, reason, nowIso);
    persistProfileRetryProcessingQuarantine(properties, namespace, record);
    // Quarantine must be durable before the retry source is removed. If this
    // delete fails, a rerun recognizes the same deterministic quarantine ID.
    deleteInternalProperty(properties, profileRetryPropertyName(previous, namespace));
  });
}

function maintainProfileRetrySuccessor(
  properties: GoogleAppsScript.Properties.Properties,
  namespace: string,
  executingTriggerUid?: string,
): boolean {
  return withScriptLock(() => {
    const queuePresent = hasProfileRetrySource(properties.getProperties(), namespace);
    const successorUid = repairProfileRetrySuccessorUid(
      properties,
      namespace,
      new Date().toISOString(),
    );
    const nativeTriggers = ScriptApp.getProjectTriggers();
    const descriptors = nativeTriggers.map(triggerDescriptor);
    const constraint = profileRetryTriggerSpec();
    const plan = planProfileRetrySuccessor({
      queuePresent,
      successorUid,
      ...(executingTriggerUid === undefined ? {} : { executingTriggerUid }),
      triggers: descriptors,
      constraint,
    });

    switch (plan.action) {
      case "none":
      case "keep":
        return queuePresent;
      case "clear":
        clearProfileRetrySuccessorUid(properties, namespace);
        return queuePresent;
      case "delete_and_clear": {
        const trigger = nativeTriggers.find((candidate) => candidate.getUniqueId() === plan.uniqueId);
        if (!trigger) throw new Error("PROFILE_RETRY_SUCCESSOR_INVENTORY_CHANGED");
        ScriptApp.deleteTrigger(trigger);
        clearProfileRetrySuccessorUid(properties, namespace);
        return queuePresent;
      }
      case "create": {
        const created = ScriptApp.newTrigger(constraint.handlerFunction)
          .timeBased()
          .after(60_000)
          .create();
        assertExecutingTrigger([triggerDescriptor(created)], created.getUniqueId(), constraint);
        // Overwrite the marker only after trigger creation succeeds. If the
        // property write is not durable, preserve this exact one-shot trigger
        // as the queue's fail-safe execution path and rethrow the marker error.
        // When the unmarked trigger fires, it creates and records a fresh
        // successor before touching the durable queue.
        persistProfileRetrySuccessorUid(properties, namespace, created.getUniqueId());
        return queuePresent;
      }
    }
  });
}

function isProfileCoordinationBusy(error: unknown): boolean {
  return error instanceof Error && [
    "SYNC_LOCK_BUSY", "SYNC_RUN_ALREADY_ACTIVE", "SCRIPT_COORDINATION_LOCK_BUSY",
  ].includes(error.message);
}

function setInternalProperty(properties: GoogleAppsScript.Properties.Properties, name: string, value: string): void {
  assertSafePropertyStoreWrites(properties.getProperties(), [{ name, value }], "INTERNAL_SCRIPT_PROPERTY");
  properties.setProperty(name, value);
}

function deleteInternalProperty(properties: GoogleAppsScript.Properties.Properties, name: string): void {
  properties.deleteProperty(name);
}

function configuredRepository(config: ReturnType<typeof loadConfig>): SheetsRepository {
  return new SheetsRepository(config.spreadsheetId, undefined, {
    ghostSiteId: config.ghostSiteId,
    stripeAccountId: config.stripeAccountId,
    livemode: config.livemode,
  });
}

function createSyncService(executingTriggerUid?: string): SyncService {
  const properties = PropertiesService.getScriptProperties();
  const config = loadConfig(properties);
  const secrets = loadSecrets(properties, config.livemode);
  const transport = new AppsScriptHttpTransport();
  let retryDeadlineMs = Number.POSITIVE_INFINITY;
  const retryRuntime = {
    ...appsScriptRetryRuntime,
    remainingMs: () => retryDeadlineMs - Date.now(),
  };
  return new SyncService({
    config,
    properties,
    repository: configuredRepository(config),
    coordinator: new RunCoordinator(properties, 120_000, executingTriggerUid, environmentNamespace(config)),
    ghost: new GhostAdminClient({
      adminUrl: config.ghostAdminUrl,
      adminApiKey: secrets.ghostAdminApiKey,
      acceptVersion: config.ghostAcceptVersion,
      transport,
      signer: new AppsScriptHmacSigner(),
      retryRuntime,
      nowSeconds: () => Math.floor(Date.now() / 1000),
    }),
    stripe: new StripeReadOnlyClient({
      restrictedKey: secrets.stripeRestrictedKey,
      apiVersion: config.stripeApiVersion,
      transport,
      retryRuntime,
    }),
    now: () => new Date(),
    uuid: () => Utilities.getUuid(),
    sendMail: (to, subject, body) => MailApp.sendEmail({ to, subject, body }),
    setRetryDeadline: (deadlineMs) => {
      retryDeadlineMs = deadlineMs ?? Number.POSITIVE_INFINITY;
    },
  });
}

function runBackup(kind: "daily" | "monthly"): void {
  const properties = PropertiesService.getScriptProperties();
  const config = loadConfig(properties);
  configuredRepository(config)
    .preflightEnvironmentMarker(environmentMarker(config));
  const retentionDays = kind === "daily" ? config.backupRetentionDays : config.backupMonthlyRetentionDays;
  backupPolicy(kind, retentionDays);
  const coordinator = new RunCoordinator(properties, 30 * 60 * 1000);
  const runId = `backup_${kind}_${Utilities.getUuid()}`;
  coordinator.claim(runId, Date.now());
  try {
    backupSpreadsheet({
      spreadsheetId: config.spreadsheetId,
      backupFolderId: config.backupFolderId,
      retentionDays,
      kind,
      now: new Date(),
    });
  } finally {
    coordinator.release(runId);
  }
}

function requiredProperty(properties: GoogleAppsScript.Properties.Properties, name: string): string {
  const value = properties.getProperty(name)?.trim();
  if (!value) throw new Error(`MISSING_CONFIGURATION:${name}`);
  return value;
}

function propertyOr(
  properties: GoogleAppsScript.Properties.Properties,
  name: string,
  fallback: string,
): string {
  return properties.getProperty(name)?.trim() || fallback;
}
