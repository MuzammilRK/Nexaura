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
    defaultRegion: RegionCode
  ): StoredUser => {
    const salt = crypto.randomBytes(16).toString('hex');
    return {
      username,
      salt,
      passwordHash: hashPassword(pw, salt),
      role,
      defaultTenantId,
      defaultRegion,
    };
  };
  return [
    mk('operator', 'NexauraDevice!24', 'device_operator', 'tenant-in-bank-01', 'IN'),
    mk('tenant.admin', 'NexauraTenant!24', 'tenant_admin', 'tenant-in-bank-01', 'IN'),
    mk('super.admin', 'NexauraSuper!24', 'super_admin', 'all', 'IN'),
    mk('secops.peer', 'NexauraPeer!24', 'super_admin', 'all', 'IN'),
  ];
})();

interface FailedAttemptTracker {
  count: number;
  lockedUntilMs: number;
}

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
    engine.recordStructuredLog({
      category: 'authentication',
      tier: logTier,
      region: logRegion,
      tenantId: logTenant,
      deviceUid: matchedDevice?.uid,
      pseudoSourceId: matchedDevice?.pseudoSourceId,
      actor: key,
      action: 'AUTH_LOCKOUT_BLOCKED',
      severity: 'critical',
      summary: `Locked login rejected for "${key}" (${waitSec}s remaining).`,
    });
    return {
      status: 429,
      error: `Account temporarily locked after repeated failures. Retry in ${waitSec}s.`,
    };
  }

  const user = DEMO_USERS.find((u) => u.username === key);
  if (!user || !verifyPassword(params.password, user.salt, user.passwordHash)) {
    const nextCount = (tracker?.count ?? 0) + 1;
    failedAttempts.set(key, {
      count: nextCount,
      lockedUntilMs: nextCount >= 5 ? now + 30_000 : 0,
    });
    engine.recordStructuredLog({
      category: 'authentication',
      tier: logTier,
      region: logRegion,
      tenantId: logTenant,
      deviceUid: matchedDevice?.uid,
      pseudoSourceId: matchedDevice?.pseudoSourceId,
      actor: key,
      action: nextCount >= 5 ? 'AUTH_ACCOUNT_LOCKED' : 'AUTH_INVALID_CREDENTIALS',
      severity: nextCount >= 5 ? 'critical' : 'high',
      summary:
        nextCount >= 5
          ? `Account "${key}" locked for 30s after 5 invalid credential attempts.`
          : `Failed authentication attempt #${nextCount} for "${key}".`,
    });
    return {
      status: 401,
      error:
        nextCount >= 5
          ? 'Too many failed attempts. Account locked for 30s.'
          : `Invalid credentials (${5 - nextCount} attempts remaining before lockout).`,
    };
  }

  if (params.requiredRole === 'super_admin' && user.role !== 'super_admin') {
    engine.recordStructuredLog({
      category: 'authentication',
      tier: 'tier2',
      region: logRegion,
      tenantId: logTenant,
      actor: user.username,
      action: 'AUTH_ROLE_DENIED',
      severity: 'high',
      summary: `Denied Super Admin login attempt by role "${user.role}".`,
    });
    return {
      status: 403,
      error: 'Fresh Super Admin role credentials are required to access Tier 2 Regional SaaS.',
    };
  }

  if (params.requiredRole === 'any_admin' && user.role === 'device_operator') {
    engine.recordStructuredLog({
      category: 'authentication',
      tier: 'tier2',
      region: logRegion,
      tenantId: logTenant,
      actor: user.username,
      action: 'AUTH_ELEVATION_BLOCKED',
      severity: 'high',
      summary: `Blocked device_operator "${user.username}" from elevating directly to Tier 2 SaaS.`,
    });
    return {
      status: 403,
      error: 'Device operator credentials cannot elevate directly to Regional SaaS.',
    };
  }

  failedAttempts.delete(key);

  const expiresAtMs = now + 2 * 60 * 60 * 1000;
  const payload: Omit<SessionInfo, 'token'> = {
    username: user.username,
    role: user.role,
    tenantId: user.role === 'super_admin' ? params.tenantId ?? 'all' : params.tenantId ?? user.defaultTenantId,
    region: params.region ?? user.defaultRegion,
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
