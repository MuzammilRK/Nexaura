import { create } from 'zustand';
import type { ClusterPortBinding, PortRole, RegionCode, SessionInfo } from '../shared/schema';

export type AppScreen = 'world' | 'device-login' | 'desktop' | 'super-login' | 'saas';

export type WorldLevel =
  | 'globe'
  | 'country'
  | 'city'
  | 'district'
  | 'building'
  | 'floor'
  | 'device';

export interface WorldFocus {
  level: WorldLevel;
  countryCode: string | null;
  cityCode: string | null;
  districtCode: string | null;
  buildingCode: string | null;
  floorNumber: number | null;
  deviceUid: string | null;
}

export type DesktopAppId =
  | 'collector'
  | 'logs'
  | 'taskmgr'
  | 'eventvwr'
  | 'explorer'
  | 'terminal'
  | 'ciphershare'
  | 'browser'
  | 'industry';

interface NexauraState {
  screen: AppScreen;
  worldFocus: WorldFocus;
  viewMode2D: boolean;
  reducedEffects: boolean;
  deviceSession: SessionInfo | null;
  saasSession: SessionInfo | null;
  activeDesktopApp: DesktopAppId;
  activeSaasRegion: RegionCode;
  runtimePort: number;
  portRole: PortRole;
  activePorts: ClusterPortBinding[];
  wsConnected: boolean;
  wsLastRttMs: number | null;
  setScreen: (screen: AppScreen) => void;
  setWorldFocus: (focus: Partial<WorldFocus>) => void;
  resetWorldFocus: () => void;
  setViewMode2D: (v: boolean) => void;
  setReducedEffects: (v: boolean) => void;
  setDeviceSession: (s: SessionInfo | null) => void;
  setSaasSession: (s: SessionInfo | null) => void;
  setActiveDesktopApp: (app: DesktopAppId) => void;
  setActiveSaasRegion: (region: RegionCode) => void;
  setRuntimeInfo: (info: {
    runtimePort: number;
    portRole: PortRole;
    activePorts?: ClusterPortBinding[];
  }) => void;
  setWsState: (wsConnected: boolean, wsLastRttMs?: number | null) => void;
}

const INITIAL_FOCUS: WorldFocus = {
  level: 'globe',
  countryCode: null,
  cityCode: null,
  districtCode: null,
  buildingCode: null,
  floorNumber: null,
  deviceUid: null,
};

export const useNexauraStore = create<NexauraState>((set) => ({
  screen: 'world',
  worldFocus: INITIAL_FOCUS,
  viewMode2D: false,
  reducedEffects: false,
  deviceSession: null,
  saasSession: null,
  activeDesktopApp: 'collector',
  activeSaasRegion: 'IN',
  runtimePort: 3000,
  portRole: 'hub',
  activePorts: [],
  wsConnected: false,
  wsLastRttMs: null,
  setScreen: (screen) => set({ screen }),
  setWorldFocus: (focus) =>
    set((state) => ({ worldFocus: { ...state.worldFocus, ...focus } })),
  resetWorldFocus: () => set({ worldFocus: INITIAL_FOCUS }),
  setViewMode2D: (viewMode2D) => set({ viewMode2D }),
  setReducedEffects: (reducedEffects) => set({ reducedEffects }),
  setDeviceSession: (deviceSession) => set({ deviceSession }),
  setSaasSession: (saasSession) => set({ saasSession }),
  setActiveDesktopApp: (activeDesktopApp) => set({ activeDesktopApp }),
  setActiveSaasRegion: (activeSaasRegion) => set({ activeSaasRegion }),
  setRuntimeInfo: (info) =>
    set((state) => ({
      runtimePort: info.runtimePort,
      portRole: info.portRole,
      activePorts: info.activePorts ?? state.activePorts,
    })),
  setWsState: (wsConnected, wsLastRttMs) =>
    set((state) => ({
      wsConnected,
      wsLastRttMs: wsLastRttMs === undefined ? state.wsLastRttMs : wsLastRttMs,
    })),
}));

