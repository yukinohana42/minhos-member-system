import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  validateGithubActionsPolicy,
  validateNativeProfileRawContract,
  validateProfileFormItemTitleDefaults,
} from './config-contracts.mjs';

const root = process.cwd();
const failures = [];
const loaded = new Map();

async function loadJson(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!existsSync(absolutePath)) {
    failures.push(`${relativePath}: file is missing`);
    return null;
  }
  try {
    const value = JSON.parse(await readFile(absolutePath, 'utf8'));
    loaded.set(relativePath, value);
    return value;
  } catch (error) {
    failures.push(`${relativePath}: invalid JSON (${error.message})`);
    return null;
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') failures.push(`${label}: expected a non-empty string`);
}

function requireUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) failures.push(`${label}: duplicate ${value}`);
    seen.add(value);
  }
}

function isWithinTrustedPropertyHelper(source, callIndex, helper) {
  const declarations = [...source.matchAll(helper.pattern)]
    .filter((match) => (match.index ?? -1) < callIndex);
  const declaration = declarations.at(-1);
  if (!declaration) return false;

  if (helper.kind === 'line') {
    const lineEnd = source.indexOf('\n', declaration.index ?? 0);
    return callIndex < (lineEnd < 0 ? source.length : lineEnd);
  }

  const openBrace = source.indexOf('{', declaration.index ?? 0);
  if (openBrace < 0 || openBrace > callIndex) return false;
  return callIndex < matchingBrace(source, openBrace);
}

function matchingBrace(source, openBrace) {
  let depth = 0;
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  for (let index = openBrace; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (current === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (current === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (current === '\\') {
        index += 1;
      } else if (current === quote) {
        quote = '';
      }
      continue;
    }
    if (current === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (current === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (current === '"' || current === "'" || current === '`') {
      quote = current;
    } else if (current === '{') {
      depth += 1;
    } else if (current === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return source.length;
}

const policy = await loadJson('config/harness-policy.json');
const services = await loadJson('config/external-services.json');
const sheets = await loadJson('config/sheets-schema.json');
const form = await loadJson('config/form-blueprint.json');
const trace = await loadJson('config/requirements-trace.json');
const scriptProperties = await loadJson('packages/apps-script/script-properties.names.json');
const dependencyAuditPolicy = await loadJson('config/dependency-audit-policy.json');
const releaseStatus = await loadJson('config/release-status.json');
const githubMainProtection = await loadJson('config/github-main-protection.json');
const githubActionsPermissions = await loadJson('config/github-actions-permissions.json');
const githubActionsSelectedActions = await loadJson('config/github-actions-selected-actions.json');
let githubCiWorkflow = null;
try {
  githubCiWorkflow = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8');
} catch (error) {
  failures.push(`.github/workflows/ci.yml: cannot read (${error.message})`);
}
const appsScriptSourceRoot = path.join(root, 'packages/apps-script/src');
const appsScriptSourceFiles = existsSync(appsScriptSourceRoot)
  ? (await readdir(appsScriptSourceRoot, {recursive: true}))
      .filter((entry) => typeof entry === 'string' && entry.endsWith('.ts'))
      .sort((left, right) => left.localeCompare(right, 'en'))
  : [];
const appsScriptPropertySource = (await Promise.all(
  appsScriptSourceFiles.map((entry) => readFile(path.join(appsScriptSourceRoot, entry), 'utf8')),
)).join('\n');

const requiredServiceIds = ['ghost', 'stripe', 'google-workspace', 'youtube', 'dropbox', 'dns'];
const requiredTabColumns = new Map([
  ['00_Dashboard', ['metric', 'value', 'updated_at', 'description']],
  ['10_Members', ['member_row_key', 'minhos_member_id', 'ghost_site_id', 'ghost_member_id', 'ghost_access_state', 'profile_status', 'ops_flags', 'source_present_ghost', 'last_seen_ghost_run_id']],
  ['20_Subscriptions', ['subscription_row_key', 'stripe_account_id', 'livemode', 'stripe_subscription_id', 'stripe_status', 'ghost_projected_status', 'open_invoice_count', 'source_present_stripe', 'last_seen_stripe_run_id']],
  ['21_AccessGrants', ['grant_key', 'ghost_member_id', 'tier_id', 'grant_kind', 'source_present_ghost']],
  ['25_BillingSignals', ['signal_key', 'object_type', 'stripe_subscription_id', 'raw_status', 'needs_action', 'last_seen_run_id']],
  ['40_Supplemental', ['minhos_member_id', 'ghost_member_id', 'profile_response_id', 'verification_status', 'ops_note']],
  ['50_Exceptions', ['exception_key', 'severity', 'exception_type', 'status', 'related_sync_run_id']],
  ['60_ContentRegistry', ['lecture_id', 'ghost_post_id', 'youtube_video_id', 'dropbox_shared_link', 'pdf_version', 'rights_checked_at']],
  ['80_OpsLog', ['ops_log_id', 'operation_type', 'operator', 'occurred_at', 'approver']],
  ['90_SyncLog', ['run_id', 'run_type', 'started_at', 'finished_at', 'completed', 'error_summary', 'code_version']],
  ['99_Config', ['config_key', 'config_value_non_secret', 'description', 'updated_at', 'updated_by']],
]);
const requiredDashboardMetrics = [
  'ghost_registered_members', 'ghost_paid_access_members', 'ghost_free_or_no_access_members',
  'stripe_nonterminal_subscriptions', 'stripe_past_due_subscriptions', 'stripe_unpaid_subscriptions',
  'stripe_paused_subscriptions', 'stripe_pause_collection_subscriptions', 'stripe_open_invoice_count',
  'cancel_at_period_end_subscriptions', 'duplicate_subscription_members', 'open_disputes',
  'profile_not_submitted', 'profile_review_required', 'open_p1_exceptions', 'open_p2_exceptions',
  'last_regular_sync_success', 'last_full_sync_success', 'last_sync_result',
  'publisher_member_utilization_percent', 'publisher_warning_800', 'publisher_warning_900',
  'ghost_staff_count', 'ghost_pending_invitation_count', 'ghost_staff_and_pending_total',
];

if (dependencyAuditPolicy) {
  if (dependencyAuditPolicy.severityThreshold !== 'high') failures.push('dependency-audit-policy.severityThreshold must be high');
  if (!Array.isArray(dependencyAuditPolicy.exceptions)) failures.push('dependency-audit-policy.exceptions: expected array');
  else {
    requireUnique(dependencyAuditPolicy.exceptions.map((entry) => `${entry.packageDirectory}:${entry.advisory}`), 'dependency-audit-policy.exceptions');
    for (const entry of dependencyAuditPolicy.exceptions) {
      requireString(entry.packageDirectory, 'dependency audit exception packageDirectory');
      if (!/^GHSA-[a-z0-9-]+$/iu.test(entry.advisory ?? '')) failures.push(`${entry.packageDirectory}.advisory: expected GHSA identifier`);
      if (!Number.isInteger(entry.source) || entry.source <= 0) failures.push(`${entry.advisory}.source: expected positive npm advisory source ID`);
      if (entry.scope !== 'development-only') failures.push(`${entry.advisory}.scope: only development-only exceptions are permitted`);
      requireString(entry.reason, `${entry.advisory}.reason`);
      requireString(entry.owner, `${entry.advisory}.owner`);
      requireString(entry.reviewBy, `${entry.advisory}.reviewBy`);
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(entry.reviewBy ?? '')) failures.push(`${entry.advisory}.reviewBy: expected YYYY-MM-DD`);
      if (!Array.isArray(entry.vulnerabilityNames) || entry.vulnerabilityNames.length === 0) failures.push(`${entry.advisory}.vulnerabilityNames: expected array`);
      if (!Array.isArray(entry.dependencyPath) || entry.dependencyPath.length < 2) {
        failures.push(`${entry.advisory}.dependencyPath: expected at least two exact package/version steps`);
      } else {
        const dependencyPathNames = entry.dependencyPath.map((step) => step?.name);
        requireUnique(dependencyPathNames, `${entry.advisory}.dependencyPath.name`);
        for (const [index, step] of entry.dependencyPath.entries()) {
          requireString(step?.name, `${entry.advisory}.dependencyPath[${index}].name`);
          if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(step?.version ?? '')) {
            failures.push(`${entry.advisory}.dependencyPath[${index}].version: expected an exact version`);
          }
        }
        const vulnerabilityNames = new Set(entry.vulnerabilityNames ?? []);
        if (dependencyPathNames.length !== vulnerabilityNames.size || dependencyPathNames.some((name) => !vulnerabilityNames.has(name))) {
          failures.push(`${entry.advisory}.dependencyPath: names must exactly match vulnerabilityNames`);
        }
      }
      if (!Array.isArray(entry.mitigations) || entry.mitigations.length === 0) failures.push(`${entry.advisory}.mitigations: expected array`);
    }
  }
}

if (githubMainProtection) {
  const expectedBooleanFields = new Map([
    ['enforce_admins', true],
    ['required_linear_history', true],
    ['allow_force_pushes', false],
    ['allow_deletions', false],
    ['block_creations', false],
    ['required_conversation_resolution', true],
    ['lock_branch', false],
  ]);
  if (githubMainProtection.required_status_checks?.strict !== true) failures.push('github-main-protection.required_status_checks.strict must be true');
  if (!Array.isArray(githubMainProtection.required_status_checks?.contexts)
    || githubMainProtection.required_status_checks.contexts.length !== 1
    || githubMainProtection.required_status_checks.contexts[0] !== 'verify') {
    failures.push('github-main-protection.required_status_checks.contexts must be exactly [verify]');
  }
  if (!Array.isArray(githubMainProtection.required_status_checks?.checks)
    || githubMainProtection.required_status_checks.checks.length !== 1
    || githubMainProtection.required_status_checks.checks[0]?.context !== 'verify'
    || githubMainProtection.required_status_checks.checks[0]?.app_id !== 15368
    || Object.keys(githubMainProtection.required_status_checks.checks[0] ?? {}).sort().join(',') !== 'app_id,context') {
    failures.push('github-main-protection.required_status_checks.checks must bind verify exactly to GitHub Actions app_id 15368');
  }
  if (githubMainProtection.required_pull_request_reviews !== null) failures.push('github-main-protection.required_pull_request_reviews must be null for the current solo-owner phase');
  if (githubMainProtection.restrictions !== null) failures.push('github-main-protection.restrictions must be null');
  for (const [field, expected] of expectedBooleanFields) {
    if (githubMainProtection[field] !== expected) failures.push(`github-main-protection.${field} must be ${expected}`);
  }
}

if (githubActionsPermissions && githubActionsSelectedActions && githubCiWorkflow !== null) {
  failures.push(...validateGithubActionsPolicy(
    githubActionsPermissions,
    githubActionsSelectedActions,
    githubCiWorkflow,
  ));
}

if (policy) {
  requireString(policy.schemaVersion, 'harness-policy.schemaVersion');
  requireString(policy.requirementsDocument, 'harness-policy.requirementsDocument');
  if (!Array.isArray(policy.changeBoundary?.protected)) failures.push('harness-policy.changeBoundary.protected: expected array');
  if (!Array.isArray(policy.changeBoundary?.harnessOwned)) failures.push('harness-policy.changeBoundary.harnessOwned: expected array');
  if (policy.externalConnectionPolicy?.secretValuesAllowedInRepository !== false) failures.push('harness-policy: secretValuesAllowedInRepository must be false');
  if (policy.verification?.network !== false) failures.push('harness-policy.verification.network must be false');
  if (policy.verification?.livePayments !== false) failures.push('harness-policy.verification.livePayments must be false');
  if (policy.releaseGate?.targetEnvironment !== 'production') failures.push('harness-policy.releaseGate.targetEnvironment must be production');
  if (policy.releaseGate?.requirementsVersion !== 'v1.1') failures.push('harness-policy.releaseGate.requirementsVersion must be v1.1');
  requireString(policy.releaseGate?.artifactPath, 'harness-policy.releaseGate.artifactPath');
  if (!Array.isArray(policy.releaseGate?.requiredBlockers) || policy.releaseGate.requiredBlockers.length === 0) {
    failures.push('harness-policy.releaseGate.requiredBlockers: expected a non-empty array');
  } else {
    requireUnique(policy.releaseGate.requiredBlockers.map((blocker) => blocker.id), 'harness-policy.releaseGate.requiredBlockers');
    for (const blocker of policy.releaseGate.requiredBlockers) {
      requireString(blocker.id, 'release gate blocker id');
      if (!['P1', 'P2'].includes(blocker.severity)) failures.push(`${blocker.id}.severity: canonical release blockers must be P1 or P2`);
      requireString(blocker.owner, `${blocker.id}.owner`);
      requireString(blocker.description, `${blocker.id}.description`);
    }
  }
}

if (releaseStatus && policy?.releaseGate) {
  if (releaseStatus.schemaVersion !== '2.0') failures.push('release-status.schemaVersion must be 2.0');
  if (releaseStatus.environment !== policy.releaseGate.targetEnvironment) failures.push('release-status.environment must match harness-policy.releaseGate');
  if (releaseStatus.productionOnly !== true) failures.push('release-status.productionOnly must be true');
  if (releaseStatus.release?.requirementsVersion !== policy.releaseGate.requirementsVersion) failures.push('release-status.release.requirementsVersion must match harness-policy.releaseGate');
  if (!Array.isArray(releaseStatus.blockers)) failures.push('release-status.blockers: expected array');
  else {
    const blockersById = new Map(releaseStatus.blockers.map((blocker) => [blocker.id, blocker]));
    for (const expected of policy.releaseGate.requiredBlockers) {
      const actual = blockersById.get(expected.id);
      if (!actual) {
        failures.push(`release-status.blockers: missing canonical ${expected.id}`);
        continue;
      }
      for (const field of ['severity', 'owner', 'description']) {
        if (actual[field] !== expected[field]) failures.push(`release-status.${expected.id}.${field}: must match harness-policy.releaseGate`);
      }
    }
  }
}

if (services) {
  if (services.policy?.noCredentialValues !== true) failures.push('external-services.policy.noCredentialValues must be true');
  if (services.policy?.ownerMustPerformInitialSecretEntry !== true) failures.push('external-services.policy.ownerMustPerformInitialSecretEntry must be true');
  if (services.scriptPropertiesRegistry !== 'packages/apps-script/script-properties.names.json') failures.push('external-services.scriptPropertiesRegistry must point to the canonical registry');
  if (!Array.isArray(services.services)) failures.push('external-services.services: expected array');
  else {
    requireUnique(services.services.map((service) => service.id), 'external-services.services.id');
    const actualServiceIds = new Set(services.services.map((service) => service.id));
    for (const serviceId of requiredServiceIds) if (!actualServiceIds.has(serviceId)) failures.push(`external-services.services: missing ${serviceId}`);
    for (const serviceId of actualServiceIds) if (!requiredServiceIds.includes(serviceId)) failures.push(`external-services.services: unexpected ${serviceId}`);
    for (const service of services.services) {
      requireString(service.id, 'external service id');
      requireString(service.name, `${service.id}.name`);
      if (!Array.isArray(service.credentialNames)) failures.push(`${service.id}.credentialNames: expected array of names only`);
      if (service.credentialNames?.some((name) => /[=:]/u.test(name))) failures.push(`${service.id}.credentialNames: use names only, never assignments`);
      if (service.scriptPropertyNames !== undefined && !Array.isArray(service.scriptPropertyNames)) failures.push(`${service.id}.scriptPropertyNames: expected array`);
      if (!Array.isArray(service.readOnlyChecks) || service.readOnlyChecks.length === 0) failures.push(`${service.id}.readOnlyChecks: expected at least one read-only check`);
      if (!Array.isArray(service.productionActionsRequiringApproval) || service.productionActionsRequiringApproval.length === 0) failures.push(`${service.id}.productionActionsRequiringApproval: expected explicit approval boundary`);
    }
  }
}

if (scriptProperties) {
  if (!Array.isArray(scriptProperties.managedStateKeyPrefixes) || scriptProperties.managedStateKeyPrefixes.length === 0) {
    failures.push('script-properties.names.managedStateKeyPrefixes: expected a non-empty array');
  } else {
    requireUnique(scriptProperties.managedStateKeyPrefixes, 'script-properties.names.managedStateKeyPrefixes');
    for (const prefix of scriptProperties.managedStateKeyPrefixes) {
      if (!/^[A-Z][A-Z0-9_]+:?$/u.test(prefix ?? '')) failures.push(`managed state key prefix ${prefix}: invalid format`);
    }
  }
  if (!Array.isArray(scriptProperties.properties) || scriptProperties.properties.length === 0) {
    failures.push('script-properties.names.properties: expected a non-empty array');
  } else {
    const names = scriptProperties.properties.map((property) => property.name);
    requireUnique(names, 'script-properties.names.properties.name');
    const allowedRequirements = new Set(['required', 'conditional', 'optional']);
    for (const property of scriptProperties.properties) {
      requireString(property.name, 'script property name');
      requireString(property.service, `${property.name}.service`);
      requireString(property.description, `${property.name}.description`);
      if (!/^[A-Z][A-Z0-9_]+$/u.test(property.name ?? '')) failures.push(`${property.name}: invalid Script Property name`);
      if (typeof property.secret !== 'boolean') failures.push(`${property.name}.secret: expected boolean`);
      if (!allowedRequirements.has(property.requirement)) failures.push(`${property.name}.requirement: expected required, conditional, or optional`);
      if (property.requirement === 'conditional') requireString(property.condition, `${property.name}.condition`);
      if (property.secret === true && property.default !== undefined) failures.push(`${property.name}: secret properties cannot have defaults`);
    }

    if (services?.services) {
      const assigned = services.services.flatMap((service) => (service.scriptPropertyNames ?? []).map((name) => ({name, service: service.id})));
      requireUnique(assigned.map((item) => item.name), 'external-services.scriptPropertyNames');
      const registryNames = new Set(names);
      for (const item of assigned) {
        if (!registryNames.has(item.name)) failures.push(`${item.service}.scriptPropertyNames: unknown ${item.name}`);
        const registryProperty = scriptProperties.properties.find((property) => property.name === item.name);
        if (registryProperty && registryProperty.service !== item.service) failures.push(`${item.name}: registry service ${registryProperty.service} differs from ${item.service}`);
      }
      for (const name of names) {
        if (!assigned.some((item) => item.name === name)) failures.push(`script property ${name}: not assigned to an external service`);
      }
    }

    const implementationPropertyNames = new Set([
      ...[...appsScriptPropertySource.matchAll(/(?:required|get|getProperty)\(\s*["']([A-Z][A-Z0-9_]+)["']\s*\)/gu)].map((match) => match[1]),
      ...[...appsScriptPropertySource.matchAll(/(?:propertyOr|requiredProperty)\(properties,\s*["']([A-Z][A-Z0-9_]+)["']/gu)].map((match) => match[1]),
    ]);
    for (const name of implementationPropertyNames) {
      if (!names.includes(name)) failures.push(`Apps Script implementation property ${name}: missing from canonical registry`);
    }
    for (const name of names) {
      if (!implementationPropertyNames.has(name)) failures.push(`canonical Script Property ${name}: not referenced by the Apps Script implementation`);
    }

    const managedStateKeyPrefixes = scriptProperties.managedStateKeyPrefixes ?? [];
    const internalPropertyConstants = [...appsScriptPropertySource.matchAll(/const\s+[A-Z][A-Z0-9_]*PROPERTY[A-Z0-9_]*\s*=\s*["']([A-Z][A-Z0-9_]+)["']/gu)].map((match) => match[1]);
    const stateKeyLiterals = [...appsScriptPropertySource.matchAll(/stateKey\(\s*["']([A-Z][A-Z0-9_]+)["']\s*\)/gu)].map((match) => `${match[1]}:`);
    for (const stateKey of internalPropertyConstants) {
      if (!managedStateKeyPrefixes.includes(stateKey) && !managedStateKeyPrefixes.includes(`${stateKey}:`)) {
        failures.push(`Apps Script managed state key ${stateKey}: missing from managedStateKeyPrefixes`);
      }
    }
    for (const stateKey of stateKeyLiterals) {
      if (!managedStateKeyPrefixes.includes(stateKey)) failures.push(`Apps Script managed state key ${stateKey}: missing from managedStateKeyPrefixes`);
    }
    for (const requiredPrefix of [
      'REFUND_WATERMARK_UNIX:',
      'DISPUTE_WATERMARK_UNIX:',
      'PROFILE_FORM_RETRY_QUARANTINE_JSON:',
      'PROFILE_FORM_RETRY_SUCCESSOR_UID:',
      'PROFILE_FORM_RETRY_SUCCESSOR_QUARANTINE_JSON:',
    ]) {
      if (!managedStateKeyPrefixes.includes(requiredPrefix)) failures.push(`managedStateKeyPrefixes: missing required dynamic prefix ${requiredPrefix}`);
    }

    const trustedDynamicPropertyAccesses = new Map([
      ['config.ts', [
        {
          call: /properties\.getProperty\(\s*name\s*\)/u,
          helper: {kind: 'line', pattern: /\bconst\s+get\s*=\s*\([^)]*\)\s*:\s*string\s*=>/gu},
        },
      ]],
      ['index.ts', [
        {
          call: /properties\.setProperty\(\s*name\s*,\s*value\s*\)/u,
          helper: {kind: 'block', pattern: /\bfunction\s+setInternalProperty\s*\([^)]*\)[^{]*\{/gu},
        },
        {
          call: /properties\.deleteProperty\(\s*name\s*\)/u,
          helper: {kind: 'block', pattern: /\bfunction\s+deleteInternalProperty\s*\([^)]*\)[^{]*\{/gu},
        },
        {
          call: /properties\.getProperty\(\s*name\s*\)/u,
          helper: {kind: 'block', pattern: /\bfunction\s+requiredProperty\s*\([^)]*\)[^{]*\{/gu},
        },
        {
          call: /properties\.getProperty\(\s*name\s*\)/u,
          helper: {kind: 'block', pattern: /\bfunction\s+propertyOr\s*\([^)]*\)[^{]*\{/gu},
        },
      ]],
      ['adapters/run-coordination.ts', [
        {
          call: /this\.properties\.setProperty\(\s*name\s*,\s*value\s*\)/u,
          helper: {kind: 'block', pattern: /\bprivate\s+setProperty\s*\([^)]*\)[^{]*\{/gu},
        },
      ]],
      ['sync/sync-service.ts', [
        {
          call: /this\.deps\.properties\.setProperty\(\s*name\s*,\s*value\s*\)/u,
          helper: {kind: 'block', pattern: /\bprivate\s+setStateProperty\s*\([^)]*\)[^{]*\{/gu},
        },
      ]],
    ]);

    for (const source of await Promise.all(
      appsScriptSourceFiles.map(async (entry) => ({entry, source: await readFile(path.join(appsScriptSourceRoot, entry), 'utf8')})),
    )) {
      const sourceFile = source.entry;
      const normalizedSourceFile = sourceFile.replaceAll('\\', '/');
      const dynamicCalls = [...source.source.matchAll(/(?:getProperty|setProperty|deleteProperty)\(\s*(?!["'])([^,\n)]+(?:\([^\n)]*\))?)/gu)];
      for (const match of dynamicCalls) {
        const argument = match[1].trim();
        // A method declaration such as `setProperty(name: string, ...)` is not
        // a property access. Exclude only this explicit TypeScript declaration
        // shape so a real dynamic call cannot be hidden by a broad heuristic.
        if (/^[A-Za-z_$][\w$]*\s*:\s*[A-Za-z_$]/u.test(argument)) continue;
        const helperPatterns = trustedDynamicPropertyAccesses.get(normalizedSourceFile) ?? [];
        const callStart = match.index ?? -1;
        const callContext = source.source.slice(Math.max(0, callStart - 80), callStart + 160);
        const helperNameAllowed = argument === 'name'
          && helperPatterns.some(({call, helper}) =>
            call.test(callContext) && isWithinTrustedPropertyHelper(source.source, callStart, helper));
        const managedStateAllowed = argument === 'LEASE_PROPERTY'
          || /^this\.(?:stateKey|cursorProperty|cursorQuarantineProperty)\(/u.test(argument);
        if (!helperNameAllowed && !managedStateAllowed) {
          failures.push(`Apps Script ${sourceFile}: unclassified dynamic Script Property access ${argument}`);
        }
      }
    }
  }
}

if (sheets) {
  if (sheets.spreadsheet?.timezone !== 'Asia/Tokyo') failures.push('sheets-schema.spreadsheet.timezone must be Asia/Tokyo');
  if (sheets.spreadsheet?.sourceOfTruthPolicy?.billing !== 'Stripe') failures.push('sheets-schema: billing source of truth must be Stripe');
  if (sheets.spreadsheet?.sourceOfTruthPolicy?.access !== 'Ghost') failures.push('sheets-schema: access source of truth must be Ghost');
  if (!Array.isArray(sheets.tabs)) failures.push('sheets-schema.tabs: expected array');
  else {
    requireUnique(sheets.tabs.map((tab) => tab.name), 'sheets-schema.tabs.name');
    const tabsByName = new Map(sheets.tabs.map((tab) => [tab.name, tab]));
    for (const [tabName, requiredColumns] of requiredTabColumns) {
      const tab = tabsByName.get(tabName);
      if (!tab) {
        failures.push(`sheets-schema.tabs: missing ${tabName}`);
        continue;
      }
      for (const column of requiredColumns) if (!tab.columns?.includes(column)) failures.push(`${tabName}.columns: missing ${column}`);
    }
    for (const tabName of tabsByName.keys()) {
      if (tabName !== '30_Profile_RAW' && !requiredTabColumns.has(tabName)) {
        failures.push(`sheets-schema.tabs: unexpected ${tabName}`);
      }
    }
    for (const tab of sheets.tabs) {
      requireString(tab.name, 'sheet tab name');
      requireString(tab.owner, `${tab.name}.owner`);
      requireString(tab.writeMode, `${tab.name}.writeMode`);
      if (tab.name !== '30_Profile_RAW'
        && (!Array.isArray(tab.columns) || tab.columns.length === 0)) {
        failures.push(`${tab.name}.columns: expected at least one column`);
      }
      if (tab.name === '80_OpsLog' && tab.writeMode !== 'append-only') failures.push('80_OpsLog must be append-only');
      if (tab.name === '00_Dashboard') {
        for (const metric of requiredDashboardMetrics) if (!tab.requiredMetrics?.includes(metric)) failures.push(`00_Dashboard.requiredMetrics: missing ${metric}`);
      }
    }
  }
}

if (sheets && form) failures.push(...validateNativeProfileRawContract(sheets, form));

if (form) {
  if (form.form?.audience !== 'paid-members-only') failures.push('form.form.audience must be paid-members-only');
  if (form.form?.access !== 'linked-from-paid-welcome-page-only') failures.push('form.form.access must be linked-from-paid-welcome-page-only');
  if (form.form?.publicUrlPolicy !== 'never-place-url-in-public-pages-or-email') failures.push('form.form.publicUrlPolicy is too broad');
  if (!Array.isArray(form.form?.fields) || form.form.fields.length === 0) failures.push('form.form.fields: expected at least one field');
  else {
    requireUnique(form.form.fields.map((field) => field.id), 'form.form.fields.id');
    for (const field of form.form.fields) {
      requireString(field.id, 'form field id');
      requireString(field.type, `${field.id}.type`);
      if (field.sensitive === true) failures.push(`${field.id}: sensitive fields are forbidden in the profile form`);
    }
  }
  if (!Array.isArray(form.forbiddenFields) || !form.forbiddenFields.includes('card_number')) failures.push('form.forbiddenFields must include card_number');
  if (form.matching?.stableJoinKeyAfterMatch !== 'ghost_member_id') failures.push('form.matching.stableJoinKeyAfterMatch must be ghost_member_id');
}

if (form && scriptProperties) {
  failures.push(...validateProfileFormItemTitleDefaults(scriptProperties, form));
}

if (trace) {
  requireString(trace.requirementsDocument, 'requirements-trace.requirementsDocument');
  if (!Array.isArray(trace.groups) || trace.groups.length === 0) failures.push('requirements-trace.groups: expected groups');
  else {
    requireUnique(trace.groups.map((group) => group.prefix), 'requirements-trace.groups.prefix');
    for (const group of trace.groups) {
      requireString(group.prefix, 'requirements group prefix');
      if (!Array.isArray(group.requirements) || group.requirements.length === 0) failures.push(`${group.prefix}.requirements: expected explicit requirement IDs`);
      if (!Array.isArray(group.acceptanceIds) || group.acceptanceIds.length === 0) failures.push(`${group.prefix}.acceptanceIds: expected at least one test`);
      if (!Array.isArray(group.evidence) || group.evidence.length === 0) failures.push(`${group.prefix}.evidence: expected evidence types`);
    }
  }
  requireUnique(trace.requiredAcceptanceIds ?? [], 'requirements-trace.requiredAcceptanceIds');
}

if (failures.length > 0) {
  console.error(`CONFIG_CHECK_FAILED (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`CONFIG_OK ${loaded.size} files validated`);
}
