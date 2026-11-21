import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useNexauraStore } from './state/useNexauraStore';
import { WorldExplorer } from './components/WorldExplorer';
import { DeviceLoginScreen } from './components/DeviceLoginScreen';
import { Tier1Desktop } from './components/Tier1Desktop';
import { SuperAdminLogin } from './components/SuperAdminLogin';
import { Tier2SaasDashboard } from './components/Tier2SaasDashboard';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 2500,
    },
  },
});

function NexauraShell() {
  const {
    screen,
    setWorldFocus,
    setScreen,
    setViewMode2D,
  } = useNexauraStore();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('autostart') === '1') {
      setWorldFocus({
        level: 'device',
        countryCode: 'IN',
        cityCode: 'BLR',
        districtCode: 'D02',
        buildingCode: 'B07',
        floorNumber: 3,
        deviceUid: 'IN-KA-BLR-D02-B07-F03-W014-X',
      });
      setScreen('device-login');
    }
    if (params.get('mode') === '2d') {
      setViewMode2D(true);
    }
  }, [setScreen, setViewMode2D, setWorldFocus]);

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
