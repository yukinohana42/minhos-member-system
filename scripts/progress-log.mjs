import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function insertProgressRow(document, row) {
  const marker = '\n## 記録ルール';
  const markerIndex = document.indexOf(marker);
  if (markerIndex < 0) throw new Error('PROGRESS_TABLE_MARKER_MISSING');
  const table = document.slice(0, markerIndex);
  if (!table.includes('| 日時 | status | note | evidence | next |')) {
    throw new Error('PROGRESS_TABLE_HEADER_MISSING');
  }
  return `${table.trimEnd()}\n${row.trimEnd()}\n${document.slice(markerIndex)}`;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback = '') => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] ?? fallback : fallback;
  };

  const status = option('status');
  const note = option('note');
  const next = option('next');
  const evidence = option('evidence', 'npm run check');
  if (!status || !note || !next) {
    console.error('Usage: npm run progress -- --status "..." --note "..." --next "..." [--evidence "..."]');
    process.exitCode = 1;
    return;
  }

  const file = path.join(process.cwd(), 'docs/engineering/progress-log.md');
  await mkdir(path.dirname(file), { recursive: true });
  const current = await readFile(file, 'utf8');
  const now = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
  const line = `| ${now} | ${status.replaceAll('|', '\\|')} | ${note.replaceAll('|', '\\|')} | ${evidence.replaceAll('|', '\\|')} | ${next.replaceAll('|', '\\|')} |`;
  await writeFile(file, insertProgressRow(current, line), 'utf8');
  console.log(`PROGRESS_APPENDED ${file}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
