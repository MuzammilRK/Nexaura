import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronUp,
  ChevronDown,
  Globe2,
  Map as MapIcon,
  Shield,
  ArrowRight,
  Layers,
  Cpu,
  RotateCcw,
} from 'lucide-react';
import { useNexauraStore } from '../state/useNexauraStore';
import { ThreeWorldScene, type ServerInfraMap, type WorldDeviceNode } from './ThreeWorldScene';
import { MultiPortPanel } from './MultiPortPanel';
import type { HealthState } from '../shared/schema';
import { shortDeviceUid } from '../shared/formatters';
import { getCountryAuthorityForDevice } from '../core/infra';

interface TopologyResponse {
  devices: WorldDeviceNode[];
  serverInfra?: ServerInfraMap;
  outageActive: boolean;
  spoolDepth: number;
}

const HEALTH_TEXT_COLOR: Record<HealthState, string> = {
  Excellent: 'text-emerald-400',
  Good: 'text-blue-400',
  Fair: 'text-amber-400',
  Poor: 'text-rose-400',
};

export function WorldExplorer() {
  const {
    worldFocus,
    setWorldFocus,
    resetWorldFocus,
    viewMode2D,
    setViewMode2D,
    reducedEffects,
    setReducedEffects,
    setScreen,
  } = useNexauraStore();

  const [dockOpen, setDockOpen] = useState(true);

  const { data, isLoading, isError, refetch } = useQuery<TopologyResponse>({
    queryKey: ['world-topology'],
    queryFn: async () => {
      const r = await fetch('/api/world/topology');
      if (!r.ok) throw new Error('Failed to load global topology');
      return r.json();
    },
    refetchInterval: 30000,
    refetchOnWindowFocus: false,
  });

  const handleSelectFocus = useCallback((next: Parameters<typeof setWorldFocus>[0]) => {
    setWorldFocus(next);
  }, [setWorldFocus]);

  const handleWebglUnavailable = useCallback(() => {
    setViewMode2D(true);
  }, [setViewMode2D]);

  const devices = data?.devices ?? [];

  const scopedOptions = useMemo(() => {
    if (worldFocus.level === 'globe') {
      const map = new Map<string, { code: string; label: string; count: number; health: HealthState }>();
      for (const d of devices) {
        const cur = map.get(d.countryCode);
        const h = d.metrics?.healthState ?? 'Good';
        if (!cur) map.set(d.countryCode, { code: d.countryCode, label: d.countryName, count: 1, health: h });
        else cur.count++;
      }
      return Array.from(map.values());
    }

    if (worldFocus.level === 'country') {
      const map = new Map<string, { code: string; label: string; count: number; health: HealthState }>();
      for (const d of devices.filter((x) => x.countryCode === worldFocus.countryCode)) {
        const cur = map.get(d.cityCode);
        const h = d.metrics?.healthState ?? 'Good';
        if (!cur) map.set(d.cityCode, { code: d.cityCode, label: `${d.cityName} (${d.stateCode})`, count: 1, health: h });
        else cur.count++;
      }
      return Array.from(map.values());
    }

    if (worldFocus.level === 'city') {
      const map = new Map<string, { code: string; label: string; count: number; health: HealthState }>();
      for (const d of devices.filter((x) => x.cityCode === worldFocus.cityCode)) {
        const cur = map.get(d.districtCode);
        const h = d.metrics?.healthState ?? 'Good';
        if (!cur) map.set(d.districtCode, { code: d.districtCode, label: d.districtName, count: 1, health: h });
        else cur.count++;
      }
      return Array.from(map.values());
    }

    if (worldFocus.level === 'district') {
      const map = new Map<string, { code: string; label: string; count: number; health: HealthState }>();
      for (const d of devices.filter((x) => x.cityCode === worldFocus.cityCode && x.districtCode === worldFocus.districtCode)) {
        const cur = map.get(d.buildingCode);
        const h = d.metrics?.healthState ?? 'Good';
        if (!cur) map.set(d.buildingCode, { code: d.buildingCode, label: `${d.buildingName} · ${d.industry}`, count: 1, health: h });
        else cur.count++;
      }
      return Array.from(map.values());
    }

    if (worldFocus.level === 'building') {
      const map = new Map<string, { code: string; label: string; count: number; health: HealthState }>();
      for (const d of devices.filter(
        (x) =>
          (!worldFocus.countryCode || x.countryCode === worldFocus.countryCode) &&
          (!worldFocus.cityCode || x.cityCode === worldFocus.cityCode) &&
          (!worldFocus.districtCode || x.districtCode === worldFocus.districtCode) &&
          x.buildingCode === worldFocus.buildingCode
      )) {
        const key = String(d.floorNumber);
        const cur = map.get(key);
        const h = d.metrics?.healthState ?? 'Good';
        if (!cur) map.set(key, { code: key, label: `Floor 0${d.floorNumber} (${d.floorSwitchId})`, count: 1, health: h });
        else cur.count++;
      }
      return Array.from(map.values());
    }

    return devices
      .filter(
        (x) =>
          (!worldFocus.countryCode || x.countryCode === worldFocus.countryCode) &&
          (!worldFocus.cityCode || x.cityCode === worldFocus.cityCode) &&
          (!worldFocus.districtCode || x.districtCode === worldFocus.districtCode) &&
          (!worldFocus.buildingCode || x.buildingCode === worldFocus.buildingCode) &&
          (!worldFocus.floorNumber || x.floorNumber === worldFocus.floorNumber)
      )
      .map((d) => ({
        code: d.uid,
        label: `${shortDeviceUid(d.uid)} · ${d.hostname}`,
        count: 1,
        health: d.metrics?.healthState ?? 'Good',
      }));
  }, [devices, worldFocus]);

  const selectedDevice = useMemo(
    () => devices.find((d) => d.uid === worldFocus.deviceUid) ?? null,
    [devices, worldFocus.deviceUid]
  );

  const handleDrillSelect = (code: string) => {
    if (worldFocus.level === 'globe') {
      setWorldFocus({ level: 'country', countryCode: code });
    } else if (worldFocus.level === 'country') {
      setWorldFocus({ level: 'city', cityCode: code });
    } else if (worldFocus.level === 'city') {
      setWorldFocus({ level: 'district', districtCode: code });
    } else if (worldFocus.level === 'district') {
      setWorldFocus({ level: 'building', buildingCode: code });
    } else if (worldFocus.level === 'building') {
      setWorldFocus({ level: 'floor', floorNumber: Number(code) });
    } else {
      setWorldFocus({ level: 'device', deviceUid: code });
    }
  };

  const handleStepBack = () => {
    if (worldFocus.level === 'device') {
      setWorldFocus({ level: 'floor', deviceUid: null });
    } else if (worldFocus.level === 'floor') {
      setWorldFocus({ level: 'building', floorNumber: null, deviceUid: null });
    } else if (worldFocus.level === 'building') {
      setWorldFocus({ level: 'district', buildingCode: null, floorNumber: null, deviceUid: null });
    } else if (worldFocus.level === 'district') {
      setWorldFocus({ level: 'city', districtCode: null, buildingCode: null, floorNumber: null, deviceUid: null });
    } else if (worldFocus.level === 'city') {
      setWorldFocus({ level: 'country', cityCode: null, districtCode: null, buildingCode: null, floorNumber: null, deviceUid: null });
    } else {
      resetWorldFocus();
    }
  };

  const jumpToFlagship = () => {
    setWorldFocus({
      level: 'device',
      countryCode: 'IN',
      cityCode: 'BLR',
      districtCode: 'D02',
      buildingCode: 'B07',
      floorNumber: 3,
      deviceUid: 'IN-KA-BLR-D02-B07-F03-W014-X',
    });
  };

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#0B0D11] text-zinc-100">
      {/* Top 3-Zone Header */}
      <header className="relative z-20 flex items-center justify-between gap-8 border-b border-[#222733] bg-[#0F1218] px-6 py-3">
        <span className="font-display text-lg font-semibold tracking-tight text-white whitespace-nowrap shrink-0">
          Nexaura
        </span>

        <nav aria-label="World Navigation" className="hidden md:flex items-center gap-6 text-sm font-medium text-zinc-400">
          <button
            type="button"
            onClick={resetWorldFocus}
            className="hover:text-white transition-colors whitespace-nowrap shrink-0"
          >
            Global Fleet
          </button>
          <button
            type="button"
            onClick={jumpToFlagship}
            className="hover:text-white transition-colors whitespace-nowrap shrink-0"
          >
            Bengaluru Flagship
          </button>
          <button
            type="button"
            onClick={() => setViewMode2D(!viewMode2D)}
            className="hover:text-white transition-colors whitespace-nowrap shrink-0"
          >
            {viewMode2D ? '3D Earth View' : '2D Map View'}
          </button>
        </nav>

        <div className="flex items-center gap-2.5 shrink-0">
          <MultiPortPanel />
          <button
            type="button"
            onClick={() => setScreen('super-login')}
            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-blue-500 transition-colors whitespace-nowrap shrink-0"
          >
            <Shield className="h-3.5 w-3.5" />
            Regional SaaS Login
          </button>
        </div>
      </header>

      {/* Main Viewport: 3D Earth or 2D Map */}
      <main className="relative h-[calc(100vh-53px)] w-full">
        {isLoading ? (
          <div className="flex h-full items-center justify-center bg-[#0B0D11]">
            <div className="space-y-3 text-center">
              <div className="mx-auto h-8 w-8 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
              <p className="text-sm text-zinc-400">Loading global fleet map...</p>
            </div>
          </div>
        ) : isError ? (
          <div className="flex h-full items-center justify-center bg-[#0B0D11] p-6">
            <div className="max-w-md rounded-lg border border-[#222733] bg-[#12151C] p-6 text-center">
              <p className="text-sm font-medium text-rose-400">Unable to load world topology.</p>
              <button
                type="button"
                onClick={() => refetch()}
                className="mt-4 rounded-md bg-[#1A1E28] px-4 py-2 text-xs font-medium text-white hover:bg-[#232836]"
              >
                Retry Topology Fetch
              </button>
            </div>
          </div>
        ) : viewMode2D ? (
          <div data-testid="world-2d-fallback" className="h-full overflow-y-auto bg-[#0B0D11] p-8 pb-44">
            <div className="mx-auto max-w-6xl">
              <div className="flex items-center justify-between gap-4 border-b border-[#222733] pb-4">
                <div>
                  <h1 className="text-xl font-semibold text-white">Infrastructure Directory</h1>
                  <p className="mt-1 text-sm text-zinc-400">
                    {devices.length} endpoints across India, Germany, United States, and United Kingdom.
                  </p>
                </div>
                <span className="font-mono text-xs text-zinc-400 tabular-nums">
                  Spool: {data?.spoolDepth ?? 0} · {data?.outageActive ? 'Outage Active' : 'Link Nominal'}
                </span>
              </div>

              <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {scopedOptions.map((opt) => (
                  <button
                    key={opt.code}
                    type="button"
                    onClick={() => handleDrillSelect(opt.code)}
                    className="flex items-center justify-between rounded-lg border border-[#222733] bg-[#12151C] p-4 text-left hover:border-zinc-600 hover:bg-[#171B24] transition-colors"
                  >
                    <div>
                      <div className="text-sm font-medium text-white">{opt.label}</div>
                      <div className="mt-1 font-mono text-xs text-zinc-400 tabular-nums">
                        {opt.count} node{opt.count === 1 ? '' : 's'}
                      </div>
                    </div>
                    <span className={`font-mono text-xs font-medium ${HEALTH_TEXT_COLOR[opt.health]}`}>
                      {opt.health}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <ThreeWorldScene
            devices={devices}
            serverInfra={data?.serverInfra}
            focus={worldFocus}
            reducedEffects={reducedEffects}
            onSelectFocus={handleSelectFocus}
            onWebglUnavailable={handleWebglUnavailable}
          />
        )}

        {/* Top-left Breadcrumb */}
        <div className="pointer-events-none absolute left-6 top-5 z-10 flex flex-col gap-1.5">
          <div className="pointer-events-auto inline-flex items-center gap-2 rounded-md border border-[#222733] bg-[#12151C] px-3 py-1.5 text-xs text-zinc-300 shadow-lg">
            <Globe2 className="h-3.5 w-3.5 text-blue-400 shrink-0" />
            <span className="font-medium capitalize text-white">{worldFocus.level}</span>
            {worldFocus.countryCode && <span className="text-zinc-400">/ {worldFocus.countryCode}</span>}
            {worldFocus.cityCode && <span className="text-zinc-400">/ {worldFocus.cityCode}</span>}
            {worldFocus.districtCode && <span className="text-zinc-400">/ {worldFocus.districtCode}</span>}
            {worldFocus.buildingCode && <span className="text-zinc-400">/ {worldFocus.buildingCode}</span>}
            {worldFocus.floorNumber && <span className="text-zinc-400">/ F0{worldFocus.floorNumber}</span>}
            {worldFocus.deviceUid && (
              <span className="font-mono text-blue-300" title={worldFocus.deviceUid}>
                / {shortDeviceUid(worldFocus.deviceUid)}
              </span>
            )}
          </div>
          {!viewMode2D && worldFocus.level === 'globe' && (
            <div className="text-[11px] text-zinc-400 px-1">
              Click anywhere on Earth or a marker to zoom in
            </div>
          )}
        </div>

        {/* Selected Device Hand-off Card */}
        {selectedDevice && (() => {
          const auth = getCountryAuthorityForDevice(selectedDevice);
          const m = selectedDevice.metrics;
          return (
            <div className="absolute right-6 top-5 z-20 w-80 rounded-lg border border-[#293040] bg-[#12151C] p-4 shadow-2xl">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[11px] font-medium text-blue-400">Selected Endpoint</p>
                  <h2 className="mt-0.5 text-sm font-semibold text-white">{selectedDevice.hostname}</h2>
                  <p className="font-mono text-[11px] text-zinc-400" title={selectedDevice.uid}>
                    {shortDeviceUid(selectedDevice.uid)}
                  </p>
                </div>
                <span
                  className={`font-mono text-xs font-semibold ${
                    HEALTH_TEXT_COLOR[m?.healthState ?? 'Good']
                  }`}
                >
                  {m?.healthState ?? 'Good'}
                </span>
              </div>

              <div className="mt-3 space-y-1.5 border-t border-[#222733] pt-3 text-xs text-zinc-300">
                <div>{selectedDevice.buildingName} · Floor 0{selectedDevice.floorNumber}</div>
                <div className="text-[11px] text-zinc-400">
                  {selectedDevice.floorSwitchId} → {selectedDevice.buildingCoreId} → {selectedDevice.collectorId}
                </div>
                <div className="font-mono text-[11px] tabular-nums text-zinc-400">
                  CPU {m?.cpuPct ?? 30}% · {m?.latencyMs ?? 20}ms · {m?.packetLossPct ?? 0}% loss
                </div>
                <div className="grid grid-cols-3 gap-1.5 pt-1 font-mono text-[10px]">
                  <div className="rounded border border-[#222733] bg-[#0B0D11] px-2 py-1">
                    <div className="text-zinc-500">Router</div>
                    <div className={m?.router?.status === 'Nominal' ? 'text-emerald-400' : 'text-amber-400'}>
                      {m?.router?.status ?? 'Nominal'}
                    </div>
                  </div>
                  <div className="rounded border border-[#222733] bg-[#0B0D11] px-2 py-1">
                    <div className="text-zinc-500">Storage</div>
                    <div className={m?.storage?.status === 'Nominal' ? 'text-emerald-400' : 'text-amber-400'}>
                      {m?.storage?.status ?? 'Nominal'}
                    </div>
                  </div>
                  <div className="rounded border border-[#222733] bg-[#0B0D11] px-2 py-1">
                    <div className="text-zinc-500">Cloud</div>
                    <div className={m?.cloud?.status === 'Nominal' ? 'text-emerald-400' : 'text-amber-400'}>
                      {m?.cloud?.status ?? 'Nominal'}
                    </div>
                  </div>
                </div>
                <div className="text-[11px] text-zinc-400 pt-0.5">
                  Admin: <span className="font-mono text-zinc-200">{auth.adminUsername}</span> · Super: <span className="font-mono text-zinc-200">{auth.superAdminId}</span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setScreen('device-login')}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500 transition-colors"
              >
                Connect to Device Shell
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })()}

        {/* Collapsible Bottom Control Dock */}
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-20 flex justify-center px-3">
          <div
            className="pointer-events-auto w-[min(940px,95vw)] transition-transform duration-200"
            style={{ transform: dockOpen ? 'translateY(0)' : 'translateY(calc(100% - 34px))' }}
          >
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => setDockOpen(!dockOpen)}
                className="inline-flex items-center gap-1.5 rounded-t-md border border-b-0 border-[#222733] bg-[#12151C] px-4 py-1 text-xs font-medium text-zinc-400 hover:text-white"
              >
                {dockOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
                {dockOpen ? 'Hide Controls' : 'Show Controls'}
              </button>
            </div>

            <div className="rounded-lg border border-[#222733] bg-[#12151C] p-3.5 shadow-2xl">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#222733] pb-2.5">
                <div className="flex items-center gap-2">
                  {worldFocus.level !== 'globe' && (
                    <button
                      type="button"
                      onClick={handleStepBack}
                      className="inline-flex items-center gap-1.5 rounded-md border border-[#2B3242] bg-[#1A1E28] px-2.5 py-1.5 text-xs font-medium text-zinc-200 hover:bg-[#232836]"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Step Out
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={jumpToFlagship}
                    className="inline-flex items-center gap-1.5 rounded-md border border-[#2B3242] bg-[#1A1E28] px-2.5 py-1.5 text-xs font-medium text-zinc-100 hover:bg-[#232836]"
                  >
                    <Cpu className="h-3 w-3 text-blue-400" />
                    Flagship: BLR-B07-W014
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setViewMode2D(!viewMode2D)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-[#2B3242] bg-[#1A1E28] px-2.5 py-1.5 text-xs font-medium text-zinc-300 hover:text-white hover:bg-[#232836]"
                  >
                    <MapIcon className="h-3 w-3" />
                    {viewMode2D ? '3D Earth' : '2D Map'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setReducedEffects(!reducedEffects)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-[#2B3242] bg-[#1A1E28] px-2.5 py-1.5 text-xs font-medium text-zinc-300 hover:text-white hover:bg-[#232836]"
                  >
                    <Layers className="h-3 w-3" />
                    {reducedEffects ? 'Effects: Reduced' : 'Effects: Full'}
                  </button>
                </div>
              </div>

              <div className="mt-2.5 flex items-center gap-2 overflow-x-auto pb-1">
                {scopedOptions.map((opt) => (
                  <button
                    key={opt.code}
                    type="button"
                    onClick={() => handleDrillSelect(opt.code)}
                    className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                      worldFocus.deviceUid === opt.code
                        ? 'border-blue-500 bg-blue-600/20 text-white'
                        : 'border-[#222733] bg-[#181C25] text-zinc-300 hover:border-zinc-600 hover:text-white'
                    }`}
                  >
                    <span>{opt.label}</span>
                    <span className={`font-mono text-[10px] ${HEALTH_TEXT_COLOR[opt.health]}`}>
                      {opt.health}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
