import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceRouterTraffic,
  applyRouterFault,
  applyStorageFault,
  buildDefaultCountryAdmins,
  canAdminApproveOutsideCountry,
  resolveRouterFault,
  resolveStorageFault,
} from './infra';
import type { RouterTelemetry, StorageTelemetry } from '../shared/schema';

function makeRouter(): RouterTelemetry {
  return {
    routerId: 'rtr-in-blr-01',
    status: 'Nominal',
    dataTransferredMb: 120.5,
    packetCount: 10000,
    packetsSent: 9995,
    packetLossCount: 5,
    packetLossPct: 0.05,
    bandwidthMbps: 340,
    latencyMs: 19,
    activeError: null,
    errorDetail: null,
  };
}

function makeStorage(): StorageTelemetry {
  return {
    storageId: 'stg-in-blr-01',
    status: 'Nominal',
    usedPct: 48,
    capacityGb: 2048,
    iops: 3200,
    readMbps: 410,
    writeMbps: 210,
    raidState: 'Healthy (RAID-10)',
    smartStatus: 'PASS',
    activeError: null,
    errorDetail: null,
  };
}

test('Country Admin cross-country permission requires Super Admin grant and strict country scope', () => {
  const admins = buildDefaultCountryAdmins();
  const inAdmin = admins.find((a) => a.countryCode === 'IN')!;

  // Initially denied cross-country permission even within India
  const deniedInitial = canAdminApproveOutsideCountry('country_admin', inAdmin, 'IN');
  assert.equal(deniedInitial.allowed, false);

  // Denied for a different country even if permission were granted
  inAdmin.permissions.cross_country_transfer = true;
  const deniedWrongCountry = canAdminApproveOutsideCountry('country_admin', inAdmin, 'DE');
  assert.equal(deniedWrongCountry.allowed, false);

  // Allowed for own country once Super Admin grants permission
  const allowedOwnCountry = canAdminApproveOutsideCountry('country_admin', inAdmin, 'IN');
  assert.equal(allowedOwnCountry.allowed, true);

  // Super Admin has unrestricted country access
  assert.equal(canAdminApproveOutsideCountry('super_admin', undefined, 'DE').allowed, true);
  assert.equal(canAdminApproveOutsideCountry('super_admin', undefined, 'US').allowed, true);
});

test('Router telemetry advances packets, tracks loss, injects fault, and resolves cleanly', () => {
  const r0 = makeRouter();
  const r1 = advanceRouterTraffic(r0, 12.5, 400);
  assert.equal(r1.dataTransferredMb, 133);
  assert.equal(r1.packetCount, 10400);
  assert.ok(r1.packetsSent > r0.packetsSent);
  assert.equal(r1.status, 'Nominal');

  const broken = applyRouterFault(r1, 'router_packet_storm');
  assert.equal(broken.status, 'Critical');
  assert.ok(broken.packetLossCount > r1.packetLossCount);
  assert.equal(broken.activeError, 'router_packet_storm');

  const fixed = resolveRouterFault(broken);
  assert.equal(fixed.status, 'Nominal');
  assert.equal(fixed.activeError, null);
  assert.equal(fixed.packetLossPct, 0.04);
});

test('Storage telemetry reflects RAID/ReadOnly faults and clears on resolution', () => {
  const s0 = makeStorage();
  const degraded = applyStorageFault(s0, 'storage_readonly_lock');
  assert.equal(degraded.status, 'Critical');
  assert.equal(degraded.raidState, 'Read-Only Lock');
  assert.equal(degraded.writeMbps, 0);

  const recovered = resolveStorageFault(degraded);
  assert.equal(recovered.status, 'Nominal');
  assert.equal(recovered.raidState, 'Healthy (RAID-10)');
  assert.equal(recovered.smartStatus, 'PASS');
});
