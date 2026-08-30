import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const mode = process.argv.includes('--tests-only') ? 'tests' : process.argv.includes('--build-only') ? 'build' : process.argv.includes('--gscan-only') ? 'gscan' : 'all';
const packages = [
  {
    name: 'ghost-theme',
    directory: 'packages/ghost-theme',
    requiredScripts: ['check', 'test', 'build', 'gscan']
  },
  {
    name: 'apps-script',
    directory: 'packages/apps-script',
    requiredScripts: ['check', 'test', 'build']
  }
];
const failures = [];

function desiredScripts(packageInfo) {
  if (mode === 'tests') return ['test'];
  if (mode === 'build') return ['check', 'build'];
  if (mode === 'gscan') return packageInfo.name === 'ghost-theme' ? ['gscan'] : [];
  return ['check', 'test', 'build'];
}

function commandFor(scriptName) {
  // `npm run` is used for project scripts; npm's `test` shorthand is avoided
  // so that the same invocation works consistently on Windows and CI.
  return ['run', scriptName];
}

for (const packageInfo of packages) {
  const directory = path.join(root, packageInfo.directory);
  const packageJsonPath = path.join(directory, 'package.json');
  if (!existsSync(packageJsonPath)) {
    failures.push(`${packageInfo.name}: package.json is missing`);
    continue;
  }
  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  } catch (error) {
    failures.push(`${packageInfo.name}: package.json is invalid (${error.message})`);
    continue;
  }
  const availableScripts = packageJson.scripts ?? {};
  for (const scriptName of packageInfo.requiredScripts) {
    if (typeof availableScripts[scriptName] !== 'string') failures.push(`${packageInfo.name}: required npm script '${scriptName}' is missing`);
  }
  const executedScriptBodies = new Set();
  for (const scriptName of desiredScripts(packageInfo)) {
    if (typeof availableScripts[scriptName] !== 'string') {
      console.log(`PACKAGE_SKIP ${packageInfo.name} ${scriptName} (script missing)`);
      continue;
    }
    if (executedScriptBodies.has(availableScripts[scriptName])) {
      console.log(`PACKAGE_SKIP ${packageInfo.name} ${scriptName} (duplicate command)`);
      continue;
    }
    executedScriptBodies.add(availableScripts[scriptName]);
    console.log(`PACKAGE_RUN ${packageInfo.name} ${scriptName}`);
    const result = spawnSync(npmCommand, commandFor(scriptName), { cwd: directory, stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32' });
    if (result.status !== 0) failures.push(`${packageInfo.name}/${scriptName}: failed (${result.status ?? result.error?.message ?? 'unknown'}); run npm run install:packages first`);
  }
}

if (failures.length > 0) {
  console.error(`PACKAGES_CHECK_FAILED (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`PACKAGES_OK mode=${mode}`);
}
