export interface TriggerDescriptor {
  handlerFunction: string;
  uniqueId: string;
  eventType: string;
  triggerSource: string;
  triggerSourceId: string;
}

export interface ManagedTriggerSpec {
  handlerFunction: string;
  eventType: string;
  triggerSource: string;
  triggerSourceId: string;
}

export interface ManagedTriggerPlan {
  missing: ManagedTriggerSpec[];
  deleteUniqueIds: string[];
}

/**
 * Compare the complete installable-trigger identity. A handler name alone is
 * not sufficient: a stale CLOCK trigger or a Form trigger bound to another
 * Form must never satisfy the profile submission contract.
 */
export function triggerMatchesSpec(trigger: TriggerDescriptor, spec: ManagedTriggerSpec): boolean {
  return trigger.handlerFunction === spec.handlerFunction &&
    trigger.eventType === spec.eventType &&
    trigger.triggerSource === spec.triggerSource &&
    trigger.triggerSourceId === spec.triggerSourceId;
}

/**
 * Keep exactly one deterministic matching trigger per managed specification.
 * Wrong-source/event duplicates are deletable only after every missing spec
 * has first been created and a second inventory proves it exists.
 */
export function planManagedTriggers(
  existing: readonly TriggerDescriptor[],
  specs: readonly ManagedTriggerSpec[],
): ManagedTriggerPlan {
  const handlers = new Set<string>();
  for (const spec of specs) {
    if (!spec.handlerFunction || handlers.has(spec.handlerFunction)) {
      throw new Error("INVALID_MANAGED_TRIGGER_SPECS");
    }
    handlers.add(spec.handlerFunction);
  }

  const missing: ManagedTriggerSpec[] = [];
  const keepIds = new Set<string>();
  for (const spec of specs) {
    const matches = existing
      .filter((trigger) => triggerMatchesSpec(trigger, spec))
      .sort((left, right) => left.uniqueId.localeCompare(right.uniqueId));
    if (!matches.length) missing.push(spec);
    else keepIds.add(matches[0]!.uniqueId);
  }

  const deleteUniqueIds = existing
    .filter((trigger) => handlers.has(trigger.handlerFunction) && !keepIds.has(trigger.uniqueId))
    .map((trigger) => trigger.uniqueId)
    .sort((left, right) => left.localeCompare(right));
  return { missing, deleteUniqueIds };
}

export function assertExecutingTrigger(
  triggers: readonly TriggerDescriptor[],
  triggerUid: string | undefined,
  expected: ManagedTriggerSpec,
): TriggerDescriptor {
  if (!triggerUid) throw new Error("INSTALLABLE_TRIGGER_UID_REQUIRED");
  const trigger = triggers.find((candidate) => candidate.uniqueId === triggerUid);
  if (!trigger) throw new Error("INSTALLABLE_TRIGGER_NOT_FOUND");
  if (!triggerMatchesSpec(trigger, expected)) throw new Error("INSTALLABLE_TRIGGER_IDENTITY_MISMATCH");
  return trigger;
}
