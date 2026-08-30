import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = process.cwd();
const fullCommitShaPattern = /^[0-9a-f]{40}$/u;
const zeroCommitSha = '0'.repeat(40);
const githubUserNoreplyPattern = /^(?:[0-9]+\+)?[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?@users\.noreply\.github\.com$/u;

export function isApprovedGitIdentityEmail(email) {
  return email === 'noreply@github.com' || githubUserNoreplyPattern.test(email);
}

export function inspectCommitIdentityLog(logOutput) {
  if (typeof logOutput !== 'string') {
    return { commitCount: 0, findings: [{ sha: 'UNKNOWN', role: 'history-record' }] };
  }

  const lines = logOutput.split(/\r?\n/u).filter((line) => line.length > 0);
  const findings = [];
  for (const line of lines) {
    const fields = line.split('\t');
    const sha = fields.length === 3 && fullCommitShaPattern.test(fields[0])
      ? fields[0]
      : 'UNKNOWN';
    if (fields.length !== 3 || sha === 'UNKNOWN') {
      findings.push({ sha, role: 'history-record' });
      continue;
    }
    if (!isApprovedGitIdentityEmail(fields[1])) findings.push({ sha, role: 'author' });
    if (!isApprovedGitIdentityEmail(fields[2])) findings.push({ sha, role: 'committer' });
  }
  if (lines.length === 0) findings.push({ sha: 'UNKNOWN', role: 'history-empty' });

  return { commitCount: lines.length, findings };
}

export function inspectRepositoryDepth(depthOutput) {
  if (typeof depthOutput !== 'string') return { sha: 'UNKNOWN', role: 'history-depth' };
  const depth = depthOutput.trim();
  if (depth === 'false') return null;
  if (depth === 'true') return { sha: 'UNKNOWN', role: 'history-shallow' };
  return { sha: 'UNKNOWN', role: 'history-depth' };
}

export function parsePrePushInput(input) {
  if (typeof input !== 'string') {
    return { revisions: [], findings: [{ sha: 'UNKNOWN', role: 'pre-push-input' }] };
  }

  const revisions = [];
  const findings = [];
  for (const line of input.split(/\r?\n/u).filter((entry) => entry.length > 0)) {
    const fields = line.split(' ');
    if (
      fields.length !== 4
      || !fullCommitShaPattern.test(fields[1])
      || !fullCommitShaPattern.test(fields[3])
    ) {
      findings.push({ sha: 'UNKNOWN', role: 'pre-push-input' });
      continue;
    }
    if (fields[1] !== zeroCommitSha) revisions.push(fields[1]);
  }
  return { revisions: [...new Set(revisions)], findings };
}

function runGit(args) {
  return spawnSync(
    'git',
    args,
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  );
}

function readReachableCommitIdentities(revisions) {
  const depthResult = runGit(['rev-parse', '--is-shallow-repository']);
  if (depthResult.error || depthResult.status !== 0) {
    return { finding: { sha: 'UNKNOWN', role: 'history-depth' } };
  }
  const depthFinding = inspectRepositoryDepth(depthResult.stdout);
  if (depthFinding) return { finding: depthFinding };

  const logOutputs = [];
  for (const revision of revisions) {
    if (revision !== 'HEAD' && !fullCommitShaPattern.test(revision)) {
      return { finding: { sha: 'UNKNOWN', role: 'history-revision' } };
    }
    const logResult = runGit([
      'log',
      '--no-show-signature',
      '--format=%H%x09%ae%x09%ce',
      revision,
    ]);
    if (logResult.error || logResult.status !== 0 || typeof logResult.stdout !== 'string') {
      return { finding: { sha: 'UNKNOWN', role: 'history-read' } };
    }
    logOutputs.push(logResult.stdout);
  }
  return { logOutput: logOutputs.join('\n') };
}

function runCli() {
  let revisions = ['HEAD'];
  if (process.argv[2] === '--pre-push') {
    const parsed = parsePrePushInput(readFileSync(0, 'utf8'));
    if (parsed.findings.length > 0) {
      console.error(`COMMIT_IDENTITY_CHECK_FAILED count=${parsed.findings.length}`);
      for (const { sha, role } of parsed.findings) console.error(`- sha=${sha} role=${role}`);
      process.exitCode = 1;
      return;
    }
    revisions = parsed.revisions;
    if (revisions.length === 0) {
      console.log('COMMIT_IDENTITIES_OK commits=0 author_and_committer=noreply');
      return;
    }
  } else if (process.argv.length > 2) {
    console.error('COMMIT_IDENTITY_CHECK_FAILED count=1');
    console.error('- sha=UNKNOWN role=arguments');
    process.exitCode = 1;
    return;
  }

  const inspection = readReachableCommitIdentities(revisions);
  if (inspection.finding) {
    console.error('COMMIT_IDENTITY_CHECK_FAILED count=1');
    console.error(`- sha=${inspection.finding.sha} role=${inspection.finding.role}`);
    process.exitCode = 1;
    return;
  }

  const { commitCount, findings } = inspectCommitIdentityLog(inspection.logOutput);
  if (findings.length > 0) {
    console.error(`COMMIT_IDENTITY_CHECK_FAILED count=${findings.length}`);
    for (const { sha, role } of findings) console.error(`- sha=${sha} role=${role}`);
    process.exitCode = 1;
    return;
  }

  console.log(`COMMIT_IDENTITIES_OK commits=${commitCount} author_and_committer=noreply`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) runCli();
