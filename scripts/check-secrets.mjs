import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = process.cwd();
const ignoredDirectories = new Set(['.git', 'node_modules', 'coverage', 'dist', 'build', '.cache']);
const ignoredExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.zip', '.mp4', '.mov', '.ico', '.woff', '.woff2']);
const placeholderPattern = /(?:^|[<\[({])(?:REPLACE_ME|CHANGE_ME|EXAMPLE|YOUR_[A-Z0-9_]+|INSERT_[A-Z0-9_]+|REDACTED|NOT_SET|TODO)(?:$|[>\])}])/u;
const environmentReferencePattern = /^(?:\$\{[A-Z_][A-Z0-9_]*\}|\$\{\{\s*(?:secrets|env|vars)\.[A-Z_][A-Z0-9_]*\s*\}\})$/iu;
const quotedAssignmentPatterns = [
  /(?:^|[^A-Za-z0-9_])["']?([A-Za-z][A-Za-z0-9_:-]{1,127})["']?\s*[=:]\s*"([^"\r\n]*)"/gmu,
  /(?:^|[^A-Za-z0-9_])["']?([A-Za-z][A-Za-z0-9_:-]{1,127})["']?\s*[=:]\s*'([^'\r\n]*)'/gmu,
  /(?:^|[^A-Za-z0-9_])["']?([A-Za-z][A-Za-z0-9_:-]{1,127})["']?\s*[=:]\s*`([^`\r\n]*)`/gmu,
];
const unquotedAssignmentPattern = /^\s*(?:export\s+)?([A-Za-z][A-Za-z0-9_:-]{1,127})\s*[=:]\s*(.*?)\s*$/u;
const secretAssignmentNamePattern = /(?:api[_-]?key|secret|token|password|private[_-]?key|client[_-]?secret)/iu;
const knownSecretPatterns = [
  { label: 'private-key-block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u },
  { label: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u },
  { label: 'github-fine-grained-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u },
  { label: 'ghost-admin-api-key', pattern: /(?<![0-9A-Fa-f])[0-9A-Fa-f]{24}:[0-9A-Fa-f]{64}(?![0-9A-Fa-f])/u },
  { label: 'google-oauth-client-secret', pattern: /(?<![A-Za-z0-9_-])GOCSPX-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/u },
  { label: 'google-oauth-refresh-token', pattern: /(?<![A-Za-z0-9_-])1\/\/[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/u },
  { label: 'stripe-secret', pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/u },
  { label: 'stripe-restricted', pattern: /\brk_(?:live|test)_[A-Za-z0-9]{16,}\b/u },
  { label: 'google-key', pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/u },
  { label: 'oauth-bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}\b/iu },
  { label: 'generic-long-token', pattern: /\b(?:token|secret|password)[_-][A-Za-z0-9]{24,}\b/iu },
];

function relative(file) {
  return path.relative(root, file).replaceAll('\\', '/');
}

function supportsUnquotedAssignments(file) {
  const normalized = file.replaceAll('\\', '/');
  const basename = path.posix.basename(normalized);
  return basename === '.env'
    || basename.startsWith('.env.')
    || basename.endsWith('.env')
    || /\.ya?ml$/iu.test(basename);
}

export function inspectContentForSecrets(file, content) {
  const findings = [];
  const recordAssignment = (assignmentName, rawValue, line) => {
    const value = rawValue.trim();
    if (assignmentName.includes(':')) return;
    if (!secretAssignmentNamePattern.test(assignmentName)) return;
    if (/non[_-]?secret/iu.test(assignmentName)) return;
    if (!placeholderPattern.test(value)
      && !environmentReferencePattern.test(value)
      && value.length >= 8) {
      findings.push(`${file}:${line}: secret-like assignment (${assignmentName})`);
    }
  };

  for (const assignmentPattern of quotedAssignmentPatterns) {
    for (const match of content.matchAll(assignmentPattern)) {
      const line = content.slice(0, match.index).split(/\r?\n/u).length;
      recordAssignment(match[1], match[2], line);
    }
  }
  if (supportsUnquotedAssignments(file)) {
    for (const [index, sourceLine] of content.split(/\r?\n/u).entries()) {
      const match = unquotedAssignmentPattern.exec(sourceLine);
      if (!match) continue;
      let value = match[2].replace(/\s+#.*$/u, '').trim();
      if (/^["'`]/u.test(value)) continue;
      if (value.endsWith(',')) value = value.slice(0, -1).trim();
      recordAssignment(match[1], value, index + 1);
    }
  }
  for (const { label, pattern } of knownSecretPatterns) {
    const match = pattern.exec(content);
    if (match) {
      const line = content.slice(0, match.index).split(/\r?\n/u).length;
      findings.push(`${file}:${line}: ${label}`);
    }
  }
  return [...new Set(findings)];
}

async function walk(directory, findings) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    findings.push(`${relative(directory)}: cannot read (${error.message})`);
    return;
  }
  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(absolute, findings);
      continue;
    }
    if (!entry.isFile() || ignoredExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    let content;
    try {
      content = await readFile(absolute, 'utf8');
    } catch {
      continue;
    }
    findings.push(...inspectContentForSecrets(relative(absolute), content));
  }
}

async function runCli() {
  if (!existsSync(root)) {
    console.error('SECRETS_CHECK_FAILED: workspace does not exist');
    process.exitCode = 1;
    return;
  }
  const findings = [];
  await walk(root, findings);
  const uniqueFindings = [...new Set(findings)];
  if (uniqueFindings.length > 0) {
    console.error(`SECRETS_CHECK_FAILED (${uniqueFindings.length})`);
    for (const finding of uniqueFindings) console.error(`- ${finding}`);
    process.exitCode = 1;
  } else {
    console.log('SECRETS_OK no secret-like values detected in repository files');
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) await runCli();
