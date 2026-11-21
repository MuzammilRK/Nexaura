import { create } from 'zustand';
import type { RegionCode, SessionInfo } from '../shared/schema';

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
  | 'taskmgr'
  | 'eventvwr'
  | 'logs'
  | 'explorer'
  | 'terminal'
  | 'ciphershare'
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
  setScreen: (screen: AppScreen) => void;
  setWorldFocus: (focus: Partial<WorldFocus>) => void;
  resetWorldFocus: () => void;
  setViewMode2D: (v: boolean) => void;
  setReducedEffects: (v: boolean) => void;
  setDeviceSession: (s: SessionInfo | null) => void;
  setSaasSession: (s: SessionInfo | null) => void;
  setActiveDesktopApp: (app: DesktopAppId) => void;
  setActiveSaasRegion: (region: RegionCode) => void;
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
}));
