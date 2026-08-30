const PROFILE_FORM_ITEM_TITLE_BINDINGS = Object.freeze([
  Object.freeze({propertyName: 'PROFILE_EMAIL_ITEM_TITLE', fieldId: 'profile_email'}),
  Object.freeze({propertyName: 'PROFILE_AFFILIATION_ITEM_TITLE', fieldId: 'affiliation'}),
  Object.freeze({propertyName: 'PROFILE_TITLE_OR_ROLE_ITEM_TITLE', fieldId: 'title_or_role'}),
  Object.freeze({propertyName: 'PROFILE_PARTICIPANT_TYPE_ITEM_TITLE', fieldId: 'participant_type'}),
  Object.freeze({propertyName: 'PROFILE_PRIVACY_ACK_ITEM_TITLE', fieldId: 'privacy_acknowledgement'}),
]);

const FULL_SHA_ACTION_REFERENCE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.\/-]+)?@[0-9a-f]{40}$/u;

const PROFILE_RAW_NATIVE_CONTRACT = Object.freeze({
  headerPolicy: 'google-forms-managed-variable',
  columnCountPolicy: 'google-forms-managed-variable',
  scriptReadsCells: false,
  scriptWritesCells: false,
  responseIdColumn: false,
  responseIdSource: 'FormResponse.getId()',
  responseIdTarget: '40_Supplemental.profile_response_id',
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateExactKeys(value, expectedKeys, label, failures) {
  if (!isObject(value)) {
    failures.push(`${label}: expected an object`);
    return false;
  }
  const actualKeys = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'));
  const expected = [...expectedKeys].sort((left, right) => left.localeCompare(right, 'en'));
  if (actualKeys.length !== expected.length
    || actualKeys.some((key, index) => key !== expected[index])) {
    failures.push(`${label}: expected exactly ${expected.join(', ')}`);
  }
  return true;
}

function validFullShaActionReference(reference) {
  if (typeof reference !== 'string' || !FULL_SHA_ACTION_REFERENCE.test(reference)) return false;
  const locator = reference.slice(0, reference.lastIndexOf('@'));
  return locator.split('/').every((segment) => segment !== '.' && segment !== '..');
}

export function extractExternalActionUses(workflowSource) {
  const failures = [];
  const externalUses = [];
  if (typeof workflowSource !== 'string') {
    return {externalUses, failures: ['.github/workflows/ci.yml: expected text']};
  }

  let blockScalarIndent = null;
  for (const [index, line] of workflowSource.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    const indentation = /^\s*/u.exec(line)?.[0].length ?? 0;
    if (blockScalarIndent !== null) {
      if (trimmed === '') continue;
      if (indentation > blockScalarIndent) continue;
      blockScalarIndent = null;
    }

    const usesDirective = /^\s*(?:-\s*)?uses\s*:\s*(.*?)\s*$/u.exec(line);
    if (usesDirective) {
      let reference;
      const rawValue = usesDirective[1];
      const quotedValue = /^(?:"([^"\r\n]+)"|'([^'\r\n]+)')\s*(?:#.*)?$/u.exec(rawValue);
      if (quotedValue) {
        reference = quotedValue[1] ?? quotedValue[2];
      } else {
        reference = rawValue.replace(/\s+#.*$/u, '').trim();
      }
      if (reference === '' || /\s/u.test(reference)) {
        failures.push(`.github/workflows/ci.yml:${index + 1}: uses must be a single literal reference`);
        continue;
      }
      if (!reference.startsWith('./')) externalUses.push(reference);
      continue;
    }

    if (!trimmed.startsWith('#') && /(?:^|[{,])\s*uses\s*:/u.test(line)) {
      failures.push(`.github/workflows/ci.yml:${index + 1}: uses must use a standalone literal YAML key`);
      continue;
    }

    if (/^\s*(?:-\s*)?[A-Za-z0-9_.-]+\s*:\s*[>|][0-9+-]*\s*(?:#.*)?$/u.test(line)) {
      blockScalarIndent = indentation;
    }
  }

  return {externalUses, failures};
}

export function validateGithubActionsPolicy(permissions, selectedActions, workflowSource) {
  const failures = [];
  const permissionsValid = validateExactKeys(
    permissions,
    ['enabled', 'allowed_actions', 'sha_pinning_required'],
    'github-actions-permissions',
    failures,
  );
  if (permissionsValid) {
    if (permissions.enabled !== true) failures.push('github-actions-permissions.enabled must be true');
    if (permissions.allowed_actions !== 'selected') {
      failures.push('github-actions-permissions.allowed_actions must be selected');
    }
    if (permissions.sha_pinning_required !== true) {
      failures.push('github-actions-permissions.sha_pinning_required must be true');
    }
  }

  const selectedActionsValid = validateExactKeys(
    selectedActions,
    ['github_owned_allowed', 'verified_allowed', 'patterns_allowed'],
    'github-actions-selected-actions',
    failures,
  );
  let configuredReferences = [];
  if (selectedActionsValid) {
    if (selectedActions.github_owned_allowed !== false) {
      failures.push('github-actions-selected-actions.github_owned_allowed must be false');
    }
    if (selectedActions.verified_allowed !== false) {
      failures.push('github-actions-selected-actions.verified_allowed must be false');
    }
    if (!Array.isArray(selectedActions.patterns_allowed)) {
      failures.push('github-actions-selected-actions.patterns_allowed: expected an array');
    } else {
      configuredReferences = selectedActions.patterns_allowed;
      const seen = new Set();
      for (const [index, reference] of configuredReferences.entries()) {
        if (!validFullShaActionReference(reference)) {
          failures.push(`github-actions-selected-actions.patterns_allowed[${index}]: expected an exact action pinned to a lowercase 40-character SHA`);
        }
        if (seen.has(reference)) {
          failures.push(`github-actions-selected-actions.patterns_allowed: duplicate ${reference}`);
        }
        seen.add(reference);
      }
    }
  }

  const extracted = extractExternalActionUses(workflowSource);
  failures.push(...extracted.failures);
  for (const [index, reference] of extracted.externalUses.entries()) {
    if (!validFullShaActionReference(reference)) {
      failures.push(`.github/workflows/ci.yml external uses[${index}]: ${reference} is not pinned to a lowercase 40-character SHA`);
    }
  }

  const workflowReferences = new Set(extracted.externalUses);
  const configuredReferenceSet = new Set(configuredReferences.filter((reference) => typeof reference === 'string'));
  for (const reference of workflowReferences) {
    if (!configuredReferenceSet.has(reference)) {
      failures.push(`github-actions-selected-actions.patterns_allowed: missing workflow external use ${reference}`);
    }
  }
  for (const reference of configuredReferenceSet) {
    if (!workflowReferences.has(reference)) {
      failures.push(`github-actions-selected-actions.patterns_allowed: allows action not used by workflow ${reference}`);
    }
  }

  return failures;
}

export function validateProfileFormItemTitleDefaults(scriptProperties, formBlueprint) {
  const failures = [];
  const properties = Array.isArray(scriptProperties?.properties) ? scriptProperties.properties : [];
  const fields = Array.isArray(formBlueprint?.form?.fields) ? formBlueprint.form.fields : [];
  const propertiesByName = new Map(properties.map((property) => [property?.name, property]));
  const fieldsById = new Map(fields.map((field) => [field?.id, field]));
  const expectedPropertyNames = new Set(PROFILE_FORM_ITEM_TITLE_BINDINGS.map(({propertyName}) => propertyName));

  for (const property of properties) {
    if (/^PROFILE_[A-Z0-9_]+_ITEM_TITLE$/u.test(property?.name ?? '')
      && !expectedPropertyNames.has(property.name)) {
      failures.push(`script-properties.names.${property.name}: profile Form item-title property is not mapped to form-blueprint`);
    }
  }

  for (const {propertyName, fieldId} of PROFILE_FORM_ITEM_TITLE_BINDINGS) {
    const property = propertiesByName.get(propertyName);
    const field = fieldsById.get(fieldId);
    if (!property) {
      failures.push(`script-properties.names.${propertyName}: missing canonical profile Form item-title property`);
      continue;
    }
    if (!field) {
      failures.push(`form-blueprint.form.fields: missing canonical ${fieldId} for ${propertyName}`);
      continue;
    }
    if (typeof field.label !== 'string' || field.label.trim() === '') {
      failures.push(`form-blueprint.${fieldId}.label: expected a non-empty string`);
      continue;
    }
    if (property.default !== field.label) {
      failures.push(`script-properties.names.${propertyName}.default must exactly match form-blueprint ${fieldId}.label`);
    }
  }

  return failures;
}

/**
 * Keep the Google Forms response tab outside the managed Sheet schema. Google
 * Forms controls its headers and column count and does not expose the durable
 * response ID as a native response-sheet column; the installable event is the
 * sole identity source used by matching/retry code.
 */
export function validateNativeProfileRawContract(sheetsSchema, formBlueprint) {
  const failures = [];
  const tabs = Array.isArray(sheetsSchema?.tabs) ? sheetsSchema.tabs : [];
  const candidates = tabs.filter((tab) => tab?.name === '30_Profile_RAW');
  if (candidates.length !== 1) {
    failures.push('sheets-schema.30_Profile_RAW: expected exactly one native Form tab contract');
    return failures;
  }
  const raw = candidates[0];
  if (raw.owner !== 'google-form-only') failures.push('30_Profile_RAW.owner must be google-form-only');
  if (raw.writeMode !== 'never-edit') failures.push('30_Profile_RAW.writeMode must be never-edit');
  if (raw.schemaMode !== 'google-forms-native-opaque') {
    failures.push('30_Profile_RAW.schemaMode must be google-forms-native-opaque');
  }
  if (raw.primaryKey !== null) failures.push('30_Profile_RAW.primaryKey must be null');
  if (!Array.isArray(raw.columns) || raw.columns.length !== 0) {
    failures.push('30_Profile_RAW.columns must be empty because native headers are variable');
  }
  if (validateExactKeys(
    raw.nativeContract,
    Object.keys(PROFILE_RAW_NATIVE_CONTRACT),
    '30_Profile_RAW.nativeContract',
    failures,
  )) {
    for (const [key, expected] of Object.entries(PROFILE_RAW_NATIVE_CONTRACT)) {
      if (raw.nativeContract[key] !== expected) {
        failures.push(`30_Profile_RAW.nativeContract.${key} must be ${String(expected)}`);
      }
    }
  }

  const matching = formBlueprint?.matching;
  if (matching?.responseIdentitySource !== PROFILE_RAW_NATIVE_CONTRACT.responseIdSource) {
    failures.push('form.matching.responseIdentitySource must be FormResponse.getId()');
  }
  if (matching?.responseIdentityStorage !== PROFILE_RAW_NATIVE_CONTRACT.responseIdTarget) {
    failures.push('form.matching.responseIdentityStorage must be 40_Supplemental.profile_response_id');
  }
  if (matching?.rawSheetHasResponseIdColumn !== false) {
    failures.push('form.matching.rawSheetHasResponseIdColumn must be false');
  }
  if (Object.hasOwn(matching ?? {}, 'primaryKey')) {
    failures.push('form.matching.primaryKey must not imply a native RAW response-ID column');
  }
  return failures;
}

export {PROFILE_FORM_ITEM_TITLE_BINDINGS, PROFILE_RAW_NATIVE_CONTRACT};
