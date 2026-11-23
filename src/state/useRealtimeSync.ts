import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNexauraStore } from './useNexauraStore';
import { getActiveGatewayPort } from '../shared/portUrl';

interface WsEventPayload {
  type: string;
  port?: number;
  deviceUid?: string;
  region?: string;
  tenantId?: string;
  siteId?: string;
  clientTs?: number;
  timestampUtc?: string;
}

interface NetworkInfoLike {
  downlink?: number;
}

export function useRealtimeSync() {
  const queryClient = useQueryClient();
  const { portRole, runtimePort, deviceSession, setWsState } = useNexauraStore();
  const deviceUid = deviceSession?.deviceUid;
  const activeUidRef = useRef<string | undefined>(deviceUid);
  activeUidRef.current = deviceUid;
  const gatewayPort = getActiveGatewayPort();
  const effectivePort = gatewayPort ?? runtimePort;

  useEffect(() => {
    let closedByCleanup = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let pingTimer: number | null = null;
    let attempt = 0;

    const connect = () => {
      if (closedByCleanup) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const uidQuery = activeUidRef.current ? `&uid=${encodeURIComponent(activeUidRef.current)}` : '';
      const portQuery = `&targetPort=${encodeURIComponent(String(effectivePort))}`;
      const url = `${protocol}//${window.location.host}/ws?role=${encodeURIComponent(portRole)}${portQuery}${uidQuery}`;

      try {
        ws = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }

      ws.onopen = () => {
        attempt = 0;
        setWsState(true);
        ws?.send(JSON.stringify({ type: 'ping', clientTs: performance.now() }));

        if (pingTimer !== null) window.clearInterval(pingTimer);
        pingTimer = window.setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping', clientTs: performance.now() }));
          }
        }, 4500);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as WsEventPayload;

          if (msg.type === 'pong' && typeof msg.clientTs === 'number') {
            const rttMs = Number(Math.max(0.5, performance.now() - msg.clientTs).toFixed(1));
            setWsState(true, rttMs);

            // Feed real browser latency & link estimate into active Tier 1 client device
            if (activeUidRef.current && ws?.readyState === WebSocket.OPEN) {
              const nav = navigator as Navigator & { connection?: NetworkInfoLike };
              const bwMbps =
                typeof nav.connection?.downlink === 'number' && nav.connection.downlink > 0
                  ? nav.connection.downlink
                  : undefined;

                ws.send(
                JSON.stringify({
                  type: 'client:telemetry',
                  deviceUid: activeUidRef.current,
                  latencyMs: rttMs,
                  bandwidthMbps: bwMbps,
                  source: `browser:${effectivePort}`,
                })
              );
            }
            return;
          }

          if (msg.type === 'telemetry:tick') {
            queryClient.invalidateQueries({ queryKey: ['collector-device'] });
            queryClient.invalidateQueries({ queryKey: ['saas-dashboard'] });
            queryClient.invalidateQueries({ queryKey: ['world-topology'] });
            return;
          }

          if (
            msg.type === 'device:updated' ||
            msg.type === 'infra:updated' ||
            msg.type === 'incident:updated' ||
            msg.type === 'policy:updated' ||
            msg.type === 'transfer:created'
          ) {
            queryClient.invalidateQueries({ queryKey: ['collector-device'] });
            queryClient.invalidateQueries({ queryKey: ['saas-dashboard'] });
            queryClient.invalidateQueries({ queryKey: ['world-topology'] });
            queryClient.invalidateQueries({ queryKey: ['structured-logs'] });
            return;
          }

          if (msg.type === 'logs:created') {
            queryClient.invalidateQueries({ queryKey: ['structured-logs'] });
            queryClient.invalidateQueries({ queryKey: ['collector-device'] });
            queryClient.invalidateQueries({ queryKey: ['saas-dashboard'] });
            return;
          }

          if (msg.type === 'ports:updated') {
            queryClient.invalidateQueries({ queryKey: ['cluster-ports'] });
            queryClient.invalidateQueries({ queryKey: ['collector-device'] });
            queryClient.invalidateQueries({ queryKey: ['saas-dashboard'] });
            return;
          }

          if (msg.type === 'sites:updated') {
            queryClient.invalidateQueries({ queryKey: ['hosted-websites'] });
            queryClient.invalidateQueries({ queryKey: ['collector-device'] });
            queryClient.invalidateQueries({ queryKey: ['saas-dashboard'] });
          }
        } catch {
          // ignore unparseable frames
        }
      };

      ws.onclose = () => {
        setWsState(false);
        if (pingTimer !== null) {
          window.clearInterval(pingTimer);
          pingTimer = null;
        }
        scheduleReconnect();
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    const scheduleReconnect = () => {
      if (closedByCleanup || reconnectTimer !== null) return;
      const delayMs = Math.min(5000, 600 * Math.pow(1.4, attempt++));
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delayMs);
    };

    connect();

    return () => {
      closedByCleanup = true;
      if (pingTimer !== null) window.clearInterval(pingTimer);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      ws?.close();
      setWsState(false);
    };
  }, [effectivePort, portRole, queryClient, setWsState]);
}
