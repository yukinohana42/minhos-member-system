import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { evaluateReleaseReadiness } from './check-release-readiness.mjs';
import { inspectContentForSecrets } from './check-secrets.mjs';
import {
  inspectCommitIdentityLog,
  inspectRepositoryDepth,
  isApprovedGitIdentityEmail,
  parsePrePushInput,
} from './check-commit-identities.mjs';
import { validateRequirementsSemanticContract } from './check-requirements.mjs';
import {
  validateGithubActionsPolicy,
  validateNativeProfileRawContract,
  validateProfileFormItemTitleDefaults,
} from './config-contracts.mjs';

const root = process.cwd();

function run(script, environment = {}) {
  return spawnSync(process.execPath, [path.join('scripts', script)], {
    cwd: root,
    encoding: 'utf8',
    env: {...process.env, ...environment},
  });
}

function runFixtureCommand(command, args, cwd, options = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
    env: {...process.env, ...options.env},
  });
}

function requireFixtureGit(args, cwd, options = {}) {
  const result = runFixtureCommand('git', args, cwd, options);
  assert.equal(result.status, 0, `git ${args[0]} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

async function validReleaseFixture() {
  const [baseStatus, basePolicy, requirementsTrace] = await Promise.all([
    readFile(path.join(root, 'config/release-status.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'config/harness-policy.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'config/requirements-trace.json'), 'utf8').then(JSON.parse),
  ]);
  const status = structuredClone(baseStatus);
  const policy = structuredClone(basePolicy);
  const candidateCommitSha = 'a'.repeat(40);
  const currentHeadSha = 'f'.repeat(40);
  const requirementsSha256 = 'b'.repeat(64);
  const artifactSha256 = 'c'.repeat(64);
  const artifactSourceSha256 = '1'.repeat(64);
  const artifactChecksumsSha256 = '2'.repeat(64);
  const repositoryEvidenceSha256 = 'd'.repeat(64);
  const sourceRef = 'docs/evidence/records/release-review.json';
  const ciSnapshotRef = 'docs/evidence/records/ci-run-1234567890.json';
  const environmentId = 'prod-ghost-site-001';
  const executedAt = '2026-08-28T10:00:00Z';
  const ciRunUrl = 'https://github.com/yukinohana42/minhos-member-system/actions/runs/1234567890';
  const ciBinding = {
    sourceRef: ciRunUrl,
    repository: 'yukinohana42/minhos-member-system',
    workflow: '.github/workflows/ci.yml',
    job: 'verify',
    check: 'verify',
    runId: '1234567890',
    runAttempt: 1,
    conclusion: 'success',
    headSha: candidateCommitSha,
    artifactName: policy.releaseGate.artifactNameTemplate.replace(
      '{candidateCommitSha}',
      candidateCommitSha,
    ),
    artifactPath: policy.releaseGate.artifactPath,
    artifactSha256,
    artifactSourceSha256,
    artifactChecksumsPath: policy.releaseGate.artifactChecksumsPath,
    artifactChecksumsSha256,
  };
  const ciSnapshot = `${JSON.stringify({schemaVersion: '1.0', ...ciBinding})}\n`;
  const ciSnapshotSha256 = createHash('sha256').update(ciSnapshot, 'utf8').digest('hex');

  policy.releaseGate.targetEnvironmentId = environmentId;
  status.declaredDecision = 'GO';
  status.lastReviewed = '2026-08-28';
  status.release = {
    releaseId: 'release-2026-08-28',
    candidateCommitSha,
    targetEnvironmentId: environmentId,
    requirementsVersion: 'v1.1',
    requirementsSha256,
    reviewedAt: '2026-08-28T11:00:00Z',
    actor: 'release-operator',
    approver: 'responsible-owner',
    artifactPath: policy.releaseGate.artifactPath,
    artifactSha256,
    artifactSourceSha256,
    artifactChecksumsSha256,
    evidenceIds: ['EV-CI-VERIFY-0001'],
  };

  const evidenceRegistry = [{
    id: 'EV-CI-VERIFY-0001',
    subjectType: 'release',
    subjectId: status.release.releaseId,
    kind: 'continuous-integration',
    result: 'PASS',
    environment: 'production',
    environmentId,
    commitSha: candidateCommitSha,
    requirementsSha256,
    executedAt,
    actor: 'github-actions',
    approver: 'responsible-owner',
    sourceType: 'github-actions',
    sourceDigest: ciSnapshotSha256,
    sourceSnapshotRef: ciSnapshotRef,
    ...ciBinding,
  }];

  function bindEvidence(record, subjectType, result, kind) {
    const evidenceId = `EV-${record.id}-RESULT`;
    record.status = result;
    record.evidenceIds = [evidenceId];
    evidenceRegistry.push({
      id: evidenceId,
      subjectType,
      subjectId: record.id,
      kind,
      result,
      environment: 'production',
      environmentId,
      commitSha: candidateCommitSha,
      requirementsSha256,
      executedAt,
      actor: record.owner,
      approver: 'responsible-owner',
      sourceType: 'repository-file',
      sourceRef,
      sourceDigest: repositoryEvidenceSha256,
    });
  }

  for (const record of status.acceptanceTests) {
    bindEvidence(record, 'acceptance-test', 'PASS', 'acceptance-result');
  }
  for (const record of status.decisions) {
    bindEvidence(record, 'decision', 'DECIDED', 'decision-record');
  }
  for (const record of status.operationalChecks) {
    const result = record.releaseApplicability === 'production-required'
      ? 'PASS'
      : record.releaseApplicability === 'mvp-advisory'
        ? 'DEFERRED'
        : 'NOT_APPLICABLE';
    const kind = record.releaseApplicability === 'future/non-mvp'
      ? 'scope-approval'
      : 'operational-result';
    bindEvidence(record, 'operational-check', result, kind);
  }
  for (const record of status.blockers) {
    bindEvidence(record, 'blocker', 'RESOLVED', 'resolution-record');
  }
  status.evidenceRegistry = evidenceRegistry;

  const runtime = {
    nowMs: Date.parse('2026-08-28T12:00:00Z'),
    currentHeadSha,
    candidateCommitSha,
    candidateCommitExists: true,
    candidateIsAncestor: true,
    attestationDiffInspected: true,
    changedPaths: [
      'config/release-status.json',
      'docs/evidence/records/release-review.json',
      ciSnapshotRef,
    ],
    worktreeClean: true,
    candidateRequirementsDocumentPath: policy.requirementsDocument,
    candidateRequirementsDocumentExists: true,
    candidateRequirementsSha256: requirementsSha256,
    artifactPath: policy.releaseGate.artifactPath,
    artifactExists: true,
    artifactSha256,
    artifactMatchesCandidateSource: true,
    candidateArtifactSourceSha256: artifactSourceSha256,
    artifactChecksumsPath: policy.releaseGate.artifactChecksumsPath,
    artifactChecksumsExists: true,
    artifactChecksumsMatchesArtifact: true,
    artifactChecksumsSha256,
    repositoryFileDigests: new Map([
      [sourceRef, repositoryEvidenceSha256],
      [ciSnapshotRef, ciSnapshotSha256],
    ]),
    repositoryFileContents: new Map([[ciSnapshotRef, ciSnapshot]]),
  };
  return {status, policy, runtime, requirementsTrace};
}

async function requirementsContractFixture() {
  const [trace, document] = await Promise.all([
    readFile(path.join(root, 'config/requirements-trace.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'docs/minhos-membership-requirements-v1.1.md'), 'utf8'),
  ]);
  return {trace, document};
}

test('configuration check passes', () => {
  const result = run('check-config.mjs');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /CONFIG_OK/u);
});

test('configuration contract rejects profile Form item-title default drift', async () => {
  const [registry, form] = await Promise.all([
    readFile(path.join(root, 'packages/apps-script/script-properties.names.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'config/form-blueprint.json'), 'utf8').then(JSON.parse),
  ]);
  const alignedRegistry = structuredClone(registry);
  const fieldsById = new Map(form.form.fields.map((field) => [field.id, field]));
  const fieldByProperty = new Map([
    ['PROFILE_EMAIL_ITEM_TITLE', 'profile_email'],
    ['PROFILE_AFFILIATION_ITEM_TITLE', 'affiliation'],
    ['PROFILE_TITLE_OR_ROLE_ITEM_TITLE', 'title_or_role'],
    ['PROFILE_PARTICIPANT_TYPE_ITEM_TITLE', 'participant_type'],
    ['PROFILE_PRIVACY_ACK_ITEM_TITLE', 'privacy_acknowledgement'],
  ]);
  for (const property of alignedRegistry.properties) {
    const fieldId = fieldByProperty.get(property.name);
    if (fieldId) property.default = fieldsById.get(fieldId).label;
  }
  assert.deepEqual(validateProfileFormItemTitleDefaults(alignedRegistry, form), []);

  alignedRegistry.properties.find(({name}) => name === 'PROFILE_EMAIL_ITEM_TITLE').default = 'drifted label';
  assert.ok(validateProfileFormItemTitleDefaults(alignedRegistry, form).some(
    (failure) => failure.includes('PROFILE_EMAIL_ITEM_TITLE.default must exactly match'),
  ));
});

test('configuration contract keeps the Form-owned RAW tab native and opaque', async () => {
  const [sheets, form] = await Promise.all([
    readFile(path.join(root, 'config/sheets-schema.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'config/form-blueprint.json'), 'utf8').then(JSON.parse),
  ]);
  assert.deepEqual(validateNativeProfileRawContract(sheets, form), []);

  const managedRaw = structuredClone(sheets);
  const raw = managedRaw.tabs.find((tab) => tab.name === '30_Profile_RAW');
  raw.primaryKey = 'google_form_response_id';
  raw.columns = ['google_form_response_id', 'Timestamp'];
  raw.nativeContract.responseIdColumn = true;
  const managedFailures = validateNativeProfileRawContract(managedRaw, form);
  assert.ok(managedFailures.some((failure) => failure.includes('primaryKey must be null')));
  assert.ok(managedFailures.some((failure) => failure.includes('native headers are variable')));
  assert.ok(managedFailures.some((failure) => failure.includes('responseIdColumn')));

  const wrongIdentity = structuredClone(form);
  wrongIdentity.matching.responseIdentitySource = 'RAW.google_form_response_id';
  wrongIdentity.matching.rawSheetHasResponseIdColumn = true;
  const identityFailures = validateNativeProfileRawContract(sheets, wrongIdentity);
  assert.ok(identityFailures.some((failure) => failure.includes('FormResponse.getId()')));
  assert.ok(identityFailures.some((failure) => failure.includes('rawSheetHasResponseIdColumn')));
});

test('GitHub Actions policy exactly matches full-SHA workflow uses and app-bound main protection', async () => {
  const [permissions, selectedActions, workflow, mainProtection] = await Promise.all([
    readFile(path.join(root, 'config/github-actions-permissions.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'config/github-actions-selected-actions.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8'),
    readFile(path.join(root, 'config/github-main-protection.json'), 'utf8').then(JSON.parse),
  ]);

  assert.deepEqual(validateGithubActionsPolicy(permissions, selectedActions, workflow), []);
  assert.deepEqual(mainProtection.required_status_checks, {
    strict: true,
    contexts: ['verify'],
    checks: [{context: 'verify', app_id: 15368}],
  });
});

test('GitHub CI fetches full history and runs the commit identity privacy gate', async () => {
  const [workflow, packageManifest, prePushHook] = await Promise.all([
    readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8'),
    readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, '.githooks/pre-push'), 'utf8'),
  ]);

  assert.match(workflow, /fetch-depth:\s*0/u);
  assert.equal(
    packageManifest.scripts['check:commit-identities'],
    'node scripts/check-commit-identities.mjs',
  );
  assert.match(packageManifest.scripts['verify:all'], /npm run check:commit-identities/u);
  assert.equal(packageManifest.scripts['setup:git-hooks'], 'git config --local core.hooksPath .githooks');
  assert.match(prePushHook, /node scripts\/check-commit-identities\.mjs --pre-push/u);
  const hookIndexEntry = spawnSync('git', ['ls-files', '--stage', '.githooks/pre-push'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(hookIndexEntry.status, 0, hookIndexEntry.stderr);
  assert.match(hookIndexEntry.stdout, /^100755\s/u);
});

test('GitHub Actions policy rejects unpinned workflow uses and allowlist drift', async () => {
  const [permissions, selectedActions, workflow] = await Promise.all([
    readFile(path.join(root, 'config/github-actions-permissions.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'config/github-actions-selected-actions.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8'),
  ]);
  const checkoutReference = selectedActions.patterns_allowed.find((reference) => reference.startsWith('actions/checkout@'));
  const unpinnedWorkflow = workflow.replace(checkoutReference, 'actions/checkout@v4');
  const unpinnedFailures = validateGithubActionsPolicy(permissions, selectedActions, unpinnedWorkflow);
  assert.ok(unpinnedFailures.some((failure) => failure.includes('is not pinned to a lowercase 40-character SHA')));
  assert.ok(unpinnedFailures.some((failure) => failure.includes('missing workflow external use actions/checkout@v4')));
  assert.ok(unpinnedFailures.some((failure) => failure.includes(`allows action not used by workflow ${checkoutReference}`)));

  const unpinnedSelection = structuredClone(selectedActions);
  unpinnedSelection.patterns_allowed[0] = 'actions/checkout@v4';
  assert.ok(validateGithubActionsPolicy(permissions, unpinnedSelection, workflow).some(
    (failure) => failure.includes('expected an exact action pinned to a lowercase 40-character SHA'),
  ));

  const inlineFailures = validateGithubActionsPolicy(
    permissions,
    selectedActions,
    `jobs:\n  verify:\n    steps:\n      - { uses: actions/checkout@v4 }\n`,
  );
  assert.ok(inlineFailures.some((failure) => failure.includes('uses must use a standalone literal YAML key')));

  const missingSelection = structuredClone(selectedActions);
  const omittedReference = missingSelection.patterns_allowed.pop();
  assert.ok(validateGithubActionsPolicy(permissions, missingSelection, workflow).some(
    (failure) => failure.includes(`missing workflow external use ${omittedReference}`),
  ));

  const extraSelection = structuredClone(selectedActions);
  const unusedReference = `actions/cache@${'a'.repeat(40)}`;
  extraSelection.patterns_allowed.push(unusedReference);
  assert.ok(validateGithubActionsPolicy(permissions, extraSelection, workflow).some(
    (failure) => failure.includes(`allows action not used by workflow ${unusedReference}`),
  ));
});

test('GitHub Actions policy rejects weakened repository permissions', async () => {
  const [permissions, selectedActions, workflow] = await Promise.all([
    readFile(path.join(root, 'config/github-actions-permissions.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'config/github-actions-selected-actions.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8'),
  ]);
  const weakenedPermissions = {
    ...permissions,
    enabled: false,
    allowed_actions: 'all',
    sha_pinning_required: false,
  };
  const weakenedSelection = {
    ...selectedActions,
    github_owned_allowed: true,
    verified_allowed: true,
  };
  const failures = validateGithubActionsPolicy(weakenedPermissions, weakenedSelection, workflow);
  for (const expected of [
    'enabled must be true',
    'allowed_actions must be selected',
    'sha_pinning_required must be true',
    'github_owned_allowed must be false',
    'verified_allowed must be false',
  ]) {
    assert.ok(failures.some((failure) => failure.includes(expected)), expected);
  }
});

test('requirements trace covers all acceptance IDs in the requirements document', async () => {
  const trace = JSON.parse(await readFile(path.join(root, 'config/requirements-trace.json'), 'utf8'));
  const document = await readFile(path.join(root, 'docs/minhos-membership-requirements-v1.1.md'), 'utf8');
  const documentAcceptanceIds = [...document.matchAll(/^\|\s*(AT-\d+)\s*\|/gmu)].map((match) => match[1]);
  assert.deepEqual(new Set(trace.requiredAcceptanceIds), new Set(documentAcceptanceIds));
});

test('requirements check passes', () => {
  const result = run('check-requirements.mjs');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /REQUIREMENTS_OK/u);
});

test('canonical requirements semantic contract passes', async () => {
  const fixture = await requirementsContractFixture();
  const result = validateRequirementsSemanticContract(fixture.trace, fixture.document);
  assert.deepEqual(result.failures, []);
  assert.match(result.digest, /^[a-f0-9]{64}$/u);
});

test('requirements semantic contract rejects a plausible but false AT remapping', async () => {
  const fixture = await requirementsContractFixture();
  const trace = structuredClone(fixture.trace);
  trace.requirementMappings.find(({id}) => id === 'PUB-03').acceptanceIds = ['AT-45'];
  const result = validateRequirementsSemanticContract(trace, fixture.document);
  assert.ok(result.failures.some((failure) => failure.includes('semantic contract SHA-256 mismatch')));
});

test('requirements semantic contract rejects a long unrelated OC assertion', async () => {
  const fixture = await requirementsContractFixture();
  const trace = structuredClone(fixture.trace);
  trace.operationalChecks.find(({id}) => id === 'OC-PUB-01').assertion =
    '会議室の照明、空調、机、椅子、筆記具が所定の位置にあり、担当者が毎朝その数量を記録していることを合格条件とする。';
  const result = validateRequirementsSemanticContract(trace, fixture.document);
  assert.ok(result.failures.some((failure) => failure.includes('semantic contract SHA-256 mismatch')));
});

test('requirements semantic contract rejects a weakened AT body', async () => {
  const fixture = await requirementsContractFixture();
  const document = fixture.document.replace(
    /^\| AT-03 \| 法務導線 \| .*$/mu,
    '| AT-03 | 法務導線 | 確認 |',
  );
  assert.notEqual(document, fixture.document);
  const result = validateRequirementsSemanticContract(fixture.trace, document);
  assert.ok(result.failures.some((failure) => failure.includes('AT-03: acceptance-test body is too short')));
  assert.ok(result.failures.some((failure) => failure.includes('semantic contract SHA-256 mismatch')));
});

test('requirements semantic contract rejects an invariant deletion', async () => {
  const fixture = await requirementsContractFixture();
  const trace = structuredClone(fixture.trace);
  trace.invariants = trace.invariants.filter(({id}) => id !== 'INV-03');
  const result = validateRequirementsSemanticContract(trace, fixture.document);
  assert.ok(result.failures.some((failure) => failure.includes('requirements-trace.invariants: missing INV-03')));
  assert.ok(result.failures.some((failure) => failure.includes('semantic contract SHA-256 mismatch')));
});

test('secret check passes without contacting a service', () => {
  const result = run('check-secrets.mjs');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /SECRETS_OK/u);
});

test('commit identity check accepts reachable GitHub noreply identities', () => {
  const approvedEmails = [
    'noreply@github.com',
    '12345678+future-collaborator@users.noreply.github.com',
    'legacy-collaborator@users.noreply.github.com',
    '49699333+dependabot[bot]@users.noreply.github.com',
  ];
  for (const email of approvedEmails) assert.equal(isApprovedGitIdentityEmail(email), true);

  const log = [
    `${'a'.repeat(40)}\t${approvedEmails[1]}\t${approvedEmails[0]}`,
    `${'b'.repeat(40)}\t${approvedEmails[2]}\t${approvedEmails[3]}`,
  ].join('\n');
  assert.deepEqual(inspectCommitIdentityLog(log), { commitCount: 2, findings: [] });
});

test('commit identity check rejects private and lookalike domains without echoing email values', () => {
  const privateFixture = ['operator', 'example.invalid'].join('@');
  const otherNoreplyFixture = ['noreply', 'service.invalid'].join('@');
  const suffixFixture = ['123+operator', 'users.noreply.github.com.example.invalid'].join('@');
  const log = [
    `${'c'.repeat(40)}\t${privateFixture}\tnoreply@github.com`,
    `${'d'.repeat(40)}\tlegacy@users.noreply.github.com\t${otherNoreplyFixture}`,
    `${'e'.repeat(40)}\t${suffixFixture}\tnoreply@github.com`,
  ].join('\n');
  const result = inspectCommitIdentityLog(log);

  assert.deepEqual(result.findings, [
    { sha: 'c'.repeat(40), role: 'author' },
    { sha: 'd'.repeat(40), role: 'committer' },
    { sha: 'e'.repeat(40), role: 'author' },
  ]);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(privateFixture), false);
  assert.equal(serialized.includes(otherNoreplyFixture), false);
  assert.equal(serialized.includes(suffixFixture), false);
});

test('commit identity check fails closed on malformed or empty Git history records', () => {
  assert.deepEqual(inspectCommitIdentityLog(''), {
    commitCount: 0,
    findings: [{ sha: 'UNKNOWN', role: 'history-empty' }],
  });
  assert.deepEqual(inspectCommitIdentityLog('not-a-sha\tuser@users.noreply.github.com\tnoreply@github.com'), {
    commitCount: 1,
    findings: [{ sha: 'UNKNOWN', role: 'history-record' }],
  });
});

test('commit identity check rejects shallow and indeterminate repository history', () => {
  assert.equal(inspectRepositoryDepth('false\n'), null);
  assert.deepEqual(inspectRepositoryDepth('true\n'), {
    sha: 'UNKNOWN',
    role: 'history-shallow',
  });
  assert.deepEqual(inspectRepositoryDepth('unexpected'), {
    sha: 'UNKNOWN',
    role: 'history-depth',
  });
  assert.deepEqual(inspectRepositoryDepth(undefined), {
    sha: 'UNKNOWN',
    role: 'history-depth',
  });
});

test('pre-push parser validates every pushed tip and permits deletion-only updates', () => {
  const firstSha = '1'.repeat(40);
  const secondSha = '2'.repeat(40);
  const zeroSha = '0'.repeat(40);
  assert.deepEqual(parsePrePushInput([
    `refs/heads/first ${firstSha} refs/heads/first ${zeroSha}`,
    `refs/heads/second ${secondSha} refs/heads/second ${firstSha}`,
    `(delete) ${zeroSha} refs/heads/obsolete ${secondSha}`,
  ].join('\n')), {
    revisions: [firstSha, secondSha],
    findings: [],
  });
  assert.deepEqual(parsePrePushInput('malformed'), {
    revisions: [],
    findings: [{ sha: 'UNKNOWN', role: 'pre-push-input' }],
  });
});

test('commit identity CLI rejects non-HEAD pushed tips, merge ancestors, shallow clones and missing Git', async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'minhos-commit-identity-'));
  const source = path.join(fixtureRoot, 'source');
  const shallow = path.join(fixtureRoot, 'shallow');
  const empty = path.join(fixtureRoot, 'empty');
  const script = path.join(root, 'scripts', 'check-commit-identities.mjs');
  const safeEmail = '12345678+fixture@users.noreply.github.com';
  const rejectedEmail = ['fixture', 'example.invalid'].join('@');
  const safeIdentity = {
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: safeEmail,
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: safeEmail,
  };

  try {
    requireFixtureGit(['init', '-b', 'main', source], fixtureRoot);
    await writeFile(path.join(source, 'safe.txt'), 'safe\n', 'utf8');
    requireFixtureGit(['add', 'safe.txt'], source);
    requireFixtureGit(['commit', '-m', 'safe fixture'], source, { env: safeIdentity });
    const safeSha = requireFixtureGit(['rev-parse', 'HEAD'], source);

    const safeRun = runFixtureCommand(process.execPath, [script], source);
    assert.equal(safeRun.status, 0, `${safeRun.stdout}\n${safeRun.stderr}`);

    requireFixtureGit(['switch', '-c', 'unsafe'], source);
    await writeFile(path.join(source, 'unsafe.txt'), 'unsafe\n', 'utf8');
    requireFixtureGit(['add', 'unsafe.txt'], source);
    requireFixtureGit(['commit', '-m', 'unsafe fixture'], source, {
      env: {...safeIdentity, GIT_COMMITTER_EMAIL: rejectedEmail},
    });
    const unsafeSha = requireFixtureGit(['rev-parse', 'HEAD'], source);
    requireFixtureGit(['switch', 'main'], source);

    const pushInput = `refs/heads/unsafe ${unsafeSha} refs/heads/unsafe ${'0'.repeat(40)}\n`;
    const pushedTipRun = runFixtureCommand(
      process.execPath,
      [script, '--pre-push'],
      source,
      { input: pushInput },
    );
    assert.equal(pushedTipRun.status, 1);
    assert.match(pushedTipRun.stderr, new RegExp(`sha=${unsafeSha} role=committer`, 'u'));
    assert.equal(`${pushedTipRun.stdout}\n${pushedTipRun.stderr}`.includes(rejectedEmail), false);

    const deletionRun = runFixtureCommand(
      process.execPath,
      [script, '--pre-push'],
      source,
      { input: `(delete) ${'0'.repeat(40)} refs/heads/unsafe ${unsafeSha}\n` },
    );
    assert.equal(deletionRun.status, 0, `${deletionRun.stdout}\n${deletionRun.stderr}`);
    assert.match(deletionRun.stdout, /commits=0/u);

    requireFixtureGit(['merge', '--no-ff', 'unsafe', '-m', 'merge fixture'], source, {
      env: safeIdentity,
    });
    const mergeRun = runFixtureCommand(process.execPath, [script], source);
    assert.equal(mergeRun.status, 1);
    assert.match(mergeRun.stderr, new RegExp(`sha=${unsafeSha} role=committer`, 'u'));
    assert.equal(`${mergeRun.stdout}\n${mergeRun.stderr}`.includes(rejectedEmail), false);

    requireFixtureGit(['clone', '--depth=1', pathToFileURL(source).href, shallow], fixtureRoot);
    const shallowRun = runFixtureCommand(process.execPath, [script], shallow);
    assert.equal(shallowRun.status, 1);
    assert.match(shallowRun.stderr, /role=history-shallow/u);

    await mkdir(empty);
    const missingGitRun = runFixtureCommand(process.execPath, [script], empty);
    assert.equal(missingGitRun.status, 1);
    assert.match(missingGitRun.stderr, /role=history-depth/u);
    assert.equal(`${missingGitRun.stdout}\n${missingGitRun.stderr}`.includes(rejectedEmail), false);

    const noPathEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'),
    );
    noPathEnvironment.PATH = '';
    const missingExecutableRun = spawnSync(process.execPath, [script], {
      cwd: source,
      encoding: 'utf8',
      windowsHide: true,
      env: noPathEnvironment,
    });
    assert.equal(missingExecutableRun.status, 1);
    assert.match(missingExecutableRun.stderr, /role=history-depth/u);
    assert.equal(
      `${missingExecutableRun.stdout}\n${missingExecutableRun.stderr}`.includes(rejectedEmail),
      false,
    );
    assert.match(safeSha, /^[0-9a-f]{40}$/u);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('secret inspector catches underscore-prefixed credential assignments', () => {
  const ghostName = ['GHOST', 'ADMIN', 'API', 'KEY'].join('_');
  const githubName = ['GITHUB', 'TOKEN'].join('_');
  const content = [
    `${ghostName}="${'x'.repeat(32)}"`,
    `${githubName}="${'y'.repeat(32)}"`,
  ].join('\n');
  const findings = inspectContentForSecrets('fixture.env', content);
  assert.ok(findings.some((finding) => finding.includes(ghostName)));
  assert.ok(findings.some((finding) => finding.includes(githubName)));
});

test('secret inspector detects Ghost Admin keys and fine-grained GitHub PATs', () => {
  const ghostAdminKey = `${'a'.repeat(24)}:${'b'.repeat(64)}`;
  const fineGrainedPat = [['github', 'pat'].join('_'), 'A'.repeat(40)].join('_');
  const findings = inspectContentForSecrets('fixture.txt', `${ghostAdminKey}\n${fineGrainedPat}`);
  assert.ok(findings.some((finding) => finding.includes('ghost-admin-api-key')));
  assert.ok(findings.some((finding) => finding.includes('github-fine-grained-token')));
});

test('secret inspector preserves explicit placeholder allowances', () => {
  const ghostName = ['GHOST', 'ADMIN', 'API', 'KEY'].join('_');
  const githubName = ['GITHUB', 'TOKEN'].join('_');
  const content = [
    `${ghostName}="REPLACE_ME"`,
    `${githubName}="<YOUR_GITHUB_TOKEN>"`,
  ].join('\n');
  assert.deepEqual(inspectContentForSecrets('fixture.env.example', content), []);
});

test('secret inspector catches unquoted dotenv and YAML Google OAuth credentials', () => {
  const refreshToken = ['1', '', `0g${'A'.repeat(48)}`].join('/');
  const clientSecret = ['GOCSPX', 'B'.repeat(28)].join('-');
  const dotenvFindings = inspectContentForSecrets(
    'fixture.env',
    `GOOGLE_REFRESH_TOKEN=${refreshToken} # local operator credential`,
  );
  const yamlFindings = inspectContentForSecrets(
    'fixture.yaml',
    `client_secret: ${clientSecret} # do not commit`,
  );
  assert.ok(dotenvFindings.some((finding) => finding.includes('secret-like assignment (GOOGLE_REFRESH_TOKEN)')));
  assert.ok(dotenvFindings.some((finding) => finding.includes('google-oauth-refresh-token')));
  assert.ok(yamlFindings.some((finding) => finding.includes('secret-like assignment (client_secret)')));
  assert.ok(yamlFindings.some((finding) => finding.includes('google-oauth-client-secret')));
});

test('secret inspector strips inline comments and still allows unquoted placeholders', () => {
  const content = [
    'GOOGLE_REFRESH_TOKEN=REPLACE_ME # populated outside Git',
    'client_secret: <YOUR_GOOGLE_CLIENT_SECRET> # populated outside Git',
    'GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }} # symbolic reference only',
    'GHOST_ADMIN_API_KEY="${GHOST_ADMIN_API_KEY}"',
  ].join('\n');
  assert.deepEqual(inspectContentForSecrets('fixture.env.example', content), []);
});

test('release evaluator accepts a fully bound GO fixture', async () => {
  const fixture = await validReleaseFixture();
  const result = evaluateReleaseReadiness(
    fixture.status,
    fixture.policy,
    fixture.runtime,
    fixture.requirementsTrace,
  );
  assert.equal(result.decision, 'GO', result.failures.join('\n'));
  assert.deepEqual(result.failures, []);
  assert.equal(result.summary.operationalReadyCount, fixture.requirementsTrace.operationalChecks.length);
});

test('release evaluator accepts only candidate-to-HEAD attestation changes', async () => {
  const sameCommit = await validReleaseFixture();
  sameCommit.runtime.currentHeadSha = sameCommit.runtime.candidateCommitSha;
  const sameCommitResult = evaluateReleaseReadiness(
    sameCommit.status,
    sameCommit.policy,
    sameCommit.runtime,
    sameCommit.requirementsTrace,
  );
  assert.equal(sameCommitResult.decision, 'NO_GO');
  assert.ok(sameCommitResult.failures.some((failure) => failure.includes('separate release-attestation commit')));

  const missingStatusAttestation = await validReleaseFixture();
  missingStatusAttestation.runtime.changedPaths = ['docs/evidence/records/release-review.json'];
  const missingStatusResult = evaluateReleaseReadiness(
    missingStatusAttestation.status,
    missingStatusAttestation.policy,
    missingStatusAttestation.runtime,
    missingStatusAttestation.requirementsTrace,
  );
  assert.equal(missingStatusResult.decision, 'NO_GO');
  assert.ok(missingStatusResult.failures.some((failure) => failure.includes('must update config/release-status.json')));

  const drift = await validReleaseFixture();
  drift.runtime.changedPaths.push('packages/ghost-theme/assets/js/member.js');
  const driftResult = evaluateReleaseReadiness(
    drift.status,
    drift.policy,
    drift.runtime,
    drift.requirementsTrace,
  );
  assert.equal(driftResult.decision, 'NO_GO');
  assert.ok(driftResult.failures.some((failure) => failure.includes('non-allowlisted drift')));

  const unrelatedCandidate = await validReleaseFixture();
  unrelatedCandidate.runtime.candidateIsAncestor = false;
  const ancestorResult = evaluateReleaseReadiness(
    unrelatedCandidate.status,
    unrelatedCandidate.policy,
    unrelatedCandidate.runtime,
    unrelatedCandidate.requirementsTrace,
  );
  assert.equal(ancestorResult.decision, 'NO_GO');
  assert.ok(ancestorResult.failures.some((failure) => failure.includes('must be an ancestor')));
});

test('release evaluator rejects a stale ZIP and mismatched canonical CI artifact digest', async () => {
  const staleZip = await validReleaseFixture();
  staleZip.runtime.artifactMatchesCandidateSource = false;
  const staleZipResult = evaluateReleaseReadiness(
    staleZip.status,
    staleZip.policy,
    staleZip.runtime,
    staleZip.requirementsTrace,
  );
  assert.equal(staleZipResult.decision, 'NO_GO');
  assert.ok(staleZipResult.failures.some((failure) => failure.includes('artifact contents do not match')));

  const digestMismatch = await validReleaseFixture();
  digestMismatch.status.evidenceRegistry[0].artifactSha256 = '9'.repeat(64);
  const digestResult = evaluateReleaseReadiness(
    digestMismatch.status,
    digestMismatch.policy,
    digestMismatch.runtime,
    digestMismatch.requirementsTrace,
  );
  assert.equal(digestResult.decision, 'NO_GO');
  assert.ok(digestResult.failures.some((failure) => failure.includes('candidate CI output artifact')));

  const checksumMismatch = await validReleaseFixture();
  checksumMismatch.runtime.artifactChecksumsMatchesArtifact = false;
  const checksumResult = evaluateReleaseReadiness(
    checksumMismatch.status,
    checksumMismatch.policy,
    checksumMismatch.runtime,
    checksumMismatch.requirementsTrace,
  );
  assert.equal(checksumResult.decision, 'NO_GO');
  assert.ok(checksumResult.failures.some((failure) => failure.includes('SHA256SUMS does not bind')));
});

test('release evaluator verifies the retained canonical CI snapshot', async () => {
  const digestMismatch = await validReleaseFixture();
  digestMismatch.status.evidenceRegistry[0].sourceDigest = '9'.repeat(64);
  const digestResult = evaluateReleaseReadiness(
    digestMismatch.status,
    digestMismatch.policy,
    digestMismatch.runtime,
    digestMismatch.requirementsTrace,
  );
  assert.equal(digestResult.decision, 'NO_GO');
  assert.ok(digestResult.failures.some((failure) => failure.includes('retained GitHub Actions snapshot file')));

  const contentMismatch = await validReleaseFixture();
  const ciEvidence = contentMismatch.status.evidenceRegistry[0];
  const snapshot = JSON.parse(contentMismatch.runtime.repositoryFileContents.get(ciEvidence.sourceSnapshotRef));
  snapshot.headSha = '9'.repeat(40);
  contentMismatch.runtime.repositoryFileContents.set(ciEvidence.sourceSnapshotRef, JSON.stringify(snapshot));
  const contentResult = evaluateReleaseReadiness(
    contentMismatch.status,
    contentMismatch.policy,
    contentMismatch.runtime,
    contentMismatch.requirementsTrace,
  );
  assert.equal(contentResult.decision, 'NO_GO');
  assert.ok(contentResult.failures.some((failure) => failure.includes('snapshot headSha does not match evidence')));
});

test('release evaluator enforces the complete operational-check contract', async () => {
  const missing = await validReleaseFixture();
  const removed = missing.status.operationalChecks.shift();
  missing.status.evidenceRegistry = missing.status.evidenceRegistry.filter(({subjectId}) => subjectId !== removed.id);
  const missingResult = evaluateReleaseReadiness(
    missing.status,
    missing.policy,
    missing.runtime,
    missing.requirementsTrace,
  );
  assert.ok(missingResult.failures.some((failure) => failure.includes(`missing ${removed.id}`)));

  const extra = await validReleaseFixture();
  extra.status.operationalChecks.push({
    id: 'OC-EXTRA-01',
    releaseApplicability: 'production-required',
    status: 'PASS',
    owner: 'system-owner',
    evidenceIds: [],
  });
  const extraResult = evaluateReleaseReadiness(
    extra.status,
    extra.policy,
    extra.runtime,
    extra.requirementsTrace,
  );
  assert.ok(extraResult.failures.some((failure) => failure.includes('unexpected OC-EXTRA-01')));

  const duplicate = await validReleaseFixture();
  duplicate.status.operationalChecks.push(structuredClone(duplicate.status.operationalChecks[0]));
  const duplicateResult = evaluateReleaseReadiness(
    duplicate.status,
    duplicate.policy,
    duplicate.runtime,
    duplicate.requirementsTrace,
  );
  assert.ok(duplicateResult.failures.some((failure) => failure.includes('duplicate OC-PUB-01')));

  const invalidStates = await validReleaseFixture();
  const productionRequired = invalidStates.status.operationalChecks.find(
    ({releaseApplicability}) => releaseApplicability === 'production-required',
  );
  productionRequired.status = 'DEFERRED';
  invalidStates.status.evidenceRegistry.find(({id}) => id === productionRequired.evidenceIds[0]).result = 'DEFERRED';
  const futureCheck = invalidStates.status.operationalChecks.find(
    ({releaseApplicability}) => releaseApplicability === 'future/non-mvp',
  );
  invalidStates.status.evidenceRegistry.find(({id}) => id === futureCheck.evidenceIds[0]).kind = 'scope-note';
  const invalidStateResult = evaluateReleaseReadiness(
    invalidStates.status,
    invalidStates.policy,
    invalidStates.runtime,
    invalidStates.requirementsTrace,
  );
  assert.ok(invalidStateResult.failures.some((failure) => failure.includes('production-required operational check must be PASS')));
  assert.ok(invalidStateResult.failures.some((failure) => failure.includes('requires scope-approval evidence')));
});

test('release evaluator rejects missing and bogus repository evidence', async () => {
  const missing = await validReleaseFixture();
  const missingId = missing.status.acceptanceTests[0].evidenceIds[0];
  missing.status.evidenceRegistry = missing.status.evidenceRegistry.filter(({id}) => id !== missingId);
  const missingResult = evaluateReleaseReadiness(
    missing.status,
    missing.policy,
    missing.runtime,
    missing.requirementsTrace,
  );
  assert.equal(missingResult.decision, 'NO_GO');
  assert.ok(missingResult.failures.some((failure) => failure.includes(`unknown evidence ${missingId}`)));

  const bogus = await validReleaseFixture();
  const repositoryEvidence = bogus.status.evidenceRegistry.find(({sourceType}) => sourceType === 'repository-file');
  repositoryEvidence.sourceDigest = 'f'.repeat(64);
  const bogusResult = evaluateReleaseReadiness(
    bogus.status,
    bogus.policy,
    bogus.runtime,
    bogus.requirementsTrace,
  );
  assert.equal(bogusResult.decision, 'NO_GO');
  assert.ok(bogusResult.failures.some((failure) => failure.includes('does not match repository evidence file')));
});

test('release evaluator rejects a missing canonical blocker', async () => {
  const fixture = await validReleaseFixture();
  const removed = fixture.status.blockers.shift();
  fixture.status.evidenceRegistry = fixture.status.evidenceRegistry.filter(({subjectId}) => subjectId !== removed.id);
  const result = evaluateReleaseReadiness(
    fixture.status,
    fixture.policy,
    fixture.runtime,
    fixture.requirementsTrace,
  );
  assert.equal(result.decision, 'NO_GO');
  assert.ok(result.failures.some((failure) => failure.includes(`missing canonical ${removed.id}`)));
});

test('release evaluator rejects a canonical blocker severity downgrade', async () => {
  const fixture = await validReleaseFixture();
  fixture.status.blockers[0].severity = 'P3';
  const result = evaluateReleaseReadiness(
    fixture.status,
    fixture.policy,
    fixture.runtime,
    fixture.requirementsTrace,
  );
  assert.equal(result.decision, 'NO_GO');
  assert.ok(result.failures.some((failure) => failure.includes('canonical blocker cannot be downgraded or renamed')));
});

test('release evaluator rejects P1/P2 ACCEPTED even with structured evidence', async () => {
  const fixture = await validReleaseFixture();
  const blocker = fixture.status.blockers[0];
  blocker.status = 'ACCEPTED';
  const evidence = fixture.status.evidenceRegistry.find(({id}) => id === blocker.evidenceIds[0]);
  evidence.result = 'ACCEPTED';
  const result = evaluateReleaseReadiness(
    fixture.status,
    fixture.policy,
    fixture.runtime,
    fixture.requirementsTrace,
  );
  assert.equal(result.decision, 'NO_GO');
  assert.ok(result.failures.some((failure) => failure.includes('ACCEPTED is never sufficient')));
});

test('release evaluator rejects ci=true without canonical GitHub Actions evidence', async () => {
  const fixture = await validReleaseFixture();
  const ciEvidence = fixture.status.evidenceRegistry[0];
  Object.assign(ciEvidence, {
    ci: true,
    sourceType: 'repository-file',
    sourceRef: 'docs/evidence/records/release-review.json',
    sourceDigest: 'd'.repeat(64),
  });
  const result = evaluateReleaseReadiness(
    fixture.status,
    fixture.policy,
    fixture.runtime,
    fixture.requirementsTrace,
  );
  assert.equal(result.decision, 'NO_GO');
  assert.ok(result.failures.some((failure) => failure.includes('canonical successful GitHub Actions verify evidence is required')));
});

test('release evaluator rejects future and stale evidence timestamps', async () => {
  const future = await validReleaseFixture();
  future.status.evidenceRegistry[0].executedAt = '2026-08-28T12:00:01Z';
  const futureResult = evaluateReleaseReadiness(
    future.status,
    future.policy,
    future.runtime,
    future.requirementsTrace,
  );
  assert.ok(futureResult.failures.some((failure) => failure.includes('cannot be in the future')));

  const stale = await validReleaseFixture();
  stale.status.evidenceRegistry[0].executedAt = '2026-08-20T00:00:00Z';
  const staleResult = evaluateReleaseReadiness(
    stale.status,
    stale.policy,
    stale.runtime,
    stale.requirementsTrace,
  );
  assert.ok(staleResult.failures.some((failure) => failure.includes('evidence is stale')));
});

test('production release gate truthfully remains NO_GO', () => {
  const result = run('check-release-readiness.mjs');
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /RELEASE_GATE NO_GO/u);
  assert.doesNotMatch(result.stdout, /RELEASE_GATE GO/u);
});

test('CI=true cannot bypass the production release gate', () => {
  const result = run('check-release-readiness.mjs', {CI: 'true'});
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /RELEASE_GATE NO_GO/u);
});

test('ordinary CI does not silently invoke or bypass the production release gate', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const gate = await readFile(path.join(root, 'scripts/check-release-readiness.mjs'), 'utf8');
  const policy = JSON.parse(await readFile(path.join(root, 'config/harness-policy.json'), 'utf8'));
  assert.doesNotMatch(workflow, /release:gate/u);
  assert.doesNotMatch(gate, /RELEASE_GATE_SKIPPED/u);
  assert.deepEqual(policy.releaseGate.canonicalCiCheck, {
    repository: 'yukinohana42/minhos-member-system',
    workflow: '.github/workflows/ci.yml',
    job: 'verify',
    check: 'verify',
  });
});
