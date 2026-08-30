import { spawnSync } from 'node:child_process';

const root = process.cwd();

const commands = [
  ['config', 'scripts/check-config.mjs'],
  ['requirements', 'scripts/check-requirements.mjs'],
  ['secrets', 'scripts/check-secrets.mjs']
];
const failures = [];
for (const [name, script] of commands) {
  console.log(`VERIFY ${name}`);
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) failures.push(name);
}

if (failures.length > 0) {
  console.error(`VERIFY_FAILED checks=${failures.join(',')}`);
  process.exitCode = 1;
} else {
  console.log('VERIFY_OK network=false livePayments=false');
}
