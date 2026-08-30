import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const policyPath = path.join(root, 'config/dependency-audit-policy.json');
const packageDirs = ['packages/ghost-theme', 'packages/apps-script'];
const failures = [];
const observedExceptions = new Map();

if (!existsSync(policyPath)) {
  console.error('AUDIT_PACKAGES_FAILED: config/dependency-audit-policy.json is missing');
  process.exit(1);
}

const policy = JSON.parse(await readFile(policyPath, 'utf8'));
const exceptions = Array.isArray(policy.exceptions) ? policy.exceptions : [];
const severityRank = new Map([['info', 0], ['low', 1], ['moderate', 2], ['high', 3], ['critical', 4]]);
const threshold = severityRank.get(policy.severityThreshold);
if (threshold === undefined) failures.push(`unsupported severity threshold: ${policy.severityThreshold}`);

function advisoryRecord(via) {
  const id = typeof via?.url === 'string'
    ? via.url.match(/GHSA-[a-z0-9-]+/iu)?.[0] ?? String(via.source ?? '')
    : String(via?.source ?? '');
  return {id, source: Number(via?.source)};
}

function leafAdvisories(name, vulnerabilities, visited = new Set()) {
  if (visited.has(name)) return [];
  visited.add(name);
  const vulnerability = vulnerabilities[name];
  if (!vulnerability || !Array.isArray(vulnerability.via)) return [];
  const leaves = [];
  for (const via of vulnerability.via) {
    if (typeof via === 'string') leaves.push(...leafAdvisories(via, vulnerabilities, visited));
    else leaves.push(advisoryRecord(via));
  }
  return [...new Map(leaves.filter((entry) => entry.id).map((entry) => [`${entry.id}:${entry.source}`, entry])).values()];
}

function matchingException(relativeDir, vulnerabilityName, advisory) {
  return exceptions.find((entry) => {
    if (entry.packageDirectory !== relativeDir || entry.advisory !== advisory.id || Number(entry.source) !== advisory.source) return false;
    if (!Array.isArray(entry.vulnerabilityNames) || !entry.vulnerabilityNames.includes(vulnerabilityName)) return false;
    if (!Array.isArray(entry.mitigations) || entry.mitigations.length === 0) return false;
    if (entry.scope !== 'development-only') return false;
    const reviewBy = Date.parse(`${entry.reviewBy}T23:59:59Z`);
    return Number.isFinite(reviewBy) && reviewBy >= Date.now();
  });
}

function lockNodePathsForName(lockfile, packageName) {
  const suffix = `node_modules/${packageName}`;
  return Object.keys(lockfile.packages ?? {}).filter((nodePath) => nodePath === suffix || nodePath.endsWith(`/${suffix}`));
}

function validateExceptionDependencyPath(entry, relativeDir, packageJson, lockfile) {
  const steps = entry.dependencyPath;
  if (!Array.isArray(steps) || steps.length < 2) {
    failures.push(`${relativeDir}:${entry.advisory}: dependencyPath must contain at least two exact steps`);
    return;
  }

  const rootStep = steps[0];
  if (packageJson.dependencies?.[rootStep.name]) {
    failures.push(`${relativeDir}:${entry.advisory}: dependencyPath root ${rootStep.name} is a production dependency`);
  }
  if (packageJson.devDependencies?.[rootStep.name] !== rootStep.version) {
    failures.push(`${relativeDir}:${entry.advisory}: dependencyPath root ${rootStep.name}@${rootStep.version} is not an exact direct devDependency`);
  }
  if (lockfile.packages?.['']?.devDependencies?.[rootStep.name] !== rootStep.version) {
    failures.push(`${relativeDir}:${entry.advisory}: lockfile root does not pin ${rootStep.name}@${rootStep.version} as a devDependency`);
  }

  for (const step of steps) {
    const canonicalNodePath = `node_modules/${step.name}`;
    const canonicalNode = lockfile.packages?.[canonicalNodePath];
    if (!canonicalNode) {
      failures.push(`${relativeDir}:${entry.advisory}: lockfile is missing canonical ${canonicalNodePath}`);
      continue;
    }
    if (canonicalNode.version !== step.version) {
      failures.push(`${relativeDir}:${entry.advisory}: ${canonicalNodePath} is ${canonicalNode.version}, expected ${step.version}`);
    }
    const installedPaths = lockNodePathsForName(lockfile, step.name);
    if (installedPaths.length === 0) failures.push(`${relativeDir}:${entry.advisory}: no installed lockfile node for ${step.name}`);
    for (const installedPath of installedPaths) {
      if (lockfile.packages[installedPath]?.dev !== true) {
        failures.push(`${relativeDir}:${entry.advisory}: ${installedPath} is not marked dev-only`);
      }
    }
  }

  for (let index = 0; index < steps.length - 1; index += 1) {
    const parent = steps[index];
    const child = steps[index + 1];
    const declaredVersion = lockfile.packages?.[`node_modules/${parent.name}`]?.dependencies?.[child.name];
    if (declaredVersion !== child.version) {
      failures.push(`${relativeDir}:${entry.advisory}: ${parent.name} must depend exactly on ${child.name}@${child.version} (found ${declaredVersion ?? 'missing'})`);
    }
  }
}

function observedScopeIsApproved(entry, relativeDir, vulnerabilityName, vulnerability, lockfile) {
  const nodes = vulnerability.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    failures.push(`${relativeDir}:${entry.advisory}: ${vulnerabilityName} audit record has no installed node path`);
    return false;
  }
  const allowedNames = new Set(entry.dependencyPath.map((step) => step.name));
  let approved = true;
  for (const rawNodePath of nodes) {
    const nodePath = String(rawNodePath).replaceAll('\\', '/');
    const lockNode = lockfile.packages?.[nodePath];
    if (!lockNode) {
      failures.push(`${relativeDir}:${entry.advisory}: audit node ${nodePath} is missing from package-lock.json`);
      approved = false;
      continue;
    }
    if (lockNode.dev !== true) {
      failures.push(`${relativeDir}:${entry.advisory}: audit node ${nodePath} is not development-only`);
      approved = false;
    }
    const matchesAllowedName = [...allowedNames].some((name) => nodePath === `node_modules/${name}` || nodePath.endsWith(`/node_modules/${name}`));
    if (!matchesAllowedName) {
      failures.push(`${relativeDir}:${entry.advisory}: audit node ${nodePath} is outside the approved dependencyPath`);
      approved = false;
    }
  }
  return approved;
}

for (const relativeDir of packageDirs) {
  const directory = path.join(root, relativeDir);
  const packageJsonPath = path.join(directory, 'package.json');
  const packageLockPath = path.join(directory, 'package-lock.json');
  if (!existsSync(packageLockPath)) {
    failures.push(`${relativeDir}: package-lock.json is missing`);
    continue;
  }
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const lockfile = JSON.parse(await readFile(packageLockPath, 'utf8'));
  for (const [name, version] of Object.entries({...packageJson.dependencies, ...packageJson.devDependencies})) {
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
      failures.push(`${relativeDir}: dependency ${name} must use an exact version (found ${version})`);
    }
  }
  for (const entry of exceptions.filter((candidate) => candidate.packageDirectory === relativeDir)) {
    const directProductionMatches = entry.vulnerabilityNames.filter((name) => packageJson.dependencies?.[name]);
    const directDevelopmentMatches = entry.vulnerabilityNames.filter((name) => packageJson.devDependencies?.[name]);
    if (directProductionMatches.length > 0) failures.push(`${relativeDir}:${entry.advisory}: exception reaches a production dependency (${directProductionMatches.join(', ')})`);
    if (directDevelopmentMatches.length === 0) failures.push(`${relativeDir}:${entry.advisory}: exception is not rooted in an explicit development dependency`);
    validateExceptionDependencyPath(entry, relativeDir, packageJson, lockfile);
  }

  console.log(`AUDIT_PACKAGE ${relativeDir} threshold=${policy.severityThreshold}`);
  const result = spawnSync(
    npmCommand,
    ['audit', '--json', '--no-fund'],
    {cwd: directory, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32'},
  );
  if (result.error) {
    failures.push(`${relativeDir}: audit could not start (${result.error.message})`);
    continue;
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    failures.push(`${relativeDir}: audit response was not valid JSON (${error.message}); ${result.stderr.trim()}`);
    continue;
  }

  const vulnerabilities = report.vulnerabilities ?? {};
  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    if ((severityRank.get(vulnerability.severity) ?? -1) < threshold) continue;
    const advisories = leafAdvisories(name, vulnerabilities);
    if (advisories.length === 0) {
      failures.push(`${relativeDir}: ${name} ${vulnerability.severity} has no resolvable advisory ID`);
      continue;
    }
    const approvals = advisories.map((advisory) => matchingException(relativeDir, name, advisory));
    if (approvals.some((approval) => !approval)) {
      failures.push(`${relativeDir}: unapproved ${vulnerability.severity} vulnerability ${name} via ${advisories.map((entry) => entry.id).join(', ')}`);
      continue;
    }
    for (const approval of approvals) {
      if (!observedScopeIsApproved(approval, relativeDir, name, vulnerability, lockfile)) continue;
      const key = `${approval.packageDirectory}:${approval.advisory}`;
      const observedNames = observedExceptions.get(key) ?? new Set();
      observedNames.add(name);
      observedExceptions.set(key, observedNames);
      console.log(`AUDIT_EXCEPTION ${name} ${approval.advisory} reviewBy=${approval.reviewBy} scope=${approval.scope}`);
    }
  }

  if (result.status !== 0 && Object.keys(vulnerabilities).length === 0) {
    failures.push(`${relativeDir}: npm audit failed without a vulnerability report (${result.status}); ${result.stderr.trim()}`);
  }
}

for (const entry of exceptions) {
  const key = `${entry.packageDirectory}:${entry.advisory}`;
  const observedNames = observedExceptions.get(key);
  if (!observedNames) {
    failures.push(`${key}: stale or unobserved audit exception; remove or re-review it`);
    continue;
  }
  const expectedNames = new Set(entry.vulnerabilityNames);
  for (const name of expectedNames) if (!observedNames.has(name)) failures.push(`${key}: allowlisted vulnerability name ${name} was not observed`);
  for (const name of observedNames) if (!expectedNames.has(name)) failures.push(`${key}: observed vulnerability name ${name} is not allowlisted`);
}

if (failures.length > 0) {
  console.error(`AUDIT_PACKAGES_FAILED (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`AUDIT_PACKAGES_OK no unapproved high/critical findings; approvedExceptions=${observedExceptions.size}`);
}
