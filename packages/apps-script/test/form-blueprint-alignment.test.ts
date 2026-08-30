import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE_FIELD_TITLES } from "../src/adapters/profile-form";

interface BlueprintField { id: string; label: string }
interface PropertyEntry { name: string; default?: string }

describe("canonical Form label alignment", () => {
  it("keeps code defaults and Script Property defaults identical to form-blueprint.json", () => {
    const blueprint = JSON.parse(readFileSync(resolve(process.cwd(), "../../config/form-blueprint.json"), "utf8")) as {
      form: { fields: BlueprintField[] };
    };
    const registry = JSON.parse(readFileSync(resolve(process.cwd(), "script-properties.names.json"), "utf8")) as {
      properties: PropertyEntry[];
    };
    const labels = new Map(blueprint.form.fields.map((field) => [field.id, field.label]));
    const defaults = new Map(registry.properties.map((entry) => [entry.name, entry.default]));
    const expected = {
      email: labels.get("profile_email"),
      affiliation: labels.get("affiliation"),
      titleOrRole: labels.get("title_or_role"),
      participantType: labels.get("participant_type"),
      privacyAcknowledgement: labels.get("privacy_acknowledgement"),
    };

    expect(DEFAULT_PROFILE_FIELD_TITLES).toEqual(expected);
    expect(defaults.get("PROFILE_EMAIL_ITEM_TITLE")).toBe(expected.email);
    expect(defaults.get("PROFILE_AFFILIATION_ITEM_TITLE")).toBe(expected.affiliation);
    expect(defaults.get("PROFILE_TITLE_OR_ROLE_ITEM_TITLE")).toBe(expected.titleOrRole);
    expect(defaults.get("PROFILE_PARTICIPANT_TYPE_ITEM_TITLE")).toBe(expected.participantType);
    expect(defaults.get("PROFILE_PRIVACY_ACK_ITEM_TITLE")).toBe(expected.privacyAcknowledgement);
  });
});
