import type { DeviceProfile, IndustryType, RegionCode } from './schema';

interface CitySeed {
  countryCode: string;
  countryName: string;
  region: RegionCode;
  stateCode: string;
  stateName: string;
  cityCode: string;
  cityName: string;
  lat: number;
  lon: number;
  tz: string;
}

const CITY_SEEDS: CitySeed[] = [
  {
    countryCode: 'IN',
    countryName: 'India',
    region: 'IN',
    stateCode: 'KA',
    stateName: 'Karnataka',
    cityCode: 'BLR',
    cityName: 'Bengaluru',
    lat: 12.9716,
    lon: 77.5946,
    tz: 'Asia/Kolkata',
  },
  {
    countryCode: 'IN',
    countryName: 'India',
    region: 'IN',
    stateCode: 'MH',
    stateName: 'Maharashtra',
    cityCode: 'BOM',
    cityName: 'Mumbai',
    lat: 19.076,
    lon: 72.8777,
    tz: 'Asia/Kolkata',
  },
  {
    countryCode: 'IN',
    countryName: 'India',
    region: 'IN',
    stateCode: 'DL',
    stateName: 'Delhi',
    cityCode: 'DEL',
    cityName: 'New Delhi',
    lat: 28.6139,
    lon: 77.209,
    tz: 'Asia/Kolkata',
  },
  {
    countryCode: 'DE',
    countryName: 'Germany',
    region: 'EU',
    stateCode: 'BY',
    stateName: 'Bavaria',
    cityCode: 'MUC',
    cityName: 'Munich',
    lat: 48.1351,
    lon: 11.582,
    tz: 'Europe/Berlin',
  },
  {
    countryCode: 'DE',
    countryName: 'Germany',
    region: 'EU',
    stateCode: 'BE',
    stateName: 'Berlin',
    cityCode: 'BER',
    cityName: 'Berlin',
    lat: 52.52,
    lon: 13.405,
    tz: 'Europe/Berlin',
  },
  {
    countryCode: 'US',
    countryName: 'United States',
    region: 'US',
    stateCode: 'NY',
    stateName: 'New York',
    cityCode: 'NYC',
    cityName: 'New York City',
    lat: 40.7128,
    lon: -74.006,
    tz: 'America/New_York',
  },
  {
    countryCode: 'US',
    countryName: 'United States',
    region: 'US',
    stateCode: 'CA',
    stateName: 'California',
    cityCode: 'SFO',
    cityName: 'San Francisco',
    lat: 37.7749,
    lon: -122.4194,
    tz: 'America/Los_Angeles',
  },
  {
    countryCode: 'GB',
    countryName: 'United Kingdom',
    region: 'EU',
    stateCode: 'EN',
    stateName: 'England',
    cityCode: 'LON',
    cityName: 'London',
    lat: 51.5074,
    lon: -0.1278,
    tz: 'Europe/London',
  },
];

const INDUSTRIES: IndustryType[] = [
  'bank',
  'mnc',
  'supermarket',
  'hospital',
  'university',
  'datacenter',
];

const INDUSTRY_BUILDING_NAMES: Record<IndustryType, string[]> = {
  bank: ['FinCore Tower', 'Meridian Clearing House'],
  mnc: ['Apex Global Plaza', 'Vanguard Tech Campus'],
  supermarket: ['FreshMart Central', 'Metro Hypermarket'],
  hospital: ['St. Jude Medical Center', 'CarePulse Pavilion'],
  university: ['Polytechnic North Hall', 'Founders Science Wing'],
  datacenter: ['VaultIX Edge Facility', 'CoreGrid Tier-4 Pod'],
};

const INDUSTRY_APPS: Record<IndustryType, string[]> = {
  bank: ['Settlement Ledger', 'Fraud Console', 'SWIFT Monitor'],
  mnc: ['ERP Workbench', 'HR Directory', 'VPN Concentrator'],
  supermarket: ['POS Terminal Hub', 'Cold-Chain Inventory', 'Barcode Sync'],
  hospital: ['EHR Clinical Desk', 'DICOM PACS Node', 'Lab Telemetry'],
  university: ['Campus LMS Node', 'Research Cluster', 'Library Auth'],
  datacenter: ['Rack PDU Manager', 'BGP Flow Inspector', 'KVM Console'],
};

const ACCENT_PALETTE = [
  '#06b6d4',
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#6366f1',
  '#14b8a6',
];

const WALLPAPER_STYLES: DeviceProfile['wallpaperStyle'][] = [
  'cobalt-grid',
  'emerald-prism',
  'amber-circuit',
  'indigo-wave',
  'teal-slate',
  'cyan-horizon',
];

function deterministicHash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function computeUidCheckChar(baseUid: string): string {
  const alphabet = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const sum = deterministicHash(baseUid) % alphabet.length;
  return alphabet[sum];
}

export function computePseudoIdSync(uid: string, tenantId: string): string {
  // Deterministic SHA-like 16-char pseudonym for client & pure tests; server uses crypto HMAC-SHA256
  const h1 = deterministicHash(`${tenantId}:${uid}:nexaura-v1`).toString(16).padStart(8, '0');
  const h2 = deterministicHash(`${uid}:${tenantId}:salt-92`).toString(16).padStart(8, '0');
  return `ps_${h1}${h2}`;
}

export function getCityTimezone(cityCode: string): string {
  return CITY_SEEDS.find((c) => c.cityCode === cityCode)?.tz ?? 'UTC';
}

export function buildGlobalTopology(): DeviceProfile[] {
  const devices: DeviceProfile[] = [];
  let globalBuildingSeq = 1;

  for (const city of CITY_SEEDS) {
    for (let d = 1; d <= 2; d++) {
      const districtCode = `D0${d}`;
      const districtName = d === 1 ? `${city.cityName} Central District` : `${city.cityName} Tech Corridor`;
      const buildingCount = d === 1 ? 2 : 1; // 3 buildings per city -> 24 buildings total

      for (let b = 1; b <= buildingCount; b++) {
        const buildingCode = `B0${globalBuildingSeq}`;
        const industry = INDUSTRIES[(globalBuildingSeq - 1) % INDUSTRIES.length];
        const bNames = INDUSTRY_BUILDING_NAMES[industry];
        const buildingName = `${bNames[(globalBuildingSeq + b) % bNames.length]} (${city.cityCode})`;
        const tenantId = `tenant-${city.countryCode.toLowerCase()}-${industry}-${String(globalBuildingSeq).padStart(2, '0')}`;
        const collectorId = `col-${city.cityCode.toLowerCase()}-${buildingCode.toLowerCase()}`;
        const buildingCoreId = `core-${city.cityCode.toLowerCase()}-${buildingCode.toLowerCase()}`;

        const floors = industry === 'datacenter' || industry === 'bank' ? 3 : 2;
        let deviceCounter = 1;

        for (let f = 1; f <= floors; f++) {
          const floorSwitchId = `sw-${city.cityCode.toLowerCase()}-${buildingCode.toLowerCase()}-f0${f}`;
          const devicesOnFloor = f === 1 ? 3 : 2;

          for (let w = 1; w <= devicesOnFloor; w++) {
            const devNum = String(deviceCounter).padStart(3, '0');
            const baseUid = `${city.countryCode}-${city.stateCode}-${city.cityCode}-${districtCode}-${buildingCode}-F0${f}-W${devNum}`;
            const checkChar = computeUidCheckChar(baseUid);
            const uid = `${baseUid}-${checkChar}`;
            const h = deterministicHash(uid);
            const accentHex = ACCENT_PALETTE[h % ACCENT_PALETTE.length];
            const wallpaperStyle = WALLPAPER_STYLES[h % WALLPAPER_STYLES.length];
            const indApps = INDUSTRY_APPS[industry];

            const isFlagship =
              city.cityCode === 'BLR' && d === 2 && f === 3 && w === 1
                ? false
                : city.cityCode === 'BLR' && d === 1 && f === 1 && w === 1;

            devices.push({
              uid,
              pseudoSourceId: computePseudoIdSync(uid, tenantId),
              tenantId,
              region: city.region,
              countryCode: city.countryCode,
              countryName: city.countryName,
              stateCode: city.stateCode,
              stateName: city.stateName,
              cityCode: city.cityCode,
              cityName: city.cityName,
              districtCode,
              districtName,
              buildingCode,
              buildingName,
              industry,
              floorNumber: f,
              floorSwitchId,
              buildingCoreId,
              collectorId,
              hostname: `${city.cityCode.toLowerCase()}-${industry.slice(0, 4)}-w${devNum}`,
              username: isFlagship ? 'arjun.rao' : `op.${city.cityCode.toLowerCase()}.${devNum}`,
              accentHex,
              wallpaperStyle,
              cpuSpec: h % 2 === 0 ? 'AMD Ryzen 9 PRO 7940HS' : 'Intel Xeon W-2445',
              ramGb: [16, 32, 64][h % 3],
              osVersion: 'WinShell 11 Enterprise 24H2',
              installedApps: [
                'Nexaura Collector',
                'File Explorer',
                'Task Manager',
                'Event Viewer',
                'Terminal',
                'CipherShare Mesh',
                ...indApps,
              ],
              taskbarApps: ['Nexaura Collector', 'File Explorer', 'Task Manager', 'Event Viewer', indApps[0]],
              lat: city.lat + (d - 1.5) * 0.03 + b * 0.01,
              lon: city.lon + (d - 1.5) * 0.03 - b * 0.01,
            });
            deviceCounter++;
          }
        }
        globalBuildingSeq++;
      }
    }
  }

  // Ensure the exact reference UID from the spec exists cleanly in Bengaluru D02 B07 F03 W014
  const refBase = 'IN-KA-BLR-D02-B07-F03-W014';
  const refUid = `${refBase}-X`;
  if (!devices.some((x) => x.uid === refUid)) {
    devices.unshift({
      uid: refUid,
      pseudoSourceId: computePseudoIdSync(refUid, 'tenant-in-bank-01'),
      tenantId: 'tenant-in-bank-01',
      region: 'IN',
      countryCode: 'IN',
      countryName: 'India',
      stateCode: 'KA',
      stateName: 'Karnataka',
      cityCode: 'BLR',
      cityName: 'Bengaluru',
      districtCode: 'D02',
      districtName: 'Bengaluru Tech Corridor',
      buildingCode: 'B07',
      buildingName: 'FinCore Clearing Tower (BLR)',
      industry: 'bank',
      floorNumber: 3,
      floorSwitchId: 'sw-blr-b07-f03',
      buildingCoreId: 'core-blr-b07',
      collectorId: 'col-blr-b07',
      hostname: 'blr-bank-w014',
      username: 'ananya.sharma',
      accentHex: '#06b6d4',
      wallpaperStyle: 'cyan-horizon',
      cpuSpec: 'Intel Core Ultra 9 185H',
      ramGb: 64,
      osVersion: 'WinShell 11 Enterprise 24H2',
      installedApps: [
        'Nexaura Collector',
        'File Explorer',
        'Task Manager',
        'Event Viewer',
        'Terminal',
        'CipherShare Mesh',
        'Settlement Ledger',
        'Fraud Console',
        'SWIFT Monitor',
      ],
      taskbarApps: ['Nexaura Collector', 'File Explorer', 'Task Manager', 'Event Viewer', 'Settlement Ledger'],
      lat: 12.978,
      lon: 77.612,
    });
  }

  return devices;
}

export const GLOBAL_TOPOLOGY: DeviceProfile[] = buildGlobalTopology();

export function findDeviceByUid(uid: string): DeviceProfile | undefined {
  return GLOBAL_TOPOLOGY.find((d) => d.uid === uid);
}
