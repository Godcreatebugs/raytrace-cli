import test from 'node:test';
import assert from 'node:assert/strict';
import { hasSession, hasToken, sessionCookie, sessionFor, trustedRequest } from './request-policy.mjs';

const request = (url, headers) => ({method: 'POST', url, headers: {host: '127.0.0.1:8797', ...headers}});
test('simple browser POSTs from untrusted origins are refused on provider and dashboard routes', () => {
  for (const url of ['/v1/responses', '/v1/chat/completions', '/v1/messages', '/raytace/experiments']) {
    assert.equal(trustedRequest(request(url, {origin: 'http://untrusted.invalid', 'content-type': 'text/plain'})), false);
    assert.equal(trustedRequest(request(url, {origin: 'null'})), false);
  }
});
test('provider requests reject non-loopback Host values, including rebinding names', () => {
  for (const host of ['untrusted.invalid:8797', 'localhost.untrusted.invalid:8797', '192.0.2.1:8797', '']) {
    assert.equal(trustedRequest(request('/v1/responses', {host})), false);
  }
});
test('native clients and local dashboards retain access', () => {
  for (const host of ['127.0.0.1:8797', 'localhost:8797', '[::1]:8797']) {
    assert.equal(trustedRequest(request('/v1/responses', {host})), true);
    assert.equal(trustedRequest(request('/raytace/traces', {host, origin: 'http://localhost:3000'})), true);
  }
});
test('explicit UI origin permissions do not permit a non-loopback Host', () => {
  const origins = new Set(['https://dashboard.example']);
  assert.equal(trustedRequest(request('/v1/responses', {origin: 'https://dashboard.example'}), origins), true);
  assert.equal(trustedRequest(request('/v1/responses', {host: 'untrusted.invalid', origin: 'https://dashboard.example'}), origins), false);
});
test('only the token file\'s value authorizes a client, whatever Origin and Host it sends', () => {
  const headers = (authorization) => ({headers: {authorization}});
  assert.equal(hasToken(headers('Bearer right'), 'right'), true);
  for (const value of ['Bearer wrong', 'Bearer ', 'right', undefined]) assert.equal(hasToken(headers(value), 'right'), false);
});
test('the dashboard cookie counts only from the dashboard\'s own origin', () => {
  const cookie = `other=1; ${sessionCookie(8797)}=${sessionFor('right')}`;
  const seen = (headers) => hasSession({headers: {host: '127.0.0.1:8797', ...headers}}, 'right', 8797);
  assert.equal(seen({cookie}), true);
  assert.equal(seen({cookie, origin: 'http://127.0.0.1:8797'}), true);
  assert.equal(seen({cookie, origin: 'http://127.0.0.1:3000'}), false);
  assert.equal(seen({cookie: `${sessionCookie(8797)}=right`}), false);
  assert.equal(seen({}), false);
  assert.equal(hasSession({headers: {host: '127.0.0.1:18797', cookie}}, 'right', 18797), false);
});
