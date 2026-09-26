// Node unit tests for the data engine (no browser needed): `node --test tests/`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { BASE_ROWS, toCSV } from './fixtures.mjs';

const require = createRequire(import.meta.url);
const Z = require('../data-worker.js');

test('normalizeZip keeps ZIPs as 5-digit strings with leading zeros', () => {
  assert.equal(Z.normalizeZip('00501'), '00501');
  assert.equal(Z.normalizeZip('501'), '00501');
  assert.equal(Z.normalizeZip(501), '00501');
  assert.equal(Z.normalizeZip('6082'), '06082');
  assert.equal(Z.normalizeZip('02108'), '02108');
  assert.equal(Z.normalizeZip(' 10001 '), '10001');
  assert.equal(Z.normalizeZip('90210'), '90210');
  assert.equal(Z.normalizeZip('06082-1234'), '06082');
  assert.equal(Z.normalizeZip('6082-1234'), '06082');
  assert.equal(Z.normalizeZip('6082.0'), '06082');
  assert.equal(Z.normalizeZip('CT 6082'), '06082');
  assert.equal(Z.normalizeZip(''), '');
  assert.equal(Z.normalizeZip(null), '');
  assert.equal(Z.normalizeZip(undefined), '');
  assert.equal(Z.normalizeZip('abc'), '');
  assert.equal(Z.normalizeZip('0'), '');
});

test('rowsFromObjects normalizes, skips malformed rows, tolerates missing columns', () => {
  const { rows, skipped } = Z.rowsFromObjects(BASE_ROWS);
  assert.equal(skipped, 3);
  const zips = rows.map((r) => r[0]);
  assert.ok(zips.includes('06082'));
  assert.ok(zips.includes('00501'));
  assert.ok(zips.includes('02108'), 'ZipState fallback');
  const oh = rows.find((r) => r[0] === '44680');
  assert.deepEqual(oh, ['44680', 'OH', 'Bath Expert', '', '']);
});

test('header matching is case/space-insensitive but does not invent fields', () => {
  const { rows } = Z.rowsFromObjects([{ ' zip ': '63010', STATE: 'MO', 'Good  to Go on Client': 'AMO', Extra: 'x' }]);
  assert.deepEqual(rows[0], ['63010', 'MO', 'AMO', '', '']);
});

test('buildIndex gives O(1) lookups and collapses exact duplicates', () => {
  const { rows } = Z.rowsFromObjects(BASE_ROWS);
  const idx = Z.buildIndex(rows);
  assert.ok(idx instanceof Map);
  assert.equal(idx.get('91115').length, 3);
  assert.equal(idx.get('63010')[0].client, 'AMO');
  assert.equal(idx.get('99999'), undefined);
  assert.equal(idx.get('06082')[0].state, 'CT');
});

test('CSV fallback parses quoted fields and yields identical rows', () => {
  const fromCsv = Z.rowsFromCSV(toCSV(BASE_ROWS.filter((r) => r.Zip || r.ZipState)));
  const fromJson = Z.rowsFromObjects(BASE_ROWS);
  assert.deepEqual(fromCsv.rows, fromJson.rows);
  const t = Z.parseCSV('a,"b ""q"", c",d\r\n1,"multi\nline",3');
  assert.deepEqual(t, [['a', 'b "q", c', 'd'], ['1', 'multi\nline', '3']]);
});

test('hashRows changes when data changes', () => {
  const a = Z.rowsFromObjects(BASE_ROWS).rows;
  const b = Z.rowsFromObjects([...BASE_ROWS, { Zip: '12345', State: 'NY', 'Good to Go on Client': 'New' }]).rows;
  assert.equal(Z.hashRows(a), Z.hashRows(Z.rowsFromObjects(BASE_ROWS).rows));
  assert.notEqual(Z.hashRows(a), Z.hashRows(b));
});
