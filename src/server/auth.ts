import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { RegionCode, SessionInfo, UserRole } from '../shared/schema';
import { GLOBAL_TOPOLOGY } from '../shared/topology';
import { engine } from './state';

const EPHEMERAL_SECRET = crypto.randomBytes(32).toString('hex');

function getSigningKey(): string {
  return process.env.NEXAURA_SESSION_SECRET || EPHEMERAL_SECRET;
}

interface StoredUser {
  username: string;
  passwordHash: string;
  salt: string;
  role: UserRole;
  defaultTenantId: string;
  defaultRegion: RegionCode;
  countryCode?: string;
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password: string, salt: string, expectedHex: string): boolean {
  const actual = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

const DEMO_USERS: StoredUser[] = (() => {
  const mk = (
    username: string,
    pw: string,
    role: UserRole,
    defaultTenantId: string,
    defaultRegion: RegionCode,
    countryCode?: string
  ): StoredUser => {
    const salt = crypto.randomBytes(16).toString('hex');
    return {
      username,
      salt,
      passwordHash: hashPassword(pw, salt),
      role,
      defaultTenantId,
      defaultRegion,
      countryCode,
    };
  };
  return [
    mk('operator', 'NexauraDevice!24', 'device_operator', 'tenant-in-bank-01', 'IN', 'IN'),
    mk('tenant.admin', 'NexauraTenant!24', 'tenant_admin', 'tenant-in-bank-01', 'IN', 'IN'),
    mk('admin.in', 'NexauraAdminIN!24', 'country_admin', 'all', 'IN', 'IN'),
    mk('admin.de', 'NexauraAdminDE!24', 'country_admin', 'all', 'EU', 'DE'),
    mk('admin.gb', 'NexauraAdminGB!24', 'country_admin', 'all', 'EU', 'GB'),
    mk('admin.us', 'NexauraAdminUS!24', 'country_admin', 'all', 'US', 'US'),
    mk('super.admin', 'NexauraSuper!24', 'super_admin', 'all', 'IN'),
    mk('secops.peer', 'NexauraPeer!24', 'super_admin', 'all', 'IN'),
  ];
})();

interface FailedAttemptTracker {
  count: number;
  lockedUntilMs: number;
}

const MAX_LOGIN_ATTEMPTS = 3;
const failedAttempts = new Map<string, FailedAttemptTracker>();

export function authenticateUser(params: {
  username: string;
  password: string;
  requiredRole?: UserRole | 'any_admin';
  deviceUid?: string;
  tenantId?: string;
  region?: RegionCode;
}): { session?: SessionInfo; error?: string; status: number } {
  const key = params.username.toLowerCase();
  const tracker = failedAttempts.get(key);
  const now = Date.now();
  const matchedDevice = params.deviceUid
    ? GLOBAL_TOPOLOGY.find((d) => d.uid === params.deviceUid)
    : undefined;
  const logTier = params.requiredRole ? 'tier2' : 'tier1';
  const logRegion: RegionCode = params.region ?? matchedDevice?.region ?? 'IN';
  const logTenant = params.tenantId ?? matchedDevice?.tenantId ?? 'all';

  if (tracker && tracker.lockedUntilMs > now) {
    const waitSec = Math.ceil((tracker.lockedUntilMs - now) / 1000);
    engine.recordFailedLoginAlert({
      username: key,
      tier: logTier,
      region: logRegion,
      tenantId: logTenant,
      deviceUid: matchedDevice?.uid,
      attemptCount: tracker.count,
      locked: true,
      reason: `Locked login rejected (${waitSec}s remaining).`,
    });
    return {
      status: 429,
      error: `Account temporarily locked after ${MAX_LOGIN_ATTEMPTS} failed attempts. Retry in ${waitSec}s.`,
    };
  }

  const user = DEMO_USERS.find((u) => u.username === key);
  if (!user || !verifyPassword(params.password, user.salt, user.passwordHash)) {
    const nextCount = (tracker?.count ?? 0) + 1;
    const isLockedNow = nextCount >= MAX_LOGIN_ATTEMPTS;
    failedAttempts.set(key, {
      count: isLockedNow ? 0 : nextCount,
      lockedUntilMs: isLockedNow ? now + 30_000 : 0,
    });
    engine.recordFailedLoginAlert({
      username: key,
      tier: logTier,
      region: logRegion,
      tenantId: logTenant,
      deviceUid: matchedDevice?.uid,
      attemptCount: nextCount,
      locked: isLockedNow,
      reason: isLockedNow
        ? `Account "${key}" locked for 30s after ${MAX_LOGIN_ATTEMPTS} failed sign-in attempts.`
        : `Failed sign-in attempt #${nextCount} of ${MAX_LOGIN_ATTEMPTS} for "${key}".`,
    });
    return {
      status: 401,
      error: isLockedNow
        ? `Too many failed attempts (${MAX_LOGIN_ATTEMPTS}/${MAX_LOGIN_ATTEMPTS}). Account locked for 30s and alert dispatched to server.`
        : `Invalid credentials (${MAX_LOGIN_ATTEMPTS - nextCount} attempt${MAX_LOGIN_ATTEMPTS - nextCount === 1 ? '' : 's'} remaining before lockout).`,
    };
  }

  if (params.requiredRole === 'super_admin' && user.role !== 'super_admin') {
    engine.recordFailedLoginAlert({
      username: user.username,
      tier: 'tier2',
      region: logRegion,
      tenantId: logTenant,
      attemptCount: 1,
      locked: false,
      reason: `Denied Super Admin login attempt by role "${user.role}".`,
    });
    return {
      status: 403,
      error: 'Fresh Super Admin role credentials are required to access Tier 2.',
    };
  }

  if (params.requiredRole === 'any_admin' && user.role === 'device_operator') {
    engine.recordFailedLoginAlert({
      username: user.username,
      tier: 'tier2',
      region: logRegion,
      tenantId: logTenant,
      attemptCount: 1,
      locked: false,
      reason: `Blocked device_operator "${user.username}" from elevating directly to Tier 2.`,
    });
    return {
      status: 403,
      error: 'Device operator credentials cannot elevate directly to Tier 2.',
    };
  }

  failedAttempts.delete(key);

  const expiresAtMs = now + 2 * 60 * 60 * 1000;
  const resolvedRegion: RegionCode =
    user.role === 'super_admin' ? params.region ?? user.defaultRegion : user.defaultRegion;
  const resolvedTenant =
    user.role === 'super_admin' || user.role === 'country_admin'
      ? params.tenantId ?? 'all'
      : params.tenantId ?? user.defaultTenantId;

  const payload: Omit<SessionInfo, 'token'> = {
    username: user.username,
    role: user.role,
    tenantId: resolvedTenant,
    region: resolvedRegion,
    countryCode: user.countryCode,
    deviceUid: params.deviceUid,
    expiresAtUtc: new Date(expiresAtMs).toISOString(),
  };

  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', getSigningKey()).update(encoded).digest('base64url');

  engine.recordStructuredLog({
    category: 'login_logout',
    tier: logTier,
    region: payload.region,
    tenantId: payload.tenantId,
    deviceUid: matchedDevice?.uid,
    pseudoSourceId: matchedDevice?.pseudoSourceId,
    actor: payload.username,
    action: logTier === 'tier1' ? 'DEVICE_LOGIN' : 'SAAS_LOGIN',
    severity: 'low',
    summary: `${payload.username} (${payload.role}) signed in to ${logTier === 'tier1' ? matchedDevice?.hostname ?? 'Tier 1' : `Region ${payload.region} SaaS`}.`,
  });
  engine.recordStructuredLog({
    category: 'authentication',
    tier: logTier,
    region: payload.region,
    tenantId: payload.tenantId,
    deviceUid: matchedDevice?.uid,
    pseudoSourceId: matchedDevice?.pseudoSourceId,
    actor: payload.username,
    action: 'TOKEN_ISSUED',
    severity: 'low',
    summary: `Issued HMAC-SHA256 bearer token for "${payload.username}" (scope=${payload.tenantId}, region=${payload.region}).`,
  });

  return {
    status: 200,
    session: {
      ...payload,
      token: `${encoded}.${sig}`,
    },
  };
}

export function recordLogout(session: SessionInfo, tier: 'tier1' | 'tier2'): void {
  const matchedDevice = session.deviceUid
    ? GLOBAL_TOPOLOGY.find((d) => d.uid === session.deviceUid)
    : undefined;
  engine.recordStructuredLog({
    category: 'login_logout',
    tier,
    region: session.region,
    tenantId: session.tenantId,
    deviceUid: matchedDevice?.uid,
    pseudoSourceId: matchedDevice?.pseudoSourceId,
    actor: session.username,
    action: tier === 'tier1' ? 'DEVICE_LOGOUT' : 'SAAS_LOGOUT',
    severity: 'low',
    summary: `${session.username} (${session.role}) signed out of ${tier === 'tier1' ? matchedDevice?.hostname ?? 'Tier 1' : `Region ${session.region} SaaS`}.`,
  });
  engine.recordStructuredLog({
    category: 'user_activity',
    tier,
    region: session.region,
    tenantId: session.tenantId,
    deviceUid: matchedDevice?.uid,
    pseudoSourceId: matchedDevice?.pseudoSourceId,
    actor: session.username,
    action: 'SESSION_TERMINATED',
    severity: 'low',
    summary: `Operator session closed cleanly for ${session.username}.`,
  });
}

export function verifyToken(token: string): SessionInfo | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', getSigningKey())
    .update(encoded)
    .digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionInfo;
    if (Date.parse(parsed.expiresAtUtc) < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface AuthenticatedRequest extends Request {
  session?: SessionInfo;
}

export function requireAuth(roles?: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authentication required (Bearer token missing).' });
      return;
    }
    const session = verifyToken(authHeader.slice(7).trim());
    if (!session) {
      res.status(401).json({ error: 'Session expired or invalid token.' });
      return;
    }
    if (roles && !roles.includes(session.role)) {
      res.status(403).json({ error: `Role "${session.role}" is not authorized for this resource.` });
      return;
    }
    req.session = session;
    next();
  };
}
