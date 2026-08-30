export interface TriggerDescriptor {
  handlerFunction: string;
  uniqueId: string;
  eventType?: string;
  triggerSource?: string;
  triggerSourceId?: string;
}

export interface TriggerConstraint {
  eventType: string;
  triggerSource: string;
  triggerSourceId: string;
}

/**
 * The currently executing one-shot trigger is not a future resume. Ignore it
 * when deciding whether another trigger must be created.
 */
export function shouldCreateResumeTrigger(
  triggers: readonly TriggerDescriptor[],
  executingTriggerUid?: string,
  handler = "resumeSync",
  constraint?: TriggerConstraint,
): boolean {
  return !triggers.some(
    (trigger) => trigger.handlerFunction === handler &&
      trigger.uniqueId !== executingTriggerUid &&
      (!constraint ||
        (trigger.eventType === constraint.eventType &&
          trigger.triggerSource === constraint.triggerSource &&
          trigger.triggerSourceId === constraint.triggerSourceId)),
  );
}
