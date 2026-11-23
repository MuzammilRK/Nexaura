import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useNexauraStore } from './state/useNexauraStore';
import { useRealtimeSync } from './state/useRealtimeSync';
import { WorldExplorer } from './components/WorldExplorer';
import { DeviceLoginScreen } from './components/DeviceLoginScreen';
import { Tier1Desktop } from './components/Tier1Desktop';
import { SuperAdminLogin } from './components/SuperAdminLogin';
import { Tier2SaasDashboard } from './components/Tier2SaasDashboard';
import { GLOBAL_TOPOLOGY } from './shared/topology';
import { buildPortScopedPath, getActiveGatewayPort } from './shared/portUrl';
import type { ClusterPortBinding, PortRole } from './shared/schema';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 1000,
    },
  },
});

interface RuntimeContextResponse {
  currentPort: number;
  portRole: PortRole;
  assignedDeviceUid?: string;
  activePorts: ClusterPortBinding[];
}

function NexauraShell() {
  const {
    screen,
    setWorldFocus,
    setScreen,
    setViewMode2D,
    setRuntimeInfo,
  } = useNexauraStore();

  useRealtimeSync();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const paramRole = params.get('role') as PortRole | null;
    const paramUid = params.get('uid');

    if (params.get('mode') === '2d') {
      setViewMode2D(true);
    }

    if (params.get('autostart') === '1' || paramRole === 'client') {
      const targetUid = paramUid || 'IN-KA-BLR-D02-B07-F03-W014-X';
      const dev = GLOBAL_TOPOLOGY.find((d) => d.uid === targetUid) ?? GLOBAL_TOPOLOGY[0];
      setWorldFocus({
        level: 'device',
        countryCode: dev.countryCode,
        cityCode: dev.cityCode,
        districtCode: dev.districtCode,
        buildingCode: dev.buildingCode,
        floorNumber: dev.floorNumber,
        deviceUid: dev.uid,
      });
      setScreen('device-login');
    } else if (paramRole === 'saas') {
      setScreen('super-login');
    }

    const gatewayPort = getActiveGatewayPort();
    fetch(buildPortScopedPath('/api/runtime/context', gatewayPort))
      .then((r) => (r.ok ? r.json() : null))
      .then((ctx: RuntimeContextResponse | null) => {
        if (!ctx) return;
        setRuntimeInfo({
          runtimePort: ctx.currentPort,
          portRole: ctx.portRole,
          activePorts: ctx.activePorts,
        });
        // Auto-open the matching portal if this browser tab hit a dedicated Client (:3001) or SaaS (:3002) port
        if (!paramRole && params.get('autostart') !== '1') {
          if (ctx.portRole === 'client') {
            const targetUid = paramUid || ctx.assignedDeviceUid || GLOBAL_TOPOLOGY[0].uid;
            const dev = GLOBAL_TOPOLOGY.find((d) => d.uid === targetUid) ?? GLOBAL_TOPOLOGY[0];
            setWorldFocus({
              level: 'device',
              countryCode: dev.countryCode,
              cityCode: dev.cityCode,
              districtCode: dev.districtCode,
              buildingCode: dev.buildingCode,
              floorNumber: dev.floorNumber,
              deviceUid: dev.uid,
            });
            setScreen('device-login');
          } else if (ctx.portRole === 'saas') {
            setScreen('super-login');
          }
        }
      })
      .catch(() => undefined);
  }, [setRuntimeInfo, setScreen, setViewMode2D, setWorldFocus]);

  return (
    <>
      {screen === 'world' && <WorldExplorer />}
      {screen === 'device-login' && <DeviceLoginScreen />}
      {screen === 'desktop' && <Tier1Desktop />}
      {screen === 'super-login' && <SuperAdminLogin />}
      {screen === 'saas' && <Tier2SaasDashboard />}
    </>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <NexauraShell />
    </QueryClientProvider>
  );
}
