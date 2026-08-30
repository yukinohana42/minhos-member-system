import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This digest is deliberately code-owned, not read from requirements-trace.json.
// Updating the config or requirements document cannot approve its own semantic
// change; a reviewer must audit the canonical contract and update this value in
// a separate, visible code diff.
const EXPECTED_SEMANTIC_CONTRACT_SHA256 = 'dbe0da0f37777e0975fd740874589d37d32a767bb7f054dd73cd54748d014a0b';

const EXPECTED_INVARIANTS = [
  {
    id: 'INV-01',
    statement: 'Ghost controls access; Stripe controls billing; Sheets never controls either.',
    requirements: ['PAY-03', 'SYNC-09', 'SYNC-14', 'SEC-05'],
    acceptance: ['AT-09', 'AT-20', 'AT-28', 'AT-34'],
  },
  {
    id: 'INV-02',
    statement: 'External media URLs appear only inside paid-member content and remain shareable after retrieval in MVP.',
    requirements: ['CNT-04', 'CNT-05'],
    acceptance: ['AT-09', 'AT-10', 'AT-29', 'AT-30'],
  },
  {
    id: 'INV-03',
    statement: 'Incomplete source scans never tombstone records; complete scans never delete records automatically.',
    requirements: ['SYNC-06', 'SYNC-11'],
    acceptance: ['AT-25', 'AT-40'],
  },
  {
    id: 'INV-04',
    statement: 'Initial credential creation and production writes are owner-approved and secrets stay outside the repository.',
    requirements: ['SEC-03', 'SEC-04', 'SEC-08'],
    acceptance: ['AT-28', 'AT-37'],
  },
];

function normalizeSemanticText(value) {
  return typeof value === 'string'
    ? value.normalize('NFC').replace(/\s+/gu, ' ').trim()
    : '';
}

function semanticTextLength(value) {
  return normalizeSemanticText(value).replace(/[\s`*_#。、，,.・:：;；()[\]{}「」『』]/gu, '').length;
}

function compareCanonicalText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeStringArray(values) {
  return Array.isArray(values)
    ? values.map(normalizeSemanticText).sort(compareCanonicalText)
    : null;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareCanonicalText)
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function section(document, startMarker, endMarker) {
  const start = document.indexOf(startMarker);
  const end = document.indexOf(endMarker);
  return start >= 0 && end > start ? document.slice(start, end) : '';
}

function parseSemanticRows(document) {
  const featureSection = section(document, '## 9. 機能要件', '## 10. コンテンツモデルと登録規則');
  const securitySection = section(document, '### 14.1 セキュリティ', '### 14.2 プライバシー');
  const featureRequirements = [...featureSection.matchAll(/^\|\s*([A-Z][A-Z0-9-]*)\s*\|\s*(MUST|SHOULD|FUTURE)\s*\|\s*([^|\r\n]*?)\s*\|\s*$/gmu)]
    .map((match) => ({id: match[1], priority: match[2], text: normalizeSemanticText(match[3])}));
  const securityRequirements = [...securitySection.matchAll(/^\|\s*(SEC-[A-Z0-9-]+)\s*\|\s*([^|\r\n]*?)\s*\|\s*$/gmu)]
    .map((match) => ({id: match[1], priority: 'MUST', text: normalizeSemanticText(match[2])}));
  const acceptanceTests = [...document.matchAll(/^\|\s*(AT-\d+)\s*\|\s*([^|\r\n]*?)\s*\|\s*([^|\r\n]*?)\s*\|\s*$/gmu)]
    .map((match) => ({
      id: match[1],
      name: normalizeSemanticText(match[2]),
      assertion: normalizeSemanticText(match[3]),
    }));
  return {
    requirements: [...featureRequirements, ...securityRequirements]
      .sort((left, right) => compareCanonicalText(left.id, right.id)),
    acceptanceTests: acceptanceTests.sort((left, right) => compareCanonicalText(left.id, right.id)),
  };
}

export function buildRequirementsSemanticContract(trace, document) {
  const rows = parseSemanticRows(document);
  const mappings = Array.isArray(trace?.requirementMappings)
    ? trace.requirementMappings.map((mapping) => ({
        id: normalizeSemanticText(mapping.id),
        acceptanceIds: normalizeStringArray(mapping.acceptanceIds),
        operationalCheckIds: normalizeStringArray(mapping.operationalCheckIds),
      })).sort((left, right) => compareCanonicalText(left.id, right.id))
    : null;
  const operationalChecks = Array.isArray(trace?.operationalChecks)
    ? trace.operationalChecks.map((check) => ({
        id: normalizeSemanticText(check.id),
        requirementIds: normalizeStringArray(check.requirementIds),
        method: normalizeSemanticText(check.method),
        assertion: normalizeSemanticText(check.assertion),
        owner: normalizeSemanticText(check.owner),
        cadence: normalizeSemanticText(check.cadence),
        releaseApplicability: normalizeSemanticText(check.releaseApplicability),
        evidenceKinds: normalizeStringArray(check.evidenceKinds),
      })).sort((left, right) => compareCanonicalText(left.id, right.id))
    : null;
  const uxStages = Array.isArray(trace?.uxStages)
    ? trace.uxStages.map((stage) => ({
        id: normalizeSemanticText(stage.id),
        name: normalizeSemanticText(stage.name),
        acceptanceIds: normalizeStringArray(stage.acceptanceIds),
        owner: normalizeSemanticText(stage.owner),
        evidence: normalizeStringArray(stage.evidence),
      })).sort((left, right) => compareCanonicalText(left.id, right.id))
    : null;
  const invariants = Array.isArray(trace?.invariants)
    ? trace.invariants.map((invariant) => ({
        id: normalizeSemanticText(invariant.id),
        statement: normalizeSemanticText(invariant.statement),
        requirements: normalizeStringArray(invariant.requirements),
        acceptance: normalizeStringArray(invariant.acceptance),
      })).sort((left, right) => compareCanonicalText(left.id, right.id))
    : null;
  return canonicalize({
    schemaVersion: normalizeSemanticText(trace?.schemaVersion),
    requirementsDocument: normalizeSemanticText(trace?.requirementsDocument),
    acceptanceDocument: normalizeSemanticText(trace?.acceptanceDocument),
    requiredAcceptanceIds: normalizeStringArray(trace?.requiredAcceptanceIds),
    requirements: rows.requirements,
    acceptanceTests: rows.acceptanceTests,
    requirementMappings: mappings,
    operationalChecks,
    uxStages,
    crossCuttingAcceptanceIds: normalizeStringArray(trace?.crossCuttingAcceptanceIds),
    invariants,
  });
}

export function computeRequirementsSemanticContractDigest(trace, document) {
  const contract = buildRequirementsSemanticContract(trace, document);
  return createHash('sha256').update(JSON.stringify(contract), 'utf8').digest('hex');
}

function setDifference(actual, expected) {
  return [...actual].filter((value) => !expected.has(value));
}

export function validateRequirementsSemanticContract(trace, document) {
  const semanticFailures = [];
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) {
    return {failures: ['semantic contract: trace must be an object'], digest: null};
  }
  if (typeof document !== 'string' || document.trim() === '') {
    return {failures: ['semantic contract: requirements document must be non-empty'], digest: null};
  }
  const rows = parseSemanticRows(document);
  if (rows.requirements.length !== 83) {
    semanticFailures.push(`semantic contract requirements: expected 83 rows (found ${rows.requirements.length})`);
  }
  for (const requirement of rows.requirements) {
    if (semanticTextLength(requirement.text) < 12) {
      semanticFailures.push(`${requirement.id}: requirement body is too short to be meaningful`);
    }
  }
  if (rows.acceptanceTests.length !== 45) {
    semanticFailures.push(`semantic contract acceptance tests: expected 45 rows (found ${rows.acceptanceTests.length})`);
  }
  for (const acceptance of rows.acceptanceTests) {
    if (semanticTextLength(acceptance.name) < 2) {
      semanticFailures.push(`${acceptance.id}: acceptance-test name is too short to be meaningful`);
    }
    if (semanticTextLength(acceptance.assertion) < 15) {
      semanticFailures.push(`${acceptance.id}: acceptance-test body is too short to be meaningful`);
    }
  }

  const invariants = Array.isArray(trace.invariants) ? trace.invariants : [];
  if (invariants.length !== EXPECTED_INVARIANTS.length) {
    semanticFailures.push(`requirements-trace.invariants: expected exactly ${EXPECTED_INVARIANTS.length}`);
  }
  const actualInvariantIds = new Set(invariants.map(({id}) => id));
  const expectedInvariantIds = new Set(EXPECTED_INVARIANTS.map(({id}) => id));
  for (const id of setDifference(expectedInvariantIds, actualInvariantIds)) {
    semanticFailures.push(`requirements-trace.invariants: missing ${id}`);
  }
  for (const id of setDifference(actualInvariantIds, expectedInvariantIds)) {
    semanticFailures.push(`requirements-trace.invariants: unexpected ${id}`);
  }
  for (const expected of EXPECTED_INVARIANTS) {
    const matches = invariants.filter(({id}) => id === expected.id);
    if (matches.length !== 1) {
      if (matches.length > 1) semanticFailures.push(`${expected.id}: invariant is duplicated`);
      continue;
    }
    const actual = matches[0];
    if (actual.statement !== expected.statement) semanticFailures.push(`${expected.id}.statement: does not match the audited invariant`);
    const actualRequirements = new Set(Array.isArray(actual.requirements) ? actual.requirements : []);
    const expectedRequirements = new Set(expected.requirements);
    if (actualRequirements.size !== expectedRequirements.size
      || setDifference(actualRequirements, expectedRequirements).length > 0
      || setDifference(expectedRequirements, actualRequirements).length > 0) {
      semanticFailures.push(`${expected.id}.requirements: does not match the audited exact set`);
    }
    const actualAcceptance = new Set(Array.isArray(actual.acceptance) ? actual.acceptance : []);
    const expectedAcceptance = new Set(expected.acceptance);
    if (actualAcceptance.size !== expectedAcceptance.size
      || setDifference(actualAcceptance, expectedAcceptance).length > 0
      || setDifference(expectedAcceptance, actualAcceptance).length > 0) {
      semanticFailures.push(`${expected.id}.acceptance: does not match the audited exact set`);
    }
  }

  const digest = computeRequirementsSemanticContractDigest(trace, document);
  if (digest !== EXPECTED_SEMANTIC_CONTRACT_SHA256) {
    semanticFailures.push(`semantic contract SHA-256 mismatch (expected ${EXPECTED_SEMANTIC_CONTRACT_SHA256}, found ${digest})`);
  }
  return {failures: semanticFailures, digest};
}

export async function runRequirementsCheck({root = process.cwd()} = {}) {
const failures = [];

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
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

function requireExactSet(actualValues, expectedValues, label) {
  const actual = new Set(actualValues);
  const expected = new Set(expectedValues);
  for (const value of expected) {
    if (!actual.has(value)) failures.push(`${label}: missing ${value}`);
  }
  for (const value of actual) {
    if (!expected.has(value)) failures.push(`${label}: unexpected ${value}`);
  }
}

async function loadJson(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!existsSync(absolutePath)) {
    failures.push(`${relativePath}: file is missing`);
    return null;
  }
  try {
    return JSON.parse(await readFile(absolutePath, 'utf8'));
  } catch (error) {
    failures.push(`${relativePath}: invalid JSON (${error.message})`);
    return null;
  }
}

const tracePath = 'config/requirements-trace.json';
const docPath = 'docs/minhos-membership-requirements-v1.1.md';
const policyPath = 'config/harness-policy.json';
const trace = await loadJson(tracePath);
const policy = await loadJson(policyPath);
if (!existsSync(path.join(root, docPath))) failures.push(`${docPath}: file is missing`);
const document = existsSync(path.join(root, docPath))
  ? await readFile(path.join(root, docPath), 'utf8')
  : '';

if (document && trace) {
  const semanticResult = validateRequirementsSemanticContract(trace, document);
  failures.push(...semanticResult.failures);
}

// The policy is the sole source of truth for the artifact inventory. Keeping
// this list in harness-policy.json makes additions auditable and prevents the
// checker from silently drifting away from the repository contract.
const requiredArtifacts = policy?.verification?.requiredArtifacts;
if (!Array.isArray(requiredArtifacts) || requiredArtifacts.length === 0) {
  failures.push('harness-policy.verification.requiredArtifacts: expected a non-empty array');
} else {
  requireUnique(requiredArtifacts, 'harness-policy.verification.requiredArtifacts');
  for (const artifact of requiredArtifacts) {
    requireString(artifact, 'harness-policy.verification.requiredArtifacts entry');
    if (typeof artifact === 'string' && !existsSync(path.join(root, artifact))) {
      failures.push(`${artifact}: required artifact is missing`);
    }
  }
}

if (document && trace) {
  // Requirement IDs have a stable table shape in chapter 9. Security IDs are
  // the only non-priority table in chapter 14. Restrict parsing to those
  // sections so glossary terms, decision IDs, and acceptance rows are not
  // mistaken for requirements.
  const featureStart = document.indexOf('## 9. 機能要件');
  const featureEnd = document.indexOf('## 10. コンテンツモデルと登録規則');
  const securityStart = document.indexOf('### 14.1 セキュリティ');
  const securityEnd = document.indexOf('### 14.2 プライバシー');
  const uxStart = document.indexOf('## 7. 5段階のUX/UI');
  const uxEnd = document.indexOf('## 8. 情報設計と画面一覧');
  const featureSection = featureStart >= 0 && featureEnd > featureStart ? document.slice(featureStart, featureEnd) : '';
  const securitySection = securityStart >= 0 && securityEnd > securityStart ? document.slice(securityStart, securityEnd) : '';
  const uxSection = uxStart >= 0 && uxEnd > uxStart ? document.slice(uxStart, uxEnd) : '';
  const featureRequirements = [...featureSection.matchAll(/^\|\s*([A-Z][A-Z0-9-]*)\s*\|\s*(MUST|SHOULD|FUTURE)\s*\|/gmu)]
    .map((match) => ({id: match[1], priority: match[2]}));
  // Chapter 14 security requirements are normative and have no priority
  // column; the document contract treats every SEC row as an MVP MUST.
  const securityRequirements = [...securitySection.matchAll(/^\|\s*(SEC-[A-Z0-9-]+)\s*\|/gmu)]
    .map((match) => ({id: match[1], priority: 'MUST'}));
  const requirements = [...featureRequirements, ...securityRequirements];
  const requirementRows = requirements.map(({id}) => id);
  const priorityByRequirement = new Map(requirements.map(({id, priority}) => [id, priority]));
  const acceptanceRows = [...document.matchAll(/^\|\s*(AT-\d+)\s*\|/gmu)].map((match) => match[1]);
  const requiredAcceptance = new Set(trace.requiredAcceptanceIds ?? []);
  const canonicalAcceptance = new Set(Array.from({length: 45}, (_, index) => `AT-${String(index + 1).padStart(2, '0')}`));
  const weakRequirementIds = [
    'PUB-01', 'PUB-02', 'PUB-04', 'PUB-05',
    'AUTH-01', 'AUTH-02', 'AUTH-03', 'AUTH-04', 'AUTH-06',
    'PAY-01', 'PAY-02', 'PAY-03', 'PAY-04', 'PAY-06', 'PAY-07', 'PAY-08', 'PAY-09', 'PAY-10', 'PAY-11',
    'CNT-01', 'CNT-02', 'CNT-03', 'CNT-03A', 'CNT-03B', 'CNT-06', 'CNT-07', 'CNT-09', 'CNT-10A', 'CNT-10B',
    'PROF-01', 'PROF-02', 'PROF-03', 'PROF-04', 'PROF-05', 'PROF-06', 'PROF-07', 'PROF-09',
    'SYNC-01', 'SYNC-02', 'SYNC-03', 'SYNC-06', 'SYNC-07', 'SYNC-08', 'SYNC-09', 'SYNC-10', 'SYNC-14',
    'OPS-01', 'OPS-02', 'OPS-06', 'OPS-07', 'OPS-08',
    'SUP-01', 'SUP-02', 'SUP-03', 'SUP-04', 'SUP-05', 'SUP-06',
    'SEC-02', 'SEC-03', 'SEC-05', 'SEC-06', 'SEC-07', 'SEC-08', 'SEC-09', 'SEC-11'
  ];
  const weakRequirements = new Set(weakRequirementIds);
  const applicabilityByPriority = new Map([
    ['MUST', 'production-required'],
    ['SHOULD', 'mvp-advisory'],
    ['FUTURE', 'future/non-mvp'],
  ]);

  requireUnique(requirementRows, 'requirements document requirement IDs');
  requireUnique(weakRequirementIds, 'weak requirement IDs');
  if (weakRequirementIds.length !== 65) failures.push(`operational-check requirement IDs: expected 65 (found ${weakRequirementIds.length})`);
  for (const requirementId of weakRequirementIds) {
    if (!requirementRows.includes(requirementId)) failures.push(`${requirementId}: weak requirement is not present in the requirements document`);
  }
  requireUnique(acceptanceRows, 'requirements document acceptance IDs');
  requireUnique(trace.requiredAcceptanceIds ?? [], 'requirements-trace.requiredAcceptanceIds');
  for (const acceptanceId of canonicalAcceptance) {
    if (!requiredAcceptance.has(acceptanceId)) failures.push(`${acceptanceId}: missing from config/requirements-trace.json`);
  }
  for (const acceptanceId of requiredAcceptance) {
    if (!canonicalAcceptance.has(acceptanceId)) failures.push(`${acceptanceId}: unexpected acceptance ID (expected AT-01..AT-45)`);
  }
  for (const acceptanceId of requiredAcceptance) {
    if (!acceptanceRows.includes(acceptanceId)) failures.push(`${acceptanceId}: not found in requirements document`);
  }
  for (const acceptanceId of acceptanceRows) {
    if (!requiredAcceptance.has(acceptanceId)) failures.push(`${acceptanceId}: acceptance test is not listed in config/requirements-trace.json`);
  }

  const groups = Array.isArray(trace.groups) ? trace.groups : [];
  if (groups.length === 0) failures.push('requirements-trace.groups: expected groups');
  const groupsByPrefix = new Map();
  const explicitlyGroupedRequirements = new Set();
  for (const group of groups) {
    requireString(group.prefix, 'requirements group prefix');
    if (groupsByPrefix.has(group.prefix)) failures.push(`${group.prefix}: trace group is duplicated`);
    groupsByPrefix.set(group.prefix, group);
    if (!Array.isArray(group.requirements) || group.requirements.length === 0) {
      failures.push(`${group.prefix}: expected explicit requirement IDs`);
    }
    if (!Array.isArray(group.acceptanceIds) || group.acceptanceIds.length === 0) {
      failures.push(`${group.prefix}: no acceptance tests`);
    }
    for (const requirementId of group.requirements ?? []) {
      if (explicitlyGroupedRequirements.has(requirementId)) failures.push(`${requirementId}: grouped more than once`);
      explicitlyGroupedRequirements.add(requirementId);
    }
    for (const acceptanceId of group.acceptanceIds ?? []) {
      if (!requiredAcceptance.has(acceptanceId)) failures.push(`${group.prefix}: ${acceptanceId} is not a required acceptance test`);
    }
  }

  for (const requirementId of requirementRows) {
    const prefix = requirementId.split('-')[0];
    if (!groupsByPrefix.has(prefix)) failures.push(`${requirementId}: no traceability group for prefix ${prefix}`);
    if (!explicitlyGroupedRequirements.has(requirementId)) failures.push(`${requirementId}: no explicit group requirement entry`);
    if (countMatches(document, new RegExp(`\\b${requirementId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'gu')) === 0) {
      failures.push(`${requirementId}: not found in requirements document`);
    }
  }
  for (const requirementId of explicitlyGroupedRequirements) {
    if (!requirementRows.includes(requirementId)) failures.push(`${requirementId}: grouped requirement is not present in the requirements document`);
  }

  // Each requirement gets exactly one mapping object. Group-level unions are
  // retained for the human summary, but cannot satisfy this one-to-one check.
  const requirementMappings = trace.requirementMappings;
  if (!Array.isArray(requirementMappings) || requirementMappings.length === 0) {
    failures.push('requirements-trace.requirementMappings: expected one mapping per requirement');
  }
  const mappingCounts = new Map();
  const mappingsById = new Map();
  for (const mapping of requirementMappings ?? []) {
    requireString(mapping.id, 'requirement mapping id');
    const id = mapping.id;
    mappingCounts.set(id, (mappingCounts.get(id) ?? 0) + 1);
    if (!mappingsById.has(id)) mappingsById.set(id, mapping);
    if (!requirementRows.includes(id)) failures.push(`${id}: requirement mapping is not present in the requirements document`);
    if (!Array.isArray(mapping.acceptanceIds)) failures.push(`${id}.acceptanceIds: expected an array`);
    if (!Array.isArray(mapping.operationalCheckIds)) failures.push(`${id}.operationalCheckIds: expected an array`);
    requireUnique(mapping.acceptanceIds ?? [], `${id}.acceptanceIds`);
    requireUnique(mapping.operationalCheckIds ?? [], `${id}.operationalCheckIds`);
    for (const acceptanceId of mapping.acceptanceIds ?? []) {
      if (!requiredAcceptance.has(acceptanceId)) failures.push(`${id}: ${acceptanceId} is not a required acceptance test`);
    }
    const acceptanceCount = Array.isArray(mapping.acceptanceIds) ? mapping.acceptanceIds.length : 0;
    const operationalCheckCount = Array.isArray(mapping.operationalCheckIds) ? mapping.operationalCheckIds.length : 0;
    if (acceptanceCount + operationalCheckCount === 0) {
      failures.push(`${id}: requirement must be covered by a direct acceptance test or an operational check`);
    }
    const priority = priorityByRequirement.get(id);
    if (priority === 'FUTURE' && acceptanceCount > 0) {
      failures.push(`${id}: FUTURE requirement must not claim an MVP acceptance test`);
    }
    const expectedOperationalCheckIds = weakRequirements.has(id) ? [`OC-${id}`] : [];
    requireExactSet(mapping.operationalCheckIds ?? [], expectedOperationalCheckIds, `${id}.operationalCheckIds`);
    if ((mapping.operationalCheckIds ?? []).length !== expectedOperationalCheckIds.length) {
      failures.push(`${id}.operationalCheckIds: expected exactly ${expectedOperationalCheckIds.length}`);
    }
    requireString(mapping.owner, `${id}.owner`);
    if (!Array.isArray(mapping.evidence) || mapping.evidence.length === 0) failures.push(`${id}.evidence: expected evidence types`);
    for (const evidence of mapping.evidence ?? []) requireString(evidence, `${id}.evidence entry`);
  }
  for (const requirementId of requirementRows) {
    const count = mappingCounts.get(requirementId) ?? 0;
    if (count !== 1) failures.push(`${requirementId}: expected exactly one explicit requirement-to-acceptance mapping (found ${count})`);
  }
  for (const [requirementId, count] of mappingCounts) {
    if (count > 1) failures.push(`${requirementId}: requirement mapping appears ${count} times`);
  }

  // The 65 requirements whose direct AT coverage leaves a material clause
  // unasserted get one requirement-specific operational check. The other 18
  // requirements are covered directly by ATs and must not acquire placeholder
  // operational checks that make traceability look stronger than it is.
  const operationalChecks = trace.operationalChecks;
  if (!Array.isArray(operationalChecks)) {
    failures.push('requirements-trace.operationalChecks: expected an array');
  } else if (operationalChecks.length !== weakRequirementIds.length) {
    failures.push(`requirements-trace.operationalChecks: expected ${weakRequirementIds.length} checks (found ${operationalChecks.length})`);
  }
  const operationalCheckFields = [
    'id', 'requirementIds', 'method', 'assertion', 'owner', 'cadence', 'releaseApplicability', 'evidenceKinds'
  ];
  const operationalChecksById = new Map();
  const operationalCheckCountsByRequirement = new Map();
  for (const check of operationalChecks ?? []) {
    if (!check || typeof check !== 'object' || Array.isArray(check)) {
      failures.push('requirements-trace.operationalChecks entry: expected an object');
      continue;
    }
    requireExactSet(Object.keys(check), operationalCheckFields, `${check.id ?? 'operational check'} fields`);
    requireString(check.id, 'operational check id');
    if (operationalChecksById.has(check.id)) failures.push(`${check.id}: operational check ID is duplicated`);
    else operationalChecksById.set(check.id, check);
    if (!Array.isArray(check.requirementIds) || check.requirementIds.length !== 1) {
      failures.push(`${check.id}.requirementIds: expected exactly one requirement ID`);
    }
    requireUnique(check.requirementIds ?? [], `${check.id}.requirementIds`);
    const requirementId = check.requirementIds?.[0];
    if (typeof requirementId === 'string') {
      operationalCheckCountsByRequirement.set(
        requirementId,
        (operationalCheckCountsByRequirement.get(requirementId) ?? 0) + 1
      );
      if (!weakRequirements.has(requirementId)) failures.push(`${check.id}: ${requirementId} is not one of the 65 operational-check requirements`);
      if (check.id !== `OC-${requirementId}`) failures.push(`${check.id}: expected ID OC-${requirementId}`);
      const mapping = mappingsById.get(requirementId);
      if (mapping && check.owner !== mapping.owner) failures.push(`${check.id}.owner: must match ${requirementId}.owner (${mapping.owner})`);
      const priority = priorityByRequirement.get(requirementId);
      const expectedApplicability = applicabilityByPriority.get(priority);
      if (check.releaseApplicability !== expectedApplicability) {
        failures.push(`${check.id}.releaseApplicability: ${priority} requires ${expectedApplicability}`);
      }
    }
    requireString(check.method, `${check.id}.method`);
    if (typeof check.method === 'string' && /^(?:確認|確認する|レビュー|試験)$/u.test(check.method.trim())) {
      failures.push(`${check.id}.method: describe the concrete inspection or test, not a generic action`);
    }
    requireString(check.assertion, `${check.id}.assertion`);
    if (typeof check.assertion === 'string') {
      const normalizedAssertion = check.assertion.replace(/\s/gu, '');
      if (normalizedAssertion.length < 30 || /^(?:要件を)?確認(?:する)?[。.]*$/u.test(normalizedAssertion)) {
        failures.push(`${check.id}.assertion: expected a concrete, requirement-specific pass condition`);
      }
    }
    requireString(check.owner, `${check.id}.owner`);
    requireString(check.cadence, `${check.id}.cadence`);
    requireString(check.releaseApplicability, `${check.id}.releaseApplicability`);
    if (!Array.isArray(check.evidenceKinds) || check.evidenceKinds.length === 0) {
      failures.push(`${check.id}.evidenceKinds: expected at least one evidence kind`);
    }
    requireUnique(check.evidenceKinds ?? [], `${check.id}.evidenceKinds`);
    for (const evidenceKind of check.evidenceKinds ?? []) requireString(evidenceKind, `${check.id}.evidenceKinds entry`);
  }
  const expectedApplicabilityCounts = new Map([
    ['production-required', 57],
    ['mvp-advisory', 6],
    ['future/non-mvp', 2],
  ]);
  const actualApplicabilityCounts = new Map();
  for (const check of operationalChecks ?? []) {
    actualApplicabilityCounts.set(
      check.releaseApplicability,
      (actualApplicabilityCounts.get(check.releaseApplicability) ?? 0) + 1
    );
  }
  for (const [applicability, expectedCount] of expectedApplicabilityCounts) {
    const actualCount = actualApplicabilityCounts.get(applicability) ?? 0;
    if (actualCount !== expectedCount) {
      failures.push(`operationalChecks ${applicability}: expected ${expectedCount} (found ${actualCount})`);
    }
  }
  for (const applicability of actualApplicabilityCounts.keys()) {
    if (!expectedApplicabilityCounts.has(applicability)) failures.push(`operationalChecks: unexpected releaseApplicability ${applicability}`);
  }
  for (const requirementId of weakRequirementIds) {
    const count = operationalCheckCountsByRequirement.get(requirementId) ?? 0;
    if (count !== 1) failures.push(`${requirementId}: expected exactly one operational check (found ${count})`);
    const mapping = mappingsById.get(requirementId);
    const expectedCheckId = `OC-${requirementId}`;
    if (mapping && !(mapping.operationalCheckIds ?? []).includes(expectedCheckId)) {
      failures.push(`${requirementId}: mapping does not reference ${expectedCheckId}`);
    }
  }
  for (const mapping of requirementMappings ?? []) {
    for (const checkId of mapping.operationalCheckIds ?? []) {
      const check = operationalChecksById.get(checkId);
      if (!check) failures.push(`${mapping.id}: referenced operational check ${checkId} does not exist`);
      else if (check.requirementIds?.[0] !== mapping.id) failures.push(`${mapping.id}: ${checkId} refers to ${check.requirementIds?.[0]}`);
    }
  }

  // Chapter 7 has five named stages. Verify their names and require a
  // stage-specific owner/evidence mapping, independent of requirement groups.
  const documentStages = [...uxSection.matchAll(/^###\s+段階(\d+)：(.+)$/gmu)].map((match) => ({
    number: Number(match[1]),
    name: match[2].trim(),
  }));
  if (documentStages.length !== 5) failures.push(`requirements document UX stages: expected 5 (found ${documentStages.length})`);
  const uxStages = trace.uxStages;
  if (!Array.isArray(uxStages) || uxStages.length !== 5) {
    failures.push('requirements-trace.uxStages: expected exactly five stage mappings');
  }
  const expectedStageAcceptance = new Map([
    ['UX-01', ['AT-01', 'AT-03', 'AT-04', 'AT-08', 'AT-10']],
    ['UX-02', ['AT-06', 'AT-07', 'AT-08']],
    ['UX-03', ['AT-06', 'AT-07', 'AT-09', 'AT-19', 'AT-24', 'AT-41']],
    ['UX-04', ['AT-04', 'AT-09', 'AT-15', 'AT-16', 'AT-17', 'AT-18', 'AT-19', 'AT-31', 'AT-32', 'AT-41']],
    ['UX-05', ['AT-11', 'AT-12', 'AT-13', 'AT-14', 'AT-33', 'AT-34', 'AT-35', 'AT-36']],
  ]);
  const expectedCrossCuttingAcceptance = [
    'AT-02', 'AT-05', 'AT-20', 'AT-21', 'AT-22', 'AT-23', 'AT-25', 'AT-26', 'AT-27', 'AT-28', 'AT-29',
    'AT-30', 'AT-37', 'AT-38', 'AT-39', 'AT-40', 'AT-42', 'AT-43', 'AT-44', 'AT-45'
  ];
  const uxIds = new Set();
  const stageAcceptance = new Set();
  for (const stage of uxStages ?? []) {
    requireString(stage.id, 'UX stage id');
    if (uxIds.has(stage.id)) failures.push(`${stage.id}: UX stage is duplicated`);
    uxIds.add(stage.id);
    const stageNumber = /^UX-(\d{2})$/u.exec(stage.id ?? '')?.[1];
    const source = stageNumber ? documentStages.find((entry) => entry.number === Number(stageNumber)) : undefined;
    if (!source) failures.push(`${stage.id}: no matching chapter 7 UX stage`);
    else if (stage.name !== source.name) failures.push(`${stage.id}: name does not match chapter 7 (${source.name})`);
    if (!Array.isArray(stage.acceptanceIds) || stage.acceptanceIds.length === 0) failures.push(`${stage.id}: no acceptance IDs`);
    requireUnique(stage.acceptanceIds ?? [], `${stage.id}.acceptanceIds`);
    const expectedAcceptance = expectedStageAcceptance.get(stage.id) ?? [];
    requireExactSet(stage.acceptanceIds ?? [], expectedAcceptance, `${stage.id}.acceptanceIds`);
    if ((stage.acceptanceIds ?? []).length !== expectedAcceptance.length) {
      failures.push(`${stage.id}.acceptanceIds: expected exactly ${expectedAcceptance.length}`);
    }
    for (const acceptanceId of stage.acceptanceIds ?? []) {
      if (!requiredAcceptance.has(acceptanceId)) failures.push(`${stage.id}: ${acceptanceId} is not a required acceptance test`);
      stageAcceptance.add(acceptanceId);
    }
    requireString(stage.owner, `${stage.id}.owner`);
    if (!Array.isArray(stage.evidence) || stage.evidence.length === 0) failures.push(`${stage.id}.evidence: expected evidence types`);
    for (const evidence of stage.evidence ?? []) requireString(evidence, `${stage.id}.evidence entry`);
  }
  for (const source of documentStages) {
    const id = `UX-${String(source.number).padStart(2, '0')}`;
    if (!uxIds.has(id)) failures.push(`${id}: no explicit UX stage mapping`);
  }
  requireExactSet([...uxIds], [...expectedStageAcceptance.keys()], 'requirements-trace.uxStages IDs');

  const crossCuttingAcceptance = trace.crossCuttingAcceptanceIds;
  if (!Array.isArray(crossCuttingAcceptance)) {
    failures.push('requirements-trace.crossCuttingAcceptanceIds: expected an array');
  }
  requireUnique(crossCuttingAcceptance ?? [], 'requirements-trace.crossCuttingAcceptanceIds');
  requireExactSet(
    crossCuttingAcceptance ?? [],
    expectedCrossCuttingAcceptance,
    'requirements-trace.crossCuttingAcceptanceIds'
  );
  if ((crossCuttingAcceptance ?? []).length !== expectedCrossCuttingAcceptance.length) {
    failures.push(`requirements-trace.crossCuttingAcceptanceIds: expected exactly ${expectedCrossCuttingAcceptance.length}`);
  }
  for (const acceptanceId of crossCuttingAcceptance ?? []) {
    if (!requiredAcceptance.has(acceptanceId)) failures.push(`crossCuttingAcceptanceIds: ${acceptanceId} is not a required acceptance test`);
    if (stageAcceptance.has(acceptanceId)) failures.push(`${acceptanceId}: cross-cutting acceptance ID must not also appear in a UX stage`);
  }
  const uxAndCrossCuttingAcceptance = new Set([
    ...stageAcceptance,
    ...(crossCuttingAcceptance ?? []),
  ]);
  for (const acceptanceId of requiredAcceptance) {
    if (!uxAndCrossCuttingAcceptance.has(acceptanceId)) failures.push(`${acceptanceId}: not covered by a UX stage or cross-cutting mapping`);
  }
  for (const acceptanceId of uxAndCrossCuttingAcceptance) {
    if (!requiredAcceptance.has(acceptanceId)) failures.push(`${acceptanceId}: unexpected UX/cross-cutting acceptance ID`);
  }
}

if (failures.length > 0) {
  console.error(`REQUIREMENTS_CHECK_FAILED (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`REQUIREMENTS_OK ${requiredArtifacts.length} artifacts; ${trace.requirementMappings.length} requirement mappings; ${trace.operationalChecks.length} operational checks; 5 UX stages plus ${trace.crossCuttingAcceptanceIds.length} cross-cutting ATs; AT-01..AT-45 covered`);
}
return {failures};
}

const isDirectExecution = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectExecution) await runRequirementsCheck();
