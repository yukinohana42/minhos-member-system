import assert from 'node:assert/strict';
import {test} from 'node:test';
import {insertProgressRow} from './progress-log.mjs';

test('progress rows stay inside the canonical table before the instructions', () => {
  const document = [
    '# Progress log',
    '',
    '| 日時 | status | note | evidence | next |',
    '|---|---|---|---|---|',
    '| old | prepared | note | evidence | next |',
    '',
    '## 記録ルール',
    '',
    'instructions',
    '',
  ].join('\n');
  const row = '| now | verified | note | evidence | next |';
  const updated = insertProgressRow(document, row);
  assert.ok(updated.indexOf(row) > updated.indexOf('| old |'));
  assert.ok(updated.indexOf(row) < updated.indexOf('## 記録ルール'));
  assert.equal(updated.match(/\| now \|/g)?.length, 1);
});

test('progress insertion fails closed when the canonical table is missing', () => {
  assert.throws(() => insertProgressRow('# Progress log\n\n## 記録ルール\n', '| row |'), /PROGRESS_TABLE_HEADER_MISSING/);
  assert.throws(() => insertProgressRow('# Progress log\n', '| row |'), /PROGRESS_TABLE_MARKER_MISSING/);
});
