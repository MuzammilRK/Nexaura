import test from 'node:test';
import assert from 'node:assert/strict';
import { GLOBAL_TOPOLOGY } from '../shared/topology';
import { buildDefaultTenantCommPolicy, canNodesCommunicate } from './policy';

test('cross-district, cross-city, and cross-country communication are locked by default', () => {
  const blrBank = GLOBAL_TOPOLOGY.find(
    (d) => d.cityCode === 'BLR' && d.districtCode === 'D02' && d.tenantId === 'tenant-in-bank-01'
  )!;
  const sameCityOtherDistrict = GLOBAL_TOPOLOGY.find(
    (d) => d.cityCode === 'BLR' && d.districtCode === 'D01'
  )!;
  const otherCitySameCountry = GLOBAL_TOPOLOGY.find(
    (d) => d.countryCode === 'IN' && d.cityCode !== 'BLR'
  )!;
  const otherCountry = GLOBAL_TOPOLOGY.find((d) => d.countryCode !== 'IN')!;
  const sameDistrictPeer = GLOBAL_TOPOLOGY.find(
    (d) => d.uid !== blrBank.uid && d.cityCode === 'BLR' && d.districtCode === 'D02'
  )!;

  const policy = buildDefaultTenantCommPolicy(blrBank);

  assert.equal(canNodesCommunicate(blrBank, sameDistrictPeer, policy).allowed, true);

  const distBlocked = canNodesCommunicate(blrBank, sameCityOtherDistrict, policy);
  assert.equal(distBlocked.allowed, false);
  assert.equal(distBlocked.boundary, 'district');

  const cityBlocked = canNodesCommunicate(blrBank, otherCitySameCountry, policy);
  assert.equal(cityBlocked.allowed, false);
  assert.equal(cityBlocked.boundary, 'city');

  const countryBlocked = canNodesCommunicate(blrBank, otherCountry, policy);
  assert.equal(countryBlocked.allowed, false);
  assert.equal(countryBlocked.boundary, 'country');
});

test('Super Admin boundary unlocks progressively enable District, City, and Country reachability', () => {
  const blrBank = GLOBAL_TOPOLOGY.find(
    (d) => d.cityCode === 'BLR' && d.districtCode === 'D02' && d.tenantId === 'tenant-in-bank-01'
  )!;
  const sameCityOtherDistrict = GLOBAL_TOPOLOGY.find(
    (d) => d.cityCode === 'BLR' && d.districtCode === 'D01'
  )!;
  const otherCitySameCountry = GLOBAL_TOPOLOGY.find(
    (d) => d.countryCode === 'IN' && d.cityCode !== 'BLR'
  )!;
  const otherCountry = GLOBAL_TOPOLOGY.find((d) => d.countryCode !== 'IN')!;

  const policy = buildDefaultTenantCommPolicy(blrBank);

  // Unlock district only
  policy.allowOutsideDistrict = true;
  assert.equal(canNodesCommunicate(blrBank, sameCityOtherDistrict, policy).allowed, true);
  assert.equal(canNodesCommunicate(blrBank, otherCitySameCountry, policy).allowed, false);
  assert.equal(canNodesCommunicate(blrBank, otherCountry, policy).allowed, false);

  // Unlock city -> allows city + district, still blocks country
  policy.allowOutsideCity = true;
  assert.equal(canNodesCommunicate(blrBank, otherCitySameCountry, policy).allowed, true);
  assert.equal(canNodesCommunicate(blrBank, otherCountry, policy).allowed, false);

  // Unlock country -> allows all external peers
  policy.allowOutsideCountry = true;
  assert.equal(canNodesCommunicate(blrBank, otherCountry, policy).allowed, true);
});
