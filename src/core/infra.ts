import type {
  AdminPermissionKey,
  CloudFaultCode,
  CloudSystemTelemetry,
  CountryAdminRecord,
  DeviceProfile,
  InfraStatus,
  RegionCode,
  RouterFaultCode,
  RouterTelemetry,
  StorageFaultCode,
  StorageTelemetry,
  UserRole,
} from '../shared/schema';

export interface InfraFaultCatalogEntry<T extends string> {
  code: T;
  label: string;
  severity: 'medium' | 'high' | 'critical';
  description: string;
}

export const ROUTER_FAULT_CATALOG: InfraFaultCatalogEntry<RouterFaultCode>[] = [
  {
    code: 'router_link_down',
    label: 'Interface Link Down',
    severity: 'critical',
    description: 'Physical/SFP uplink port dropped carrier; zero outbound frames passing.',
  },
  {
    code: 'router_bgp_flap',
    label: 'BGP Route Flap',
    severity: 'high',
    description: 'Gateway BGP peering resetting every 25s causing transient path drops.',
  },
  {
    code: 'router_packet_storm',
    label: 'CRC Packet Loss Storm',
    severity: 'critical',
    description: 'High frame checksum errors causing severe packet drops and retransmits.',
  },
  {
    code: 'router_nat_exhaustion',
    label: 'NAT Table Exhaustion',
    severity: 'high',
    description: 'Ephemeral session translation table above 96% capacity.',
  },
  {
    code: 'router_routing_loop',
    label: 'TTL Routing Loop',
    severity: 'medium',
    description: 'Asymmetric next-hop forwarding loop increasing hop latency.',
  },
];

export const STORAGE_FAULT_CATALOG: InfraFaultCatalogEntry<StorageFaultCode>[] = [
  {
    code: 'storage_raid_degraded',
    label: 'RAID-10 Degraded Rebuild',
    severity: 'high',
    description: 'Single NVMe mirror bay offline; array rebuilding parity blocks.',
  },
  {
    code: 'storage_smart_warning',
    label: 'SMART Sector Warning',
    severity: 'high',
    description: 'Reallocated sector count rising above drive wear threshold.',
  },
  {
    code: 'storage_nvme_saturated',
    label: 'NVMe Queue Saturation',
    severity: 'critical',
    description: 'Write queue depth maxed out; WAL sync latency exceeding SLA.',
  },
  {
    code: 'storage_readonly_lock',
    label: 'Read-Only Volume Lock',
    severity: 'critical',
    description: 'Filesystem remounted read-only to protect journal integrity.',
  },
  {
    code: 'storage_spool_full',
    label: 'Spool Volume Full (>95%)',
    severity: 'high',
    description: 'Encrypted telemetry buffer partition approaching capacity cap.',
  },
];

export const COUNTRY_DIRECTORY: {
  countryCode: string;
  countryName: string;
  region: RegionCode;
  adminUsername: string;
  adminDisplayName: string;
  superAdminId: string;
}[] = [
  {
    countryCode: 'IN',
    countryName: 'India',
    region: 'IN',
    adminUsername: 'admin.in',
    adminDisplayName: 'Country Admin · India',
    superAdminId: 'super.admin.in',
  },
  {
    countryCode: 'DE',
    countryName: 'Germany',
    region: 'EU',
    adminUsername: 'admin.de',
    adminDisplayName: 'Country Admin · Germany',
    superAdminId: 'super.admin.de',
  },
  {
    countryCode: 'GB',
    countryName: 'United Kingdom',
    region: 'EU',
    adminUsername: 'admin.gb',
    adminDisplayName: 'Country Admin · United Kingdom',
    superAdminId: 'super.admin.gb',
  },
  {
    countryCode: 'US',
    countryName: 'United States',
    region: 'US',
    adminUsername: 'admin.us',
    adminDisplayName: 'Country Admin · United States',
    superAdminId: 'super.admin.us',
  },
];

export const ADMIN_PERMISSION_LABELS: Record<
  AdminPermissionKey,
  { label: string; description: string }
> = {
  cross_country_transfer: {
    label: 'Cross-Country File Transfer Grant',
    description: 'Allows this Country Admin to unlock Outside-Country file transfers on devices in their country.',
  },
  edit_health_thresholds: {
    label: 'Edit Health SLA Thresholds',
    description: 'Allows modifying CPU, latency, and stale heartbeat thresholds.',
  },
  manage_server_faults: {
    label: 'Server Router & Storage Control',
    description: 'Allows injecting or resetting server-tier router and storage faults.',
  },
  export_governance_logs: {
    label: 'Export Server Governance Logs',
    description: 'Allows downloading full CSV/JSON Tier 2 audit bundles.',
  },
};

export function getCountryAuthorityForDevice(dev: Pick<DeviceProfile, 'countryCode' | 'countryName' | 'region'>) {
  const entry = COUNTRY_DIRECTORY.find((c) => c.countryCode === dev.countryCode);
  return (
    entry ?? {
      countryCode: dev.countryCode,
      countryName: dev.countryName,
      region: dev.region,
      adminUsername: `admin.${dev.countryCode.toLowerCase()}`,
      adminDisplayName: `Country Admin · ${dev.countryName}`,
      superAdminId: `super.admin.${dev.countryCode.toLowerCase()}`,
    }
  );
}

export function buildDefaultCountryAdmins(): CountryAdminRecord[] {
  return COUNTRY_DIRECTORY.map((c) => ({
    adminUsername: c.adminUsername,
    displayName: c.adminDisplayName,
    countryCode: c.countryCode,
    countryName: c.countryName,
    region: c.region,
    countrySuperAdminId: c.superAdminId,
    permissions: {
      cross_country_transfer: false,
      edit_health_thresholds: false,
      manage_server_faults: false,
      export_governance_logs: false,
    },
    pendingRequests: [],
  }));
}

export function canAdminApproveOutsideCountry(
  role: UserRole,
  countryAdmin: CountryAdminRecord | undefined,
  targetCountryCode: string
): { allowed: boolean; reason?: string } {
  if (role === 'super_admin') {
    return { allowed: true };
  }
  if (role !== 'country_admin' || !countryAdmin) {
    return { allowed: false, reason: 'Only Country Admin (with Super Admin permission) or Super Admin can modify country boundaries.' };
  }
  if (countryAdmin.countryCode !== targetCountryCode) {
    return {
      allowed: false,
      reason: `Scope restricted: ${countryAdmin.adminUsername} only manages ${countryAdmin.countryName} (${countryAdmin.countryCode}) devices.`,
    };
  }
  if (!countryAdmin.permissions.cross_country_transfer) {
    return {
      allowed: false,
      reason: `Super Admin approval required: ${countryAdmin.adminUsername} must request "Cross-Country File Transfer" permission from Super Admin (${countryAdmin.countrySuperAdminId}) before unlocking devices.`,
    };
  }
  return { allowed: true };
}

export function computeRouterStatus(router: Pick<RouterTelemetry, 'activeError' | 'packetLossPct' | 'latencyMs'>): InfraStatus {
  if (router.activeError === 'router_link_down') return 'Offline';
  if (
    router.activeError === 'router_packet_storm' ||
    router.activeError === 'router_nat_exhaustion' ||
    router.packetLossPct >= 4.0
  ) {
    return 'Critical';
  }
  if (router.activeError || router.packetLossPct >= 1.2 || router.latencyMs >= 85) {
    return 'Warning';
  }
  return 'Nominal';
}

export function computeStorageStatus(storage: Pick<StorageTelemetry, 'activeError' | 'usedPct' | 'raidState' | 'smartStatus'>): InfraStatus {
  if (storage.activeError === 'storage_readonly_lock' || storage.activeError === 'storage_nvme_saturated') {
    return 'Critical';
  }
  if (storage.activeError || storage.usedPct >= 88 || storage.raidState !== 'Healthy (RAID-10)' || storage.smartStatus !== 'PASS') {
    return storage.usedPct >= 95 ? 'Critical' : 'Warning';
  }
  return 'Nominal';
}

export function applyRouterFault(router: RouterTelemetry, faultCode: RouterFaultCode): RouterTelemetry {
  const entry = ROUTER_FAULT_CATALOG.find((f) => f.code === faultCode);
  const next: RouterTelemetry = { ...router, activeError: faultCode, errorDetail: entry?.description ?? faultCode };
  if (faultCode === 'router_link_down') {
    next.bandwidthMbps = 0;
    next.packetLossPct = 100;
    next.packetLossCount += 48;
    next.packetCount += 48;
    next.latencyMs = 999;
  } else if (faultCode === 'router_packet_storm') {
    next.packetLossPct = 14.8;
    next.packetLossCount += 190;
    next.packetCount += 1280;
    next.packetsSent += 1090;
    next.latencyMs = Math.max(next.latencyMs, 168);
  } else if (faultCode === 'router_bgp_flap') {
    next.packetLossPct = 4.6;
    next.packetLossCount += 62;
    next.packetCount += 920;
    next.packetsSent += 858;
    next.latencyMs = Math.max(next.latencyMs, 195);
  } else if (faultCode === 'router_nat_exhaustion') {
    next.packetLossPct = 7.4;
    next.packetLossCount += 110;
    next.packetCount += 1100;
    next.packetsSent += 990;
    next.latencyMs = Math.max(next.latencyMs, 145);
  } else {
    next.packetLossPct = 2.4;
    next.packetLossCount += 24;
    next.packetCount += 780;
    next.packetsSent += 756;
    next.latencyMs = Math.max(next.latencyMs, 132);
  }
  next.status = computeRouterStatus(next);
  return next;
}

export function resolveRouterFault(router: RouterTelemetry): RouterTelemetry {
  const next: RouterTelemetry = {
    ...router,
    activeError: null,
    errorDetail: null,
    packetLossPct: 0.04,
    latencyMs: 21.5,
    bandwidthMbps: Math.max(140, router.bandwidthMbps || 180),
  };
  next.status = computeRouterStatus(next);
  return next;
}

export function applyStorageFault(storage: StorageTelemetry, faultCode: StorageFaultCode): StorageTelemetry {
  const entry = STORAGE_FAULT_CATALOG.find((f) => f.code === faultCode);
  const next: StorageTelemetry = { ...storage, activeError: faultCode, errorDetail: entry?.description ?? faultCode };
  if (faultCode === 'storage_raid_degraded') {
    next.raidState = 'Degraded Rebuild';
    next.iops = Math.round(next.iops * 0.45);
  } else if (faultCode === 'storage_smart_warning') {
    next.smartStatus = 'PRE-FAIL WARNING';
  } else if (faultCode === 'storage_nvme_saturated') {
    next.iops = 48500;
    next.writeMbps = 1950;
  } else if (faultCode === 'storage_readonly_lock') {
    next.raidState = 'Read-Only Lock';
    next.writeMbps = 0;
  } else if (faultCode === 'storage_spool_full') {
    next.usedPct = 96.8;
  }
  next.status = computeStorageStatus(next);
  return next;
}

export function resolveStorageFault(storage: StorageTelemetry): StorageTelemetry {
  const next: StorageTelemetry = {
    ...storage,
    activeError: null,
    errorDetail: null,
    raidState: 'Healthy (RAID-10)',
    smartStatus: 'PASS',
    usedPct: Math.min(storage.usedPct, 54.2),
    iops: 3400,
    readMbps: 420,
    writeMbps: 215,
  };
  next.status = computeStorageStatus(next);
  return next;
}

export function advanceRouterTraffic(
  router: RouterTelemetry,
  deltaDataMb: number,
  deltaPackets: number
): RouterTelemetry {
  if (router.activeError === 'router_link_down') {
    const dropped = Math.max(1, Math.round(deltaPackets * 0.5));
    return {
      ...router,
      packetCount: router.packetCount + dropped,
      packetLossCount: router.packetLossCount + dropped,
      packetLossPct: 100,
      status: 'Offline',
    };
  }
  const lossRate = router.activeError
    ? Math.max(0.02, router.packetLossPct / 100)
    : 0.0005;
  const lost = Math.floor(deltaPackets * lossRate);
  const sent = Math.max(1, deltaPackets - lost);
  const totalCount = router.packetCount + deltaPackets;
  const totalLost = router.packetLossCount + lost;
  const effectiveLossPct = router.activeError
    ? router.packetLossPct
    : Number(((totalLost / Math.max(1, totalCount)) * 100).toFixed(2));

  const updated: RouterTelemetry = {
    ...router,
    dataTransferredMb: Number((router.dataTransferredMb + deltaDataMb).toFixed(2)),
    packetCount: totalCount,
    packetsSent: router.packetsSent + sent,
    packetLossCount: totalLost,
    packetLossPct: effectiveLossPct,
  };
  updated.status = computeRouterStatus(updated);
  return updated;
}

export function applyCloudFault(cloud: CloudSystemTelemetry, faultCode: CloudFaultCode): CloudSystemTelemetry {
  return {
    ...cloud,
    activeError: faultCode,
    status: faultCode === 'cloud_mtls_degraded' ? 'Critical' : 'Warning',
    mtlsState: faultCode === 'cloud_mtls_degraded' ? 'Degraded' : 'Verified',
    syncLatencyMs: faultCode === 'cloud_sync_lag' ? 240 : 128,
    errorDetail:
      faultCode === 'cloud_mtls_degraded'
        ? 'Regional cloud mTLS relay handshake jitter detected.'
        : 'Regional cloud object-store replication lag >200ms.',
  };
}

export function resolveCloudFault(cloud: CloudSystemTelemetry): CloudSystemTelemetry {
  return {
    ...cloud,
    activeError: null,
    errorDetail: null,
    status: 'Nominal',
    mtlsState: 'Verified',
    syncLatencyMs: 24,
  };
}
