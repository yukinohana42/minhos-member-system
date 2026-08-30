import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const REQUIRED_ACCEPTANCE_IDS = Array.from(
  {length: 45},
  (_, index) => `AT-${String(index + 1).padStart(2, '0')}`,
);
const REQUIRED_DECISION_IDS = Array.from(
  {length: 21},
  (_, index) => `DEC-${String(index + 1).padStart(2, '0')}`,
);
const ALLOWED_ACCEPTANCE_STATUSES = new Set(['PASS', 'NOT_RUN', 'FAIL']);
const ALLOWED_DECISION_STATUSES = new Set(['DECIDED', 'NOT_DECIDED', 'REJECTED']);
const ALLOWED_BLOCKER_STATUSES = new Set(['OPEN', 'RESOLVED', 'ACCEPTED']);
const ALLOWED_EVIDENCE_SUBJECT_TYPES = new Set([
  'release', 'acceptance-test', 'decision', 'operational-check', 'blocker',
]);
const ALLOWED_EVIDENCE_SOURCE_TYPES = new Set(['repository-file', 'github-actions', 'external-record']);
const ALLOWED_OPERATIONAL_STATUSES = new Set(['PASS', 'DEFERRED', 'NOT_APPLICABLE', 'NOT_RUN', 'FAIL']);
const ALLOWED_OPERATIONAL_APPLICABILITY = new Set(['production-required', 'mvp-advisory', 'future/non-mvp']);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const EVIDENCE_ID_PATTERN = /^[A-Z0-9][A-Z0-9._-]{7,127}$/u;
const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const MAX_ALLOWED_EVIDENCE_AGE_HOURS = 168;
const OPERATIONAL_CHECK_SOURCE = 'config/requirements-trace.json#operationalChecks';
const REQUIRED_OPERATIONAL_CHECK_COUNT = 65;
const CANDIDATE_COMMIT_POLICY = 'ancestor-of-clean-head-with-attestation-only-diff';
const ARTIFACT_BINDING = 'canonical-ci-candidate-output';
const ARTIFACT_SOURCE_ROOT = 'packages/ghost-theme';
const ARTIFACT_CHECKSUMS_PATH = 'packages/ghost-theme/dist/SHA256SUMS.txt';
const ARTIFACT_NAME_TEMPLATE = 'minhos-ghost-theme-{candidateCommitSha}';
const ARTIFACT_SOURCE_MANIFEST_ALGORITHM = 'sha256(path-nul-content-sha256-lf)-v1';

export const RELEASE_ATTESTATION_ALLOWED_PATHS = Object.freeze([
  'config/release-status.json',
  'docs/evidence/records/**',
]);

export const CANONICAL_BLOCKERS = Object.freeze([
  Object.freeze({
    id: 'BLK-EXT-01',
    severity: 'P1',
    owner: 'system-owner',
    description: 'Ghost、Stripe、Google Workspace等の本番接続と承認済みtest mode証跡が未完了。',
  }),
  Object.freeze({
    id: 'BLK-EXT-02',
    severity: 'P1',
    owner: 'responsible-owner',
    description: '本番アカウント所有、秘密情報境界、外部接続Gate 0〜5の承認が未完了。',
  }),
  Object.freeze({
    id: 'BLK-LEGAL-01',
    severity: 'P1',
    owner: 'responsible-owner',
    description: '法務文書、講師許諾、個人情報保存期間、外部URL再共有リスクの決定が未完了。',
  }),
  Object.freeze({
    id: 'BLK-OPS-01',
    severity: 'P2',
    owner: 'system-owner',
    description: '手動受入、バックアップ復元、rollback、監視、問い合わせ担当の本番証跡が未完了。',
  }),
]);

export const CANONICAL_CI_CHECK = Object.freeze({
  repository: 'yukinohana42/minhos-member-system',
  workflow: '.github/workflows/ci.yml',
  job: 'verify',
  check: 'verify',
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, label, failures) {
  if (typeof value !== 'string' || value.trim() === '') {
    failures.push(`${label}: expected a non-empty string`);
    return false;
  }
  return true;
}

function validIsoTimestamp(value) {
  return typeof value === 'string'
    && ISO_UTC_PATTERN.test(value)
    && Number.isFinite(Date.parse(value));
}

function safeRepositoryEvidencePath(value) {
  return typeof value === 'string'
    && /^docs\/evidence\/records\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)
    && !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

function safeRepositoryPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('\\')
    && !path.posix.isAbsolute(value)
    && !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

function releaseAttestationPathAllowed(value) {
  return value === 'config/release-status.json'
    || (typeof value === 'string'
      && /^docs\/evidence\/records\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)
      && !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..'));
}

function repositoryDigest(runtime, sourceRef) {
  const digests = runtime?.repositoryFileDigests;
  if (digests instanceof Map) return digests.get(sourceRef);
  if (isObject(digests)) return digests[sourceRef];
  return undefined;
}

function repositoryContent(runtime, sourceRef) {
  const contents = runtime?.repositoryFileContents;
  if (contents instanceof Map) return contents.get(sourceRef);
  if (isObject(contents)) return contents[sourceRef];
  return undefined;
}

function indexExpectedRecords(records, label, expectedIds, failures) {
  if (!Array.isArray(records)) {
    failures.push(`${label}: expected an array`);
    return new Map();
  }
  const expected = new Set(expectedIds);
  const indexed = new Map();
  for (const record of records) {
    const id = isObject(record) ? record.id : undefined;
    if (!requireString(id, `${label} entry id`, failures)) continue;
    if (indexed.has(id)) failures.push(`${label}: duplicate ${id}`);
    indexed.set(id, record);
    if (!expected.has(id)) failures.push(`${label}: unexpected ${id}`);
  }
  for (const id of expectedIds) {
    if (!indexed.has(id)) failures.push(`${label}: missing ${id}`);
  }
  return indexed;
}

function indexOperationalCheckContract(requirementsTrace, policy, gatePolicy, failures) {
  if (!isObject(requirementsTrace)) {
    failures.push('config/requirements-trace.json: expected an object');
    return new Map();
  }
  if (requirementsTrace.requirementsDocument !== policy.requirementsDocument) {
    failures.push('requirements-trace.requirementsDocument must match harness-policy.requirementsDocument');
  }
  if (!Array.isArray(requirementsTrace.operationalChecks)) {
    failures.push('requirements-trace.operationalChecks: expected an array');
    return new Map();
  }
  if (gatePolicy?.requiredOperationalCheckSource !== OPERATIONAL_CHECK_SOURCE) {
    failures.push('release gate operational-check source is not canonical');
  }
  if (requirementsTrace.operationalChecks.length !== REQUIRED_OPERATIONAL_CHECK_COUNT) {
    failures.push(`requirements-trace.operationalChecks: expected ${REQUIRED_OPERATIONAL_CHECK_COUNT} canonical records`);
  }

  const indexed = new Map();
  for (const check of requirementsTrace.operationalChecks) {
    const id = isObject(check) ? check.id : undefined;
    if (!requireString(id, 'requirements-trace operational check id', failures)) continue;
    if (!/^OC-[A-Z0-9][A-Z0-9-]*$/u.test(id)) {
      failures.push(`requirements-trace.operationalChecks: invalid ID ${id}`);
    }
    if (indexed.has(id)) failures.push(`requirements-trace.operationalChecks: duplicate ${id}`);
    indexed.set(id, check);
    requireString(check.owner, `${id}.owner`, failures);
    if (!ALLOWED_OPERATIONAL_APPLICABILITY.has(check.releaseApplicability)) {
      failures.push(`${id}.releaseApplicability: unsupported ${check.releaseApplicability}`);
    }
  }
  return indexed;
}

function validateCanonicalPolicy(gatePolicy, failures) {
  if (!isObject(gatePolicy)) {
    failures.push('harness-policy.releaseGate: expected an object');
    return;
  }
  if (gatePolicy.targetEnvironment !== 'production') {
    failures.push('harness-policy.releaseGate.targetEnvironment must be production');
  }
  if (!requireString(gatePolicy.targetEnvironmentId, 'harness-policy.releaseGate.targetEnvironmentId', failures)
    || !SAFE_IDENTIFIER_PATTERN.test(gatePolicy.targetEnvironmentId ?? '')) {
    failures.push('harness-policy.releaseGate.targetEnvironmentId: expected the exact stable production environment ID');
  }
  if (gatePolicy.requirementsVersion !== 'v1.1') {
    failures.push('harness-policy.releaseGate.requirementsVersion must be v1.1');
  }
  if (!requireString(gatePolicy.artifactPath, 'harness-policy.releaseGate.artifactPath', failures)
    || !safeRepositoryPath(gatePolicy.artifactPath)) {
    failures.push('harness-policy.releaseGate.artifactPath: expected a safe repository-relative path');
  }
  if (!Number.isInteger(gatePolicy.maxEvidenceAgeHours)
    || gatePolicy.maxEvidenceAgeHours <= 0
    || gatePolicy.maxEvidenceAgeHours > MAX_ALLOWED_EVIDENCE_AGE_HOURS) {
    failures.push(`harness-policy.releaseGate.maxEvidenceAgeHours must be an integer from 1 to ${MAX_ALLOWED_EVIDENCE_AGE_HOURS}`);
  }
  if (gatePolicy.requiredOperationalCheckSource !== OPERATIONAL_CHECK_SOURCE) {
    failures.push(`harness-policy.releaseGate.requiredOperationalCheckSource must be ${OPERATIONAL_CHECK_SOURCE}`);
  }
  if (gatePolicy.candidateCommitPolicy !== CANDIDATE_COMMIT_POLICY) {
    failures.push(`harness-policy.releaseGate.candidateCommitPolicy must be ${CANDIDATE_COMMIT_POLICY}`);
  }
  if (gatePolicy.artifactBinding !== ARTIFACT_BINDING) {
    failures.push(`harness-policy.releaseGate.artifactBinding must be ${ARTIFACT_BINDING}`);
  }
  if (gatePolicy.artifactSourceRoot !== ARTIFACT_SOURCE_ROOT) {
    failures.push(`harness-policy.releaseGate.artifactSourceRoot must be ${ARTIFACT_SOURCE_ROOT}`);
  }
  if (gatePolicy.artifactChecksumsPath !== ARTIFACT_CHECKSUMS_PATH) {
    failures.push(`harness-policy.releaseGate.artifactChecksumsPath must be ${ARTIFACT_CHECKSUMS_PATH}`);
  }
  if (gatePolicy.artifactNameTemplate !== ARTIFACT_NAME_TEMPLATE) {
    failures.push(`harness-policy.releaseGate.artifactNameTemplate must be ${ARTIFACT_NAME_TEMPLATE}`);
  }
  if (gatePolicy.artifactSourceManifestAlgorithm !== ARTIFACT_SOURCE_MANIFEST_ALGORITHM) {
    failures.push(`harness-policy.releaseGate.artifactSourceManifestAlgorithm must be ${ARTIFACT_SOURCE_MANIFEST_ALGORITHM}`);
  }
  if (!Array.isArray(gatePolicy.attestationAllowedPaths)
    || gatePolicy.attestationAllowedPaths.length !== RELEASE_ATTESTATION_ALLOWED_PATHS.length
    || RELEASE_ATTESTATION_ALLOWED_PATHS.some((entry) => !gatePolicy.attestationAllowedPaths.includes(entry))
    || new Set(gatePolicy.attestationAllowedPaths).size !== gatePolicy.attestationAllowedPaths.length) {
    failures.push('harness-policy.releaseGate.attestationAllowedPaths must contain only the canonical release-attestation paths');
  }

  const ciCheck = gatePolicy.canonicalCiCheck;
  if (!isObject(ciCheck)) {
    failures.push('harness-policy.releaseGate.canonicalCiCheck: expected an object');
  } else {
    for (const [field, expected] of Object.entries(CANONICAL_CI_CHECK)) {
      if (ciCheck[field] !== expected) {
        failures.push(`harness-policy.releaseGate.canonicalCiCheck.${field} must be ${expected}`);
      }
    }
  }

  if (!Array.isArray(gatePolicy.requiredBlockers)) {
    failures.push('harness-policy.releaseGate.requiredBlockers: expected an array');
    return;
  }
  const blockersById = new Map();
  for (const blocker of gatePolicy.requiredBlockers) {
    const id = isObject(blocker) ? blocker.id : undefined;
    if (!requireString(id, 'harness-policy.releaseGate blocker id', failures)) continue;
    if (blockersById.has(id)) failures.push(`harness-policy.releaseGate.requiredBlockers: duplicate ${id}`);
    blockersById.set(id, blocker);
  }
  for (const expected of CANONICAL_BLOCKERS) {
    const actual = blockersById.get(expected.id);
    if (!actual) {
      failures.push(`harness-policy.releaseGate.requiredBlockers: missing canonical ${expected.id}`);
      continue;
    }
    for (const field of ['severity', 'owner', 'description']) {
      if (actual[field] !== expected[field]) {
        failures.push(`harness-policy.releaseGate.${expected.id}.${field}: canonical value cannot be changed`);
      }
    }
  }
}

function validateFreshTimestamp(value, label, nowMs, reviewedAtMs, maxAgeMs, failures) {
  if (!validIsoTimestamp(value)) {
    failures.push(`${label}: expected an ISO UTC timestamp`);
    return;
  }
  const timestampMs = Date.parse(value);
  if (timestampMs > nowMs) failures.push(`${label}: cannot be in the future`);
  if (nowMs - timestampMs > maxAgeMs) failures.push(`${label}: evidence is stale`);
  if (Number.isFinite(reviewedAtMs) && timestampMs > reviewedAtMs) {
    failures.push(`${label}: cannot be later than release.reviewedAt`);
  }
}

function validateEvidenceRegistry(status, gatePolicy, runtime, release, nowMs, reviewedAtMs, failures) {
  const registry = status?.evidenceRegistry;
  if (!Array.isArray(registry)) {
    failures.push('release-status.evidenceRegistry: expected an array');
    return new Map();
  }
  const indexed = new Map();
  const maxAgeHours = Number.isInteger(gatePolicy?.maxEvidenceAgeHours)
    ? gatePolicy.maxEvidenceAgeHours
    : 0;
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

  for (const [index, evidence] of registry.entries()) {
    const label = `release-status.evidenceRegistry[${index}]`;
    if (!isObject(evidence)) {
      failures.push(`${label}: expected a structured evidence object`);
      continue;
    }
    if (!requireString(evidence.id, `${label}.id`, failures)
      || !EVIDENCE_ID_PATTERN.test(evidence.id ?? '')) {
      failures.push(`${label}.id: expected a stable 8-128 character evidence ID`);
    } else {
      if (indexed.has(evidence.id)) failures.push(`release-status.evidenceRegistry: duplicate ${evidence.id}`);
      indexed.set(evidence.id, evidence);
    }
    if (!ALLOWED_EVIDENCE_SUBJECT_TYPES.has(evidence.subjectType)) {
      failures.push(`${label}.subjectType: unsupported evidence subject ${evidence.subjectType}`);
    }
    requireString(evidence.subjectId, `${label}.subjectId`, failures);
    requireString(evidence.kind, `${label}.kind`, failures);
    requireString(evidence.result, `${label}.result`, failures);
    if (evidence.environment !== status.environment || evidence.environment !== 'production') {
      failures.push(`${label}.environment: must be production`);
    }
    if (evidence.environmentId !== release?.targetEnvironmentId
      || evidence.environmentId !== gatePolicy?.targetEnvironmentId) {
      failures.push(`${label}.environmentId: must match the exact production environment ID`);
    }
    if (!COMMIT_PATTERN.test(evidence.commitSha ?? '')
      || evidence.commitSha !== release?.candidateCommitSha
      || evidence.commitSha !== runtime?.candidateCommitSha) {
      failures.push(`${label}.commitSha: must match the immutable candidate commit`);
    }
    if (!SHA256_PATTERN.test(evidence.requirementsSha256 ?? '')
      || evidence.requirementsSha256 !== release?.requirementsSha256
      || evidence.requirementsSha256 !== runtime?.candidateRequirementsSha256) {
      failures.push(`${label}.requirementsSha256: must match the candidate requirements document digest`);
    }
    validateFreshTimestamp(evidence.executedAt, `${label}.executedAt`, nowMs, reviewedAtMs, maxAgeMs, failures);
    requireString(evidence.actor, `${label}.actor`, failures);
    requireString(evidence.approver, `${label}.approver`, failures);
    if (!ALLOWED_EVIDENCE_SOURCE_TYPES.has(evidence.sourceType)) {
      failures.push(`${label}.sourceType: unsupported source type ${evidence.sourceType}`);
    }
    requireString(evidence.sourceRef, `${label}.sourceRef`, failures);
    if (!SHA256_PATTERN.test(evidence.sourceDigest ?? '')) {
      failures.push(`${label}.sourceDigest: expected a lowercase SHA-256 digest`);
    }

    if (evidence.sourceType === 'repository-file') {
      if (!safeRepositoryEvidencePath(evidence.sourceRef)) {
        failures.push(`${label}.sourceRef: repository evidence must be under docs/evidence/records/`);
      } else {
        const actualDigest = repositoryDigest(runtime, evidence.sourceRef);
        if (!SHA256_PATTERN.test(actualDigest ?? '')) {
          failures.push(`${label}.sourceRef: repository evidence file is missing or unreadable`);
        } else if (evidence.sourceDigest !== actualDigest) {
          failures.push(`${label}.sourceDigest: does not match repository evidence file`);
        }
      }
    }

    if (evidence.sourceType === 'external-record'
      && !/^[a-z][a-z0-9+.-]*:\/\/\S+$/iu.test(evidence.sourceRef ?? '')) {
      failures.push(`${label}.sourceRef: external evidence requires a stable URI`);
    }

    if (evidence.sourceType === 'github-actions') {
      const expectedCi = gatePolicy?.canonicalCiCheck;
      for (const field of ['repository', 'workflow', 'job', 'check']) {
        if (evidence[field] !== expectedCi?.[field]) {
          failures.push(`${label}.${field}: must match harness-policy.releaseGate.canonicalCiCheck`);
        }
      }
      if (typeof evidence.runId !== 'string' || !/^[1-9]\d*$/u.test(evidence.runId)) {
        failures.push(`${label}.runId: expected a positive GitHub Actions run ID string`);
      }
      if (!Number.isInteger(evidence.runAttempt) || evidence.runAttempt <= 0) {
        failures.push(`${label}.runAttempt: expected a positive integer`);
      }
      if (evidence.conclusion !== 'success') failures.push(`${label}.conclusion must be success`);
      if (!COMMIT_PATTERN.test(evidence.headSha ?? '')
        || evidence.headSha !== runtime?.candidateCommitSha
        || evidence.headSha !== evidence.commitSha) {
        failures.push(`${label}.headSha: must match the immutable candidate commit`);
      }
      if (evidence.artifactPath !== gatePolicy?.artifactPath) {
        failures.push(`${label}.artifactPath: must match the canonical release artifact path`);
      }
      const expectedArtifactName = gatePolicy?.artifactNameTemplate?.replace(
        '{candidateCommitSha}',
        runtime?.candidateCommitSha ?? '',
      );
      if (evidence.artifactName !== expectedArtifactName) {
        failures.push(`${label}.artifactName: must identify the canonical candidate CI artifact`);
      }
      if (!SHA256_PATTERN.test(evidence.artifactSha256 ?? '')
        || evidence.artifactSha256 !== release?.artifactSha256
        || evidence.artifactSha256 !== runtime?.artifactSha256) {
        failures.push(`${label}.artifactSha256: must bind the candidate CI output artifact`);
      }
      if (!SHA256_PATTERN.test(evidence.artifactSourceSha256 ?? '')
        || evidence.artifactSourceSha256 !== release?.artifactSourceSha256
        || evidence.artifactSourceSha256 !== runtime?.candidateArtifactSourceSha256) {
        failures.push(`${label}.artifactSourceSha256: must bind the candidate tracked source manifest`);
      }
      if (evidence.artifactChecksumsPath !== gatePolicy?.artifactChecksumsPath) {
        failures.push(`${label}.artifactChecksumsPath: must match the canonical CI checksum artifact path`);
      }
      if (!SHA256_PATTERN.test(evidence.artifactChecksumsSha256 ?? '')
        || evidence.artifactChecksumsSha256 !== release?.artifactChecksumsSha256
        || evidence.artifactChecksumsSha256 !== runtime?.artifactChecksumsSha256) {
        failures.push(`${label}.artifactChecksumsSha256: must match canonical CI SHA256SUMS content`);
      }
      const runUrl = `https://github.com/${CANONICAL_CI_CHECK.repository}/actions/runs/${evidence.runId}`;
      const attemptUrl = `${runUrl}/attempts/${evidence.runAttempt}`;
      if (evidence.sourceRef !== runUrl && evidence.sourceRef !== attemptUrl) {
        failures.push(`${label}.sourceRef: must identify the canonical GitHub Actions run`);
      }
      if (!safeRepositoryEvidencePath(evidence.sourceSnapshotRef)
        || !evidence.sourceSnapshotRef.endsWith('.json')) {
        failures.push(`${label}.sourceSnapshotRef: GitHub Actions evidence requires a JSON snapshot under docs/evidence/records/`);
      } else {
        const snapshotDigest = repositoryDigest(runtime, evidence.sourceSnapshotRef);
        const snapshotContent = repositoryContent(runtime, evidence.sourceSnapshotRef);
        if (!SHA256_PATTERN.test(snapshotDigest ?? '') || snapshotDigest !== evidence.sourceDigest) {
          failures.push(`${label}.sourceDigest: must match the retained GitHub Actions snapshot file`);
        }
        let snapshot = null;
        try {
          snapshot = typeof snapshotContent === 'string' ? JSON.parse(snapshotContent) : null;
        } catch {
          snapshot = null;
        }
        if (!isObject(snapshot) || snapshot.schemaVersion !== '1.0') {
          failures.push(`${label}.sourceSnapshotRef: retained GitHub Actions snapshot must be valid schema 1.0 JSON`);
        } else {
          for (const field of [
            'sourceRef',
            'repository',
            'workflow',
            'job',
            'check',
            'runId',
            'runAttempt',
            'conclusion',
            'headSha',
            'artifactName',
            'artifactPath',
            'artifactSha256',
            'artifactSourceSha256',
            'artifactChecksumsPath',
            'artifactChecksumsSha256',
          ]) {
            if (snapshot[field] !== evidence[field]) {
              failures.push(`${label}.sourceSnapshotRef: snapshot ${field} does not match evidence`);
            }
          }
        }
      }
    }
  }
  return indexed;
}

function validateEvidenceIds({
  evidenceIds,
  label,
  subjectType,
  subjectId,
  expectedResult,
  required,
  evidenceById,
  referencedEvidenceIds,
  failures,
}) {
  if (!Array.isArray(evidenceIds)) {
    failures.push(`${label}.evidenceIds: expected an array`);
    return [];
  }
  if (required && evidenceIds.length === 0) {
    failures.push(`${label}.evidenceIds: release-ready status requires evidence`);
  }
  const resolved = [];
  const seen = new Set();
  for (const [index, evidenceId] of evidenceIds.entries()) {
    if (typeof evidenceId !== 'string' || !EVIDENCE_ID_PATTERN.test(evidenceId)) {
      failures.push(`${label}.evidenceIds[${index}]: expected a stable evidence ID`);
      continue;
    }
    if (seen.has(evidenceId)) failures.push(`${label}.evidenceIds: duplicate ${evidenceId}`);
    seen.add(evidenceId);
    referencedEvidenceIds.add(evidenceId);

    const evidence = evidenceById.get(evidenceId);
    if (!evidence) {
      failures.push(`${label}.evidenceIds[${index}]: unknown evidence ${evidenceId}`);
      continue;
    }
    resolved.push(evidence);
    if (evidence.subjectType !== subjectType) {
      failures.push(`${label}.evidenceIds[${index}]: evidence subjectType must be ${subjectType}`);
    }
    if (evidence.subjectId !== subjectId) {
      failures.push(`${label}.evidenceIds[${index}]: evidence subjectId must be ${subjectId}`);
    }
    if (evidence.result !== expectedResult) {
      failures.push(`${label}.evidenceIds[${index}]: evidence result must be ${expectedResult}`);
    }
  }
  return resolved;
}

function canonicalCiEvidence(evidence, gatePolicy, runtime) {
  return evidence?.sourceType === 'github-actions'
    && evidence?.repository === gatePolicy?.canonicalCiCheck?.repository
    && evidence?.workflow === gatePolicy?.canonicalCiCheck?.workflow
    && evidence?.job === gatePolicy?.canonicalCiCheck?.job
    && evidence?.check === gatePolicy?.canonicalCiCheck?.check
    && evidence?.conclusion === 'success'
    && evidence?.commitSha === runtime?.candidateCommitSha
    && evidence?.headSha === runtime?.candidateCommitSha
    && evidence?.artifactPath === gatePolicy?.artifactPath
    && evidence?.artifactName === gatePolicy?.artifactNameTemplate?.replace(
      '{candidateCommitSha}',
      runtime?.candidateCommitSha ?? '',
    )
    && evidence?.artifactSha256 === runtime?.artifactSha256
    && evidence?.artifactSourceSha256 === runtime?.candidateArtifactSourceSha256
    && evidence?.artifactChecksumsPath === gatePolicy?.artifactChecksumsPath
    && evidence?.artifactChecksumsSha256 === runtime?.artifactChecksumsSha256;
}

export function evaluateReleaseReadiness(status, policy, runtime = {}, requirementsTrace = null) {
  const failures = [];
  let acceptancePassCount = 0;
  let decisionCount = 0;
  let operationalReadyCount = 0;
  let unresolvedBlockers = 0;

  if (!isObject(status)) failures.push('config/release-status.json: expected an object');
  if (!isObject(policy)) failures.push('config/harness-policy.json: expected an object');
  if (!isObject(status) || !isObject(policy)) {
    return {
      decision: 'NO_GO',
      failures,
      summary: {
        acceptancePassCount,
        acceptanceRequiredCount: REQUIRED_ACCEPTANCE_IDS.length,
        decisionCount,
        decisionRequiredCount: REQUIRED_DECISION_IDS.length,
        operationalReadyCount,
        operationalRequiredCount: 0,
        unresolvedBlockers,
      },
    };
  }

  const gatePolicy = policy.releaseGate;
  validateCanonicalPolicy(gatePolicy, failures);
  const operationalContractById = indexOperationalCheckContract(
    requirementsTrace,
    policy,
    gatePolicy,
    failures,
  );
  const nowMs = Number.isFinite(runtime.nowMs) ? runtime.nowMs : Number.NaN;
  if (!Number.isFinite(nowMs)) failures.push('runtime.nowMs: expected the evaluation time');
  if (!COMMIT_PATTERN.test(runtime.currentHeadSha ?? '')) {
    failures.push('release gate requires a resolvable current 40-character Git HEAD');
  }
  if (!COMMIT_PATTERN.test(runtime.candidateCommitSha ?? '')) {
    failures.push('release gate requires a resolvable immutable candidate commit');
  }
  if (COMMIT_PATTERN.test(runtime.currentHeadSha ?? '')
    && COMMIT_PATTERN.test(runtime.candidateCommitSha ?? '')
    && runtime.currentHeadSha === runtime.candidateCommitSha) {
    failures.push('release gate requires a separate release-attestation commit after the candidate');
  }
  if (runtime.worktreeClean !== true) failures.push('release gate requires a clean Git worktree');
  if (runtime.candidateCommitExists !== true) failures.push('release candidate commit does not exist');
  if (runtime.candidateIsAncestor !== true) failures.push('release candidate commit must be an ancestor of current HEAD');
  if (runtime.attestationDiffInspected !== true || !Array.isArray(runtime.changedPaths)) {
    failures.push('release gate could not inspect candidate-to-HEAD changes');
  } else {
    if (!runtime.changedPaths.includes('config/release-status.json')) {
      failures.push('release attestation must update config/release-status.json after the candidate commit');
    }
    for (const changedPath of runtime.changedPaths) {
      if (!releaseAttestationPathAllowed(changedPath)) {
        failures.push(`release attestation contains non-allowlisted drift: ${changedPath}`);
      }
    }
  }

  if (status.schemaVersion !== '2.0') failures.push('release-status.schemaVersion must be 2.0');
  if (status.environment !== gatePolicy?.targetEnvironment || status.environment !== 'production') {
    failures.push('release-status.environment must match the production release policy');
  }
  if (status.productionOnly !== true) failures.push('release-status.productionOnly must be true');
  if (typeof status.lastReviewed !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(status.lastReviewed)) {
    failures.push('release-status.lastReviewed: expected YYYY-MM-DD');
  }
  if (!['GO', 'NO_GO'].includes(status.declaredDecision)) {
    failures.push('release-status.declaredDecision must be GO or NO_GO');
  }

  const release = status.release;
  let reviewedAtMs = Number.NaN;
  if (!isObject(release)) {
    failures.push('release-status.release: expected an object');
  } else {
    if (!requireString(release.releaseId, 'release-status.release.releaseId', failures)
      || !RELEASE_ID_PATTERN.test(release.releaseId ?? '')) {
      failures.push('release-status.release.releaseId: expected 8-128 safe characters');
    }
    if (!COMMIT_PATTERN.test(release.candidateCommitSha ?? '')) {
      failures.push('release-status.release.candidateCommitSha: expected a lowercase 40-character commit SHA');
    } else if (release.candidateCommitSha !== runtime.candidateCommitSha) {
      failures.push('release-status.release.candidateCommitSha: does not match the inspected candidate commit');
    }
    if (!requireString(release.targetEnvironmentId, 'release-status.release.targetEnvironmentId', failures)
      || !SAFE_IDENTIFIER_PATTERN.test(release.targetEnvironmentId ?? '')) {
      failures.push('release-status.release.targetEnvironmentId: expected a stable non-secret environment ID');
    }
    if (release.targetEnvironmentId !== gatePolicy?.targetEnvironmentId) {
      failures.push('release-status.release.targetEnvironmentId: must match the exact production environment ID in harness-policy');
    }
    if (release.requirementsVersion !== gatePolicy?.requirementsVersion) {
      failures.push('release-status.release.requirementsVersion must match harness-policy.releaseGate');
    }
    if (!SHA256_PATTERN.test(release.requirementsSha256 ?? '')) {
      failures.push('release-status.release.requirementsSha256: expected a lowercase SHA-256 digest');
    }
    if (runtime.candidateRequirementsDocumentPath !== policy.requirementsDocument
      || runtime.candidateRequirementsDocumentExists !== true
      || !SHA256_PATTERN.test(runtime.candidateRequirementsSha256 ?? '')) {
      failures.push('release gate could not hash the canonical requirements document at the candidate commit');
    } else if (release.requirementsSha256 !== runtime.candidateRequirementsSha256) {
      failures.push('release-status.release.requirementsSha256: does not match the candidate requirements document');
    }
    if (release.artifactPath !== gatePolicy?.artifactPath) {
      failures.push('release-status.release.artifactPath must match harness-policy.releaseGate.artifactPath');
    }
    if (!SHA256_PATTERN.test(release.artifactSha256 ?? '')) {
      failures.push('release-status.release.artifactSha256: expected a lowercase SHA-256 digest');
    }
    if (runtime.artifactPath !== gatePolicy?.artifactPath
      || runtime.artifactExists !== true
      || !SHA256_PATTERN.test(runtime.artifactSha256 ?? '')) {
      failures.push('release gate target artifact is missing or unreadable');
    } else if (release.artifactSha256 !== runtime.artifactSha256) {
      failures.push('release-status.release.artifactSha256: does not match the built Ghost ZIP');
    }
    if (runtime.artifactMatchesCandidateSource !== true) {
      failures.push('release gate artifact contents do not match the candidate tracked source manifest');
    }
    if (!SHA256_PATTERN.test(release.artifactSourceSha256 ?? '')
      || !SHA256_PATTERN.test(runtime.candidateArtifactSourceSha256 ?? '')
      || release.artifactSourceSha256 !== runtime.candidateArtifactSourceSha256) {
      failures.push('release-status.release.artifactSourceSha256: must match the candidate tracked source manifest');
    }
    if (runtime.artifactChecksumsPath !== gatePolicy?.artifactChecksumsPath) {
      failures.push('release gate canonical CI SHA256SUMS path does not match policy');
    }
    if (runtime.artifactChecksumsExists !== true) {
      failures.push('release gate canonical CI SHA256SUMS file is missing or unreadable');
    }
    if (runtime.artifactChecksumsMatchesArtifact !== true) {
      failures.push('release gate canonical CI SHA256SUMS does not bind the inspected Ghost ZIP');
    }
    if (!SHA256_PATTERN.test(release.artifactChecksumsSha256 ?? '')
      || !SHA256_PATTERN.test(runtime.artifactChecksumsSha256 ?? '')
      || release.artifactChecksumsSha256 !== runtime.artifactChecksumsSha256) {
      failures.push('release-status.release.artifactChecksumsSha256: must match canonical CI SHA256SUMS content');
    }
    if (!validIsoTimestamp(release.reviewedAt)) {
      failures.push('release-status.release.reviewedAt: expected an ISO UTC timestamp');
    } else {
      reviewedAtMs = Date.parse(release.reviewedAt);
      if (Number.isFinite(nowMs) && reviewedAtMs > nowMs) {
        failures.push('release-status.release.reviewedAt: cannot be in the future');
      }
      const maxAgeHours = Number.isInteger(gatePolicy?.maxEvidenceAgeHours)
        ? gatePolicy.maxEvidenceAgeHours
        : 0;
      if (Number.isFinite(nowMs) && nowMs - reviewedAtMs > maxAgeHours * 60 * 60 * 1000) {
        failures.push('release-status.release.reviewedAt: release review is stale');
      }
      if (status.lastReviewed !== release.reviewedAt.slice(0, 10)) {
        failures.push('release-status.lastReviewed must be the UTC date of release.reviewedAt');
      }
    }
    requireString(release.actor, 'release-status.release.actor', failures);
    requireString(release.approver, 'release-status.release.approver', failures);
  }

  const evidenceById = validateEvidenceRegistry(status, gatePolicy, runtime, release, nowMs, reviewedAtMs, failures);
  const referencedEvidenceIds = new Set();
  const releaseEvidence = validateEvidenceIds({
    evidenceIds: release?.evidenceIds,
    label: 'release-status.release',
    subjectType: 'release',
    subjectId: release?.releaseId,
    expectedResult: 'PASS',
    required: true,
    evidenceById,
    referencedEvidenceIds,
    failures,
  });
  if (!releaseEvidence.some((evidence) => canonicalCiEvidence(evidence, gatePolicy, runtime))) {
    failures.push('release-status.release.evidenceIds: canonical successful GitHub Actions verify evidence is required');
  }

  const acceptanceById = indexExpectedRecords(
    status.acceptanceTests,
    'release-status.acceptanceTests',
    REQUIRED_ACCEPTANCE_IDS,
    failures,
  );
  for (const id of REQUIRED_ACCEPTANCE_IDS) {
    const record = acceptanceById.get(id);
    if (!record) continue;
    if (!ALLOWED_ACCEPTANCE_STATUSES.has(record.status)) {
      failures.push(`${id}: unsupported acceptance status ${record.status}`);
    } else if (record.status === 'PASS') {
      acceptancePassCount += 1;
    } else {
      failures.push(`${id}: acceptance status ${record.status} requires PASS for release`);
    }
    requireString(record.owner, `${id}.owner`, failures);
    validateEvidenceIds({
      evidenceIds: record.evidenceIds,
      label: id,
      subjectType: 'acceptance-test',
      subjectId: id,
      expectedResult: record.status,
      required: record.status === 'PASS',
      evidenceById,
      referencedEvidenceIds,
      failures,
    });
  }

  const decisionsById = indexExpectedRecords(
    status.decisions,
    'release-status.decisions',
    REQUIRED_DECISION_IDS,
    failures,
  );
  for (const id of REQUIRED_DECISION_IDS) {
    const record = decisionsById.get(id);
    if (!record) continue;
    if (!ALLOWED_DECISION_STATUSES.has(record.status)) {
      failures.push(`${id}: unsupported decision status ${record.status}`);
    } else if (record.status === 'DECIDED') {
      decisionCount += 1;
    } else {
      failures.push(`${id}: decision status ${record.status} requires DECIDED for release`);
    }
    requireString(record.owner, `${id}.owner`, failures);
    validateEvidenceIds({
      evidenceIds: record.evidenceIds,
      label: id,
      subjectType: 'decision',
      subjectId: id,
      expectedResult: record.status,
      required: record.status === 'DECIDED',
      evidenceById,
      referencedEvidenceIds,
      failures,
    });
  }

  if (!Array.isArray(status.operationalChecks)) {
    failures.push('release-status.operationalChecks: expected an array');
  } else {
    const operationalById = new Map();
    for (const record of status.operationalChecks) {
      const id = isObject(record) ? record.id : undefined;
      if (!requireString(id, 'release-status operational check id', failures)) continue;
      if (operationalById.has(id)) failures.push(`release-status.operationalChecks: duplicate ${id}`);
      operationalById.set(id, record);
      if (!operationalContractById.has(id)) failures.push(`release-status.operationalChecks: unexpected ${id}`);
    }

    for (const [id, contract] of operationalContractById) {
      const record = operationalById.get(id);
      if (!record) {
        failures.push(`release-status.operationalChecks: missing ${id}`);
        continue;
      }
      if (record.owner !== contract.owner) failures.push(`${id}.owner: must match requirements-trace operationalChecks`);
      if (record.releaseApplicability !== contract.releaseApplicability) {
        failures.push(`${id}.releaseApplicability: must match requirements-trace operationalChecks`);
      }
      if (!ALLOWED_OPERATIONAL_STATUSES.has(record.status)) {
        failures.push(`${id}: unsupported operational status ${record.status}`);
      }

      let acceptedStatus = false;
      if (contract.releaseApplicability === 'production-required') {
        acceptedStatus = record.status === 'PASS';
        if (!acceptedStatus) failures.push(`${id}: production-required operational check must be PASS`);
      } else if (contract.releaseApplicability === 'mvp-advisory') {
        acceptedStatus = record.status === 'PASS' || record.status === 'DEFERRED';
        if (!acceptedStatus) failures.push(`${id}: mvp-advisory operational check must be PASS or DEFERRED`);
      } else if (contract.releaseApplicability === 'future/non-mvp') {
        acceptedStatus = record.status === 'NOT_APPLICABLE';
        if (!acceptedStatus) failures.push(`${id}: future/non-mvp operational check must be NOT_APPLICABLE`);
      }
      if (acceptedStatus) operationalReadyCount += 1;

      const resolvedEvidence = validateEvidenceIds({
        evidenceIds: record.evidenceIds,
        label: id,
        subjectType: 'operational-check',
        subjectId: id,
        expectedResult: record.status,
        required: acceptedStatus,
        evidenceById,
        referencedEvidenceIds,
        failures,
      });
      if (contract.releaseApplicability === 'future/non-mvp'
        && record.status === 'NOT_APPLICABLE'
        && !resolvedEvidence.some((evidence) => evidence.kind === 'scope-approval')) {
        failures.push(`${id}.evidenceIds: NOT_APPLICABLE requires scope-approval evidence`);
      }
    }
  }

  if (!Array.isArray(status.blockers) || status.blockers.length === 0) {
    failures.push('release-status.blockers: expected a non-empty array');
  } else {
    const blockersById = new Map();
    for (const blocker of status.blockers) {
      const id = isObject(blocker) ? blocker.id : undefined;
      if (!requireString(id, 'release-status blocker id', failures)) continue;
      if (blockersById.has(id)) failures.push(`release-status.blockers: duplicate ${id}`);
      blockersById.set(id, blocker);
      if (!['P1', 'P2', 'P3'].includes(blocker.severity)) {
        failures.push(`${id}: unsupported blocker severity ${blocker.severity}`);
      }
      if (!ALLOWED_BLOCKER_STATUSES.has(blocker.status)) {
        failures.push(`${id}: unsupported blocker status ${blocker.status}`);
      }
      requireString(blocker.owner, `${id}.owner`, failures);
      requireString(blocker.description, `${id}.description`, failures);
      if (['P1', 'P2'].includes(blocker.severity) && blocker.status !== 'RESOLVED') {
        failures.push(`${id}: ${blocker.severity} blocker must be RESOLVED; ACCEPTED is never sufficient`);
        unresolvedBlockers += 1;
      }
      validateEvidenceIds({
        evidenceIds: blocker.evidenceIds,
        label: id,
        subjectType: 'blocker',
        subjectId: id,
        expectedResult: blocker.status,
        required: blocker.status === 'RESOLVED' || blocker.status === 'ACCEPTED',
        evidenceById,
        referencedEvidenceIds,
        failures,
      });
    }
    for (const expected of CANONICAL_BLOCKERS) {
      const actual = blockersById.get(expected.id);
      if (!actual) {
        failures.push(`release-status.blockers: missing canonical ${expected.id}`);
        unresolvedBlockers += 1;
        continue;
      }
      for (const field of ['severity', 'owner', 'description']) {
        if (actual[field] !== expected[field]) {
          failures.push(`${expected.id}.${field}: canonical blocker cannot be downgraded or renamed`);
        }
      }
    }
  }

  for (const evidenceId of evidenceById.keys()) {
    if (!referencedEvidenceIds.has(evidenceId)) {
      failures.push(`release-status.evidenceRegistry: unreferenced evidence ${evidenceId}`);
    }
  }

  const calculatedDecision = failures.length === 0 ? 'GO' : 'NO_GO';
  if (['GO', 'NO_GO'].includes(status.declaredDecision)
    && status.declaredDecision !== calculatedDecision) {
    failures.push(`release-status.declaredDecision is ${status.declaredDecision}, expected ${calculatedDecision}`);
  }

  return {
    decision: failures.length === 0 && status.declaredDecision === 'GO' ? 'GO' : 'NO_GO',
    failures,
    summary: {
      acceptancePassCount,
      acceptanceRequiredCount: REQUIRED_ACCEPTANCE_IDS.length,
      decisionCount,
      decisionRequiredCount: REQUIRED_DECISION_IDS.length,
      operationalReadyCount,
      operationalRequiredCount: operationalContractById.size,
      unresolvedBlockers,
    },
  };
}

async function digestRepositoryFile(root, relativePath) {
  if (!safeRepositoryPath(relativePath)) return null;
  const absolutePath = path.join(root, ...relativePath.split('/'));
  if (!existsSync(absolutePath)) return null;
  try {
    return createHash('sha256').update(await readFile(absolutePath)).digest('hex');
  } catch {
    return null;
  }
}

async function readRepositoryText(root, relativePath) {
  if (!safeRepositoryPath(relativePath)) return null;
  const absolutePath = path.join(root, ...relativePath.split('/'));
  if (!existsSync(absolutePath)) return null;
  try {
    return await readFile(absolutePath, 'utf8');
  } catch {
    return null;
  }
}

function digestGitBlob(root, commitSha, relativePath) {
  if (!COMMIT_PATTERN.test(commitSha ?? '') || !safeRepositoryPath(relativePath)) return null;
  const result = spawnSync('git', ['show', `${commitSha}:${relativePath}`], {
    cwd: root,
    encoding: null,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) return null;
  return createHash('sha256').update(result.stdout).digest('hex');
}

function readGitBlob(root, commitSha, relativePath) {
  if (!COMMIT_PATTERN.test(commitSha ?? '') || !safeRepositoryPath(relativePath)) return null;
  const result = spawnSync('git', ['show', `${commitSha}:${relativePath}`], {
    cwd: root,
    encoding: null,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.status === 0 && Buffer.isBuffer(result.stdout) ? result.stdout : null;
}

function includedThemeArtifactPath(relativePath) {
  const parts = relativePath.split('/');
  const forbidden = new Set(['node_modules', 'scripts', 'tests', 'dist']);
  if (parts.some((part) => forbidden.has(part))) return false;
  if (['assets', 'partials', 'locales', 'data'].includes(parts[0])) return true;
  if (parts.length !== 1) return false;
  return ['package.json', 'routes.yaml', 'README.md', 'LICENSE'].includes(relativePath)
    || path.posix.extname(relativePath) === '.hbs';
}

function candidateThemeFiles(root, candidateCommitSha, sourceRoot) {
  if (!COMMIT_PATTERN.test(candidateCommitSha ?? '') || sourceRoot !== ARTIFACT_SOURCE_ROOT) return null;
  const result = spawnSync('git', ['ls-tree', '-r', '-z', candidateCommitSha, '--', sourceRoot], {
    cwd: root,
    encoding: null,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) return null;

  const prefix = `${sourceRoot}/`;
  return result.stdout.toString('utf8').split('\0').filter(Boolean).flatMap((entry) => {
    const match = /^(\d{6})\s+blob\s+[0-9a-f]+\t(.+)$/u.exec(entry);
    if (!match || !match[1].startsWith('100') || !match[2].startsWith(prefix)) return [];
    const relativePath = match[2].slice(prefix.length);
    return includedThemeArtifactPath(relativePath) ? [{relativePath, repositoryPath: match[2]}] : [];
  }).sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
}

async function inspectCandidateArtifact(root, candidateCommitSha, gatePolicy) {
  const artifactPath = gatePolicy?.artifactPath;
  const sourceRoot = gatePolicy?.artifactSourceRoot;
  const sourceFiles = candidateThemeFiles(root, candidateCommitSha, sourceRoot);
  const sourceEntries = [];
  if (Array.isArray(sourceFiles)) {
    for (const sourceFile of sourceFiles) {
      const content = readGitBlob(root, candidateCommitSha, sourceFile.repositoryPath);
      if (!content) return null;
      sourceEntries.push({
        relativePath: sourceFile.relativePath,
        content,
        sha256: createHash('sha256').update(content).digest('hex'),
      });
    }
  }
  if (sourceEntries.length === 0) return null;

  const manifest = sourceEntries
    .map((entry) => `${entry.relativePath}\0${entry.sha256}\n`)
    .join('');
  const candidateArtifactSourceSha256 = createHash('sha256').update(manifest, 'utf8').digest('hex');
  const artifactAbsolutePath = safeRepositoryPath(artifactPath)
    ? path.join(root, ...artifactPath.split('/'))
    : null;
  if (!artifactAbsolutePath || !existsSync(artifactAbsolutePath)) {
    return {
      artifactExists: false,
      artifactSha256: null,
      artifactMatchesCandidateSource: false,
      candidateArtifactSourceSha256,
      artifactChecksumsPath: gatePolicy?.artifactChecksumsPath,
      artifactChecksumsExists: false,
      artifactChecksumsMatchesArtifact: false,
      artifactChecksumsSha256: null,
    };
  }

  let artifact;
  try {
    artifact = await readFile(artifactAbsolutePath);
  } catch {
    return null;
  }
  const artifactSha256 = createHash('sha256').update(artifact).digest('hex');
  const checksumText = `${artifactSha256}  ${path.posix.basename(artifactPath)}\n`;
  const checksumsPath = gatePolicy?.artifactChecksumsPath;
  const checksumsAbsolutePath = safeRepositoryPath(checksumsPath)
    ? path.join(root, ...checksumsPath.split('/'))
    : null;
  let checksumsContent = null;
  if (checksumsAbsolutePath && existsSync(checksumsAbsolutePath)) {
    try {
      checksumsContent = await readFile(checksumsAbsolutePath);
    } catch {
      checksumsContent = null;
    }
  }
  const artifactChecksumsExists = Buffer.isBuffer(checksumsContent);
  const artifactChecksumsMatchesArtifact = artifactChecksumsExists
    && checksumsContent.equals(Buffer.from(checksumText, 'utf8'));
  const artifactChecksumsSha256 = artifactChecksumsExists
    ? createHash('sha256').update(checksumsContent).digest('hex')
    : null;
  let artifactMatchesCandidateSource = false;
  try {
    const requireFromTheme = createRequire(path.join(root, ARTIFACT_SOURCE_ROOT, 'package.json'));
    const {unzipSync} = requireFromTheme('fflate');
    const extracted = unzipSync(new Uint8Array(artifact));
    const extractedNames = Object.keys(extracted).sort((left, right) => left.localeCompare(right, 'en'));
    const sourceNames = sourceEntries.map((entry) => entry.relativePath);
    artifactMatchesCandidateSource = extractedNames.length === sourceNames.length
      && extractedNames.every((entry, index) => entry === sourceNames[index])
      && sourceEntries.every((entry) => Buffer.from(extracted[entry.relativePath]).equals(entry.content));
  } catch {
    artifactMatchesCandidateSource = false;
  }

  return {
    artifactExists: true,
    artifactSha256,
    artifactMatchesCandidateSource,
    candidateArtifactSourceSha256,
    artifactChecksumsPath: checksumsPath,
    artifactChecksumsExists,
    artifactChecksumsMatchesArtifact,
    artifactChecksumsSha256,
  };
}

export async function collectRuntimeContext(root, status, policy, nowMs = Date.now()) {
  const headResult = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  const worktreeResult = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  const currentHeadSha = headResult.status === 0 ? headResult.stdout.trim().toLowerCase() : null;
  const candidateCommitSha = status?.release?.candidateCommitSha;
  const candidateCommitResult = COMMIT_PATTERN.test(candidateCommitSha ?? '')
    ? spawnSync('git', ['cat-file', '-e', `${candidateCommitSha}^{commit}`], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
      })
    : null;
  const candidateCommitExists = candidateCommitResult?.status === 0;
  const ancestorResult = candidateCommitExists && COMMIT_PATTERN.test(currentHeadSha ?? '')
    ? spawnSync('git', ['merge-base', '--is-ancestor', candidateCommitSha, currentHeadSha], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
      })
    : null;
  const diffResult = candidateCommitExists && COMMIT_PATTERN.test(currentHeadSha ?? '')
    ? spawnSync('git', ['diff', '--name-only', '--no-renames', '-z', candidateCommitSha, currentHeadSha, '--'], {
        cwd: root,
        encoding: null,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      })
    : null;
  const requirementsDocumentPath = policy?.requirementsDocument;
  const artifactPath = policy?.releaseGate?.artifactPath;
  const candidateRequirementsSha256 = digestGitBlob(root, candidateCommitSha, requirementsDocumentPath);
  const artifactInspection = await inspectCandidateArtifact(root, candidateCommitSha, policy?.releaseGate);

  const repositorySourceRefs = Array.isArray(status?.evidenceRegistry)
    ? [...new Set(status.evidenceRegistry.flatMap((evidence) => {
        if (evidence?.sourceType === 'repository-file') return [evidence.sourceRef];
        if (evidence?.sourceType === 'github-actions') return [evidence.sourceSnapshotRef];
        return [];
      }).filter((sourceRef) => safeRepositoryEvidencePath(sourceRef)))]
    : [];
  const repositoryFiles = await Promise.all(repositorySourceRefs.map(async (sourceRef) => ({
    sourceRef,
    digest: await digestRepositoryFile(root, sourceRef),
    content: await readRepositoryText(root, sourceRef),
  })));
  const repositoryFileDigests = new Map(repositoryFiles.map(({sourceRef, digest}) => [sourceRef, digest]));
  const repositoryFileContents = new Map(repositoryFiles.map(({sourceRef, content}) => [sourceRef, content]));

  return {
    nowMs,
    currentHeadSha,
    candidateCommitSha: COMMIT_PATTERN.test(candidateCommitSha ?? '') ? candidateCommitSha : null,
    candidateCommitExists,
    candidateIsAncestor: ancestorResult?.status === 0,
    attestationDiffInspected: diffResult?.status === 0,
    changedPaths: diffResult?.status === 0
      ? diffResult.stdout.toString('utf8').split('\0').filter(Boolean)
      : null,
    worktreeClean: worktreeResult.status === 0 && worktreeResult.stdout.trim() === '',
    candidateRequirementsDocumentPath: requirementsDocumentPath,
    candidateRequirementsDocumentExists: candidateRequirementsSha256 !== null,
    candidateRequirementsSha256,
    artifactPath,
    artifactExists: artifactInspection?.artifactExists === true,
    artifactSha256: artifactInspection?.artifactSha256 ?? null,
    artifactMatchesCandidateSource: artifactInspection?.artifactMatchesCandidateSource === true,
    candidateArtifactSourceSha256: artifactInspection?.candidateArtifactSourceSha256 ?? null,
    artifactChecksumsPath: artifactInspection?.artifactChecksumsPath ?? policy?.releaseGate?.artifactChecksumsPath,
    artifactChecksumsExists: artifactInspection?.artifactChecksumsExists === true,
    artifactChecksumsMatchesArtifact: artifactInspection?.artifactChecksumsMatchesArtifact === true,
    artifactChecksumsSha256: artifactInspection?.artifactChecksumsSha256 ?? null,
    repositoryFileDigests,
    repositoryFileContents,
  };
}

async function loadJson(absolutePath) {
  return JSON.parse(await readFile(absolutePath, 'utf8'));
}

async function runCli() {
  if (process.argv.length > 2) {
    console.log('RELEASE_GATE NO_GO');
    console.error('- release gate does not accept alternate status or policy inputs');
    process.exitCode = 1;
    return;
  }
  const root = process.cwd();
  let status;
  let policy;
  let requirementsTrace;
  try {
    [status, policy, requirementsTrace] = await Promise.all([
      loadJson(path.join(root, 'config/release-status.json')),
      loadJson(path.join(root, 'config/harness-policy.json')),
      loadJson(path.join(root, 'config/requirements-trace.json')),
    ]);
  } catch (error) {
    console.log('RELEASE_GATE NO_GO');
    console.error(`- release gate input is missing or invalid JSON (${error.message})`);
    process.exitCode = 1;
    return;
  }

  const runtime = await collectRuntimeContext(root, status, policy);
  const result = evaluateReleaseReadiness(status, policy, runtime, requirementsTrace);
  console.log(`RELEASE_GATE ${result.decision}`);
  console.log(`ACCEPTANCE ${result.summary.acceptancePassCount}/${result.summary.acceptanceRequiredCount} PASS`);
  console.log(`DECISIONS ${result.summary.decisionCount}/${result.summary.decisionRequiredCount} DECIDED`);
  console.log(`OPERATIONAL ${result.summary.operationalReadyCount}/${result.summary.operationalRequiredCount} RELEASE_READY`);
  console.log(`BLOCKERS ${result.summary.unresolvedBlockers} UNRESOLVED P1/P2`);

  if (result.failures.length > 0) {
    for (const failure of result.failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('RELEASE_GATE_OK production readiness recorded');
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) await runCli();
