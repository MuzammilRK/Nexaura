import type { DeviceProfile, TenantCommPolicy } from '../shared/schema';

export function buildDefaultTenantCommPolicy(dev: DeviceProfile): TenantCommPolicy {
  return {
    tenantId: dev.tenantId,
    region: dev.region,
    countryCode: dev.countryCode,
    countryName: dev.countryName,
    cityCode: dev.cityCode,
    cityName: dev.cityName,
    districtCode: dev.districtCode,
    districtName: dev.districtName,
    allowOutsideDistrict: false,
    allowOutsideCity: false,
    allowOutsideCountry: false,
  };
}

export function canNodesCommunicate(
  fromDev: DeviceProfile,
  toDev: DeviceProfile,
  policy: TenantCommPolicy
): { allowed: boolean; boundary?: 'district' | 'city' | 'country'; reason?: string } {
  if (fromDev.uid === toDev.uid) {
    return { allowed: false, reason: 'Cannot relay file to the same endpoint.' };
  }

  const canCrossCountry = Boolean(policy.allowOutsideCountry);
  const canCrossCity = Boolean(policy.allowOutsideCity || policy.allowOutsideCountry);
  const canCrossDistrict = Boolean(
    policy.allowOutsideDistrict || policy.allowOutsideCity || policy.allowOutsideCountry
  );

  if (fromDev.countryCode !== toDev.countryCode && !canCrossCountry) {
    return {
      allowed: false,
      boundary: 'country',
      reason: `Outside-Country communication is locked for ${fromDev.tenantId}. Country Admin (with Super Admin permission) or Super Admin must unlock it first.`,
    };
  }

  if (fromDev.cityCode !== toDev.cityCode && !canCrossCity) {
    return {
      allowed: false,
      boundary: 'city',
      reason: `Outside-City communication is locked for ${fromDev.tenantId}. Super Admin must unlock it first.`,
    };
  }

  if (fromDev.districtCode !== toDev.districtCode && !canCrossDistrict) {
    return {
      allowed: false,
      boundary: 'district',
      reason: `Outside-District communication is locked for ${fromDev.tenantId}. Super Admin must unlock it first.`,
    };
  }

  return { allowed: true };
}
