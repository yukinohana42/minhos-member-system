import { describe, expect, it } from "vitest";
import {
  assertExecutingTrigger,
  planManagedTriggers,
  type ManagedTriggerSpec,
  type TriggerDescriptor,
} from "../src/domain/trigger-integrity";

const formSpec: ManagedTriggerSpec = {
  handlerFunction: "onProfileFormSubmit",
  eventType: "ON_FORM_SUBMIT",
  triggerSource: "FORMS",
  triggerSourceId: "form_expected",
};
const clockSpec: ManagedTriggerSpec = {
  handlerFunction: "hourlySync",
  eventType: "CLOCK",
  triggerSource: "CLOCK",
  triggerSourceId: "",
};

describe("managed trigger identity", () => {
  it("does not let a same-handler wrong event or source satisfy a Form trigger", () => {
    const existing = [
      trigger("wrong-event", { ...formSpec, eventType: "CLOCK", triggerSource: "CLOCK", triggerSourceId: "" }),
      trigger("wrong-form", { ...formSpec, triggerSourceId: "form_other" }),
      trigger("clock-ok", clockSpec),
    ];
    const plan = planManagedTriggers(existing, [clockSpec, formSpec]);
    expect(plan.missing).toEqual([formSpec]);
    expect(plan.deleteUniqueIds).toEqual(["wrong-event", "wrong-form"]);
  });

  it("keeps one deterministic exact trigger and deletes exact and wrong duplicates", () => {
    const existing = [
      trigger("form-b", formSpec),
      trigger("form-a", formSpec),
      trigger("form-wrong", { ...formSpec, triggerSourceId: "form_other" }),
    ];
    expect(planManagedTriggers(existing, [formSpec])).toEqual({
      missing: [],
      deleteUniqueIds: ["form-b", "form-wrong"],
    });
  });

  it("requires the executing trigger UID to resolve to the complete expected tuple", () => {
    const exact = trigger("form-exact", formSpec);
    const wrong = trigger("form-wrong", { ...formSpec, triggerSourceId: "form_other" });
    expect(assertExecutingTrigger([exact, wrong], "form-exact", formSpec)).toEqual(exact);
    expect(() => assertExecutingTrigger([exact], undefined, formSpec)).toThrow("INSTALLABLE_TRIGGER_UID_REQUIRED");
    expect(() => assertExecutingTrigger([exact], "missing", formSpec)).toThrow("INSTALLABLE_TRIGGER_NOT_FOUND");
    expect(() => assertExecutingTrigger([wrong], "form-wrong", formSpec))
      .toThrow("INSTALLABLE_TRIGGER_IDENTITY_MISMATCH");
  });

  it("rejects ambiguous duplicate managed specifications", () => {
    expect(() => planManagedTriggers([], [formSpec, { ...formSpec, triggerSourceId: "form_other" }]))
      .toThrow("INVALID_MANAGED_TRIGGER_SPECS");
  });
});

function trigger(uniqueId: string, spec: ManagedTriggerSpec): TriggerDescriptor {
  return { uniqueId, ...spec };
}
