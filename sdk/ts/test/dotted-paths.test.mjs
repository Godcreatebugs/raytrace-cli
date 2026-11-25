import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { buildTarGz } from '../src/index.mjs';

test('archive paths may contain consecutive dots inside a filename', () => {
  for (const path of ['report..txt', 'src.../index.js', '.../data.txt', 'release..old/config.json']) {
    const tar = gunzipSync(buildTarGz({ [path]: 'contents' }));
    assert.equal(tar.subarray(0, 100).toString('utf8').split('\0')[0], path);
    assert.equal(tar.subarray(512, 520).toString('utf8'), 'contents');
  }
});

test('parent-directory path components are still rejected', () => {
  for (const path of ['..', '../data.txt', 'src/../data.txt', 'src/..', '../../data.txt', '..\\data.txt', 'src\\..\\data.txt', 'src\\..']) {
    assert.throws(() => buildTarGz({ [path]: 'contents' }), /Invalid archive file path/);
  }
});
