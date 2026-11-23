import { useState, type FormEvent } from 'react';
import { ArrowLeft, KeyRound, ShieldCheck, ShieldAlert } from 'lucide-react';
import { useNexauraStore } from '../state/useNexauraStore';
import type { RegionCode } from '../shared/schema';

export function SuperAdminLogin() {
  const { setScreen, setSaasSession, setActiveSaasRegion, activeSaasRegion } = useNexauraStore();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [region, setRegion] = useState<RegionCode>(activeSaasRegion);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!username.trim() || !password) {
      setError('Enter administrator username and password.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: username.trim(),
          password,
          requiredRole: 'any_admin',
          region,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Authentication failed.');
        return;
      }
      setSaasSession(data.session);
      setActiveSaasRegion(region);
      setScreen('saas');
    } catch {
      setError('Unable to reach Regional SaaS authentication endpoint.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#080B12] px-6 py-12 text-zinc-100">
      <img
        src="/assets/aistudio/abstract-hexagon-pattern-background_107791-34743_339bb4c5.jpg"
        alt=""
        aria-hidden="true"
        className="animate-hex-pulse pointer-events-none absolute inset-0 h-full w-full object-cover"
      />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-[#080C15]/75 via-[#080C15]/60 to-[#06080E]/92" />

      <div className="relative z-10 w-full max-w-lg">
        <button
          type="button"
          onClick={() => setScreen('world')}
          className="inline-flex items-center gap-2 rounded-md border border-[#2B3242] bg-[#12151C]/95 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:text-white"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Return to 3D World
        </button>

        <div className="mt-4 rounded-xl border border-[#293040] bg-[#12151C]/95 p-8 shadow-2xl">
          <div className="flex items-center justify-between gap-4 border-b border-[#222733] pb-5">
            <div>
              <p className="text-xs font-medium text-blue-400">
                Nexaura Regional Control Plane
              </p>
              <h1 className="mt-1 font-display text-2xl font-semibold text-white">
                Tier 2 Admin & Super Admin Sign In
              </h1>
            </div>
            <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-[#2B3242] bg-[#0B0D11] text-blue-400">
              <ShieldCheck className="h-6 w-6" />
            </div>
          </div>

          <p className="mt-4 text-xs leading-relaxed text-zinc-400">
            Fresh authentication required. Super Admins oversee multi-country operations and grant privileges, while Country Admins manage assigned devices inside their own country.
          </p>

          <form onSubmit={handleSubmit} className="mt-5 space-y-4">
            <div>
              <label htmlFor="saas-region" className="block text-xs font-medium text-zinc-300">
                Target Regional Store
              </label>
              <select
                id="saas-region"
                value={region}
                onChange={(e) => setRegion(e.target.value as RegionCode)}
                className="mt-1.5 w-full rounded-md border border-[#2B3242] bg-[#0B0D11] px-3.5 py-2.5 text-sm text-white focus:border-blue-500 focus:outline-none"
              >
                <option value="IN">IN — India Regional Store (Mumbai / Bengaluru)</option>
                <option value="EU">EU — Europe Regional Store (Frankfurt / London)</option>
                <option value="US">US — North America Regional Store (Virginia / SFO)</option>
              </select>
            </div>

            <div>
              <label htmlFor="admin-user" className="block text-xs font-medium text-zinc-300">
                Administrator Username
              </label>
              <input
                id="admin-user"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="super.admin or admin.in"
                className="mt-1.5 w-full rounded-md border border-[#2B3242] bg-[#0B0D11] px-3.5 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="admin-pass" className="block text-xs font-medium text-zinc-300">
                Password
              </label>
              <input
                id="admin-pass"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter administrator password"
                className="mt-1.5 w-full rounded-md border border-[#2B3242] bg-[#0B0D11] px-3.5 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:border-blue-500 focus:outline-none"
              />
            </div>

            {error && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300"
              >
                <ShieldAlert className="h-4 w-4 shrink-0 text-rose-400" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-60 transition-colors"
            >
              {submitting ? 'Authenticating Regional Session...' : 'Enter Tier 2 Regional SaaS'}
            </button>
          </form>

          <div className="mt-5 space-y-2.5 rounded-lg border border-[#222733] bg-[#0B0D11] p-3.5 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-zinc-300">Quick-Fill Accounts</span>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setUsername('super.admin');
                    setPassword('NexauraSuper!24');
                  }}
                  className="inline-flex items-center gap-1 rounded border border-[#2B3242] bg-[#1A1E28] px-2 py-1 text-[11px] font-medium text-zinc-200 hover:bg-[#232836]"
                >
                  <KeyRound className="h-3 w-3" />
                  Super Admin
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setUsername('secops.peer');
                    setPassword('NexauraPeer!24');
                  }}
                  className="inline-flex items-center gap-1 rounded border border-[#2B3242] bg-[#1A1E28] px-2 py-1 text-[11px] font-medium text-zinc-200 hover:bg-[#232836]"
                >
                  Peer SecOps
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setUsername('admin.in');
                    setPassword('NexauraAdminIN!24');
                    setRegion('IN');
                  }}
                  className="inline-flex items-center gap-1 rounded border border-[#2B3242] bg-[#1A1E28] px-2 py-1 text-[11px] font-medium text-zinc-200 hover:bg-[#232836]"
                >
                  Admin (IN)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setUsername('admin.de');
                    setPassword('NexauraAdminDE!24');
                    setRegion('EU');
                  }}
                  className="inline-flex items-center gap-1 rounded border border-[#2B3242] bg-[#1A1E28] px-2 py-1 text-[11px] font-medium text-zinc-200 hover:bg-[#232836]"
                >
                  Admin (DE)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setUsername('admin.gb');
                    setPassword('NexauraAdminGB!24');
                    setRegion('EU');
                  }}
                  className="inline-flex items-center gap-1 rounded border border-[#2B3242] bg-[#1A1E28] px-2 py-1 text-[11px] font-medium text-zinc-200 hover:bg-[#232836]"
                >
                  Admin (UK)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setUsername('admin.us');
                    setPassword('NexauraAdminUS!24');
                    setRegion('US');
                  }}
                  className="inline-flex items-center gap-1 rounded border border-[#2B3242] bg-[#1A1E28] px-2 py-1 text-[11px] font-medium text-zinc-200 hover:bg-[#232836]"
                >
                  Admin (US)
                </button>
              </div>
            </div>
            <div className="space-y-0.5 font-mono text-[11px] text-zinc-400">
              <div>super.admin / NexauraSuper!24 · secops.peer / NexauraPeer!24 (Super Admin)</div>
              <div>admin.in / NexauraAdminIN!24 (India Admin · Requests Super Admin grants)</div>
              <div>admin.de / NexauraAdminDE!24 · admin.gb / NexauraAdminGB!24 (EU Country Admins)</div>
              <div>admin.us / NexauraAdminUS!24 · tenant.admin / NexauraTenant!24</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
