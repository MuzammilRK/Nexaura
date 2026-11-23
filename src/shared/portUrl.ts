export function getActiveGatewayPort(): number | null {
  if (typeof window === 'undefined') return null;

  const pathMatch = window.location.pathname.match(/^\/p\/(\d{4,5})(?:\/|$)/);
  if (pathMatch) {
    const parsed = Number(pathMatch[1]);
    if (Number.isInteger(parsed) && parsed >= 3000 && parsed <= 3099) {
      return parsed;
    }
  }

  const queryPort = new URLSearchParams(window.location.search).get('port');
  if (queryPort) {
    const parsed = Number(queryPort);
    if (Number.isInteger(parsed) && parsed >= 3000 && parsed <= 3099) {
      return parsed;
    }
  }

  return null;
}

/**
 * Generates an always-reachable URL for any active Nexaura port.
 * Routes through the active origin's `/p/<port>/` HTTP+WS gateway so multi-port
 * instances work both behind single-port Cloud Run / HTTPS ingress and locally.
 */
export function buildPortOpenUrl(port: number): string {
  if (typeof window === 'undefined') return `/p/${port}/`;
  if (port === 3000) {
    return `${window.location.origin}/`;
  }
  return `${window.location.origin}/p/${port}/`;
}

export function buildPortScopedPath(path: string, gatewayPort?: number | null): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (gatewayPort && gatewayPort >= 3001 && gatewayPort <= 3099) {
    return `/p/${gatewayPort}${cleanPath}`;
  }
  return cleanPath;
}
