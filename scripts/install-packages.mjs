import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = process.cwd();
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packageDirs = ['packages/ghost-theme', 'packages/apps-script'];
const failures = [];

for (const relativeDir of packageDirs) {
  const directory = path.join(root, relativeDir);
  if (!existsSync(path.join(directory, 'package.json'))) {
    failures.push(`${relativeDir}: package.json is missing`);
    continue;
  }
  if (!existsSync(path.join(directory, 'package-lock.json'))) {
    failures.push(`${relativeDir}: package-lock.json is missing; generate it in the package directory`);
    continue;
  }
  const lockPath = path.join(directory, 'package-lock.json');
  const lockHashBefore = hashFile(lockPath);
  console.log(`INSTALL_PACKAGE ${relativeDir}`);
  const npmOptions = {
    cwd: directory,
    stdio: 'inherit',
    windowsHide: true,
    shell: process.platform === 'win32'
  };
  let result = spawnSync(npmCommand, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], npmOptions);
  if (result.status !== 0 && process.platform === 'win32') {
    // Dropbox and other file watchers can keep an existing node_modules file
    // open, making npm ci's cleanup fail with EBUSY. npm install is a safer
    // recoverable fallback because it does not require removing the tree.
    console.warn(`INSTALL_FALLBACK ${relativeDir} npm ci failed; retrying npm install without cleanup`);
    result = spawnSync(npmCommand, ['install', '--ignore-scripts', '--no-audit', '--no-fund'], npmOptions);
    if (hashFile(lockPath) !== lockHashBefore) {
      failures.push(`${relativeDir}: fallback changed package-lock.json; restore/review the lockfile before continuing`);
      continue;
    }
    const treeCheck = spawnSync(npmCommand, ['ls', '--all'], npmOptions);
    if (treeCheck.status !== 0) {
      failures.push(`${relativeDir}: fallback dependency tree does not match the locked manifest`);
      continue;
    }
  }
  if (result.status !== 0) failures.push(`${relativeDir}: package install failed (${result.status ?? result.error?.message ?? 'unknown'})`);
}

function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

if (failures.length > 0) {
  console.error(`INSTALL_PACKAGES_FAILED (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('INSTALL_PACKAGES_OK');
}
