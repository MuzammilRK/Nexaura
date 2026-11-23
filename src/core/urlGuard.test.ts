import test from 'node:test';
import assert from 'node:assert/strict';
import { isRestrictedIpAddress, validatePublicHttpUrl, validateUrlSyntax } from './urlGuard';

test('URL guard blocks non-HTTP protocols and restricted loopback/metadata hosts', () => {
  assert.equal(validateUrlSyntax('javascript:alert(1)').ok, false);
  assert.equal(validateUrlSyntax('file:///etc/passwd').ok, false);
  assert.equal(validateUrlSyntax('http://localhost:3000/api/health').ok, false);
  assert.equal(validateUrlSyntax('http://127.0.0.1:3001/').ok, false);
  assert.equal(validateUrlSyntax('http://169.254.169.254/latest/meta-data/').ok, false);
  assert.equal(validateUrlSyntax('http://10.0.0.5/admin').ok, false);
  assert.equal(validateUrlSyntax('http://192.168.1.1/').ok, false);
  assert.equal(validateUrlSyntax('http://[::1]:3000/').ok, false);

  const valid = validateUrlSyntax('https://example.com/status');
  assert.equal(valid.ok, true);
});

test('IP restriction check catches RFC1918, loopback, link-local, and IPv4-mapped IPv6', () => {
  assert.equal(isRestrictedIpAddress('127.0.0.1'), true);
  assert.equal(isRestrictedIpAddress('::ffff:127.0.0.1'), true);
  assert.equal(isRestrictedIpAddress('172.18.0.4'), true);
  assert.equal(isRestrictedIpAddress('169.254.169.254'), true);
  assert.equal(isRestrictedIpAddress('fe80::1'), true);
  assert.equal(isRestrictedIpAddress('93.184.216.34'), false);
  assert.equal(isRestrictedIpAddress('1.1.1.1'), false);
});

test('DNS lookup SSRF validation blocks hostnames resolving to private IPs', async () => {
  const blockedLookup = async () => [{ address: '127.0.0.1', family: 4 }];
  const resBlocked = await validatePublicHttpUrl(
    'https://spoofed-internal.example.com/',
    blockedLookup as unknown as typeof import('node:dns/promises').lookup
  );
  assert.equal(resBlocked.ok, false);

  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const resPublic = await validatePublicHttpUrl(
    'https://example.com/',
    publicLookup as unknown as typeof import('node:dns/promises').lookup
  );
  assert.equal(resPublic.ok, true);
});
