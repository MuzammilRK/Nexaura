import { useState, type FormEvent } from 'react';
import { ArrowLeft, KeyRound, Monitor, ShieldAlert } from 'lucide-react';
import { useNexauraStore } from '../state/useNexauraStore';
import { findDeviceByUid, GLOBAL_TOPOLOGY } from '../shared/topology';
import { shortDeviceUid, shortPseudoId } from '../shared/formatters';

export function DeviceLoginScreen() {
  const { worldFocus, setScreen, setDeviceSession } = useNexauraStore();
  const selectedUid = worldFocus.deviceUid ?? GLOBAL_TOPOLOGY[0].uid;
  const device = findDeviceByUid(selectedUid) ?? GLOBAL_TOPOLOGY[0];

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!username.trim() || !password) {
      setError('Enter both operator username and password.');
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
          deviceUid: device.uid,
          tenantId: device.tenantId,
          region: device.region,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Authentication failed.');
        return;
      }
      setDeviceSession(data.session);
      setScreen('desktop');
    } catch {
      setError('Unable to reach authentication service.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col justify-center bg-[#0B0D11] px-6 py-12 text-zinc-100">
      <div className="mx-auto w-full max-w-md">
        <button
          type="button"
          onClick={() => setScreen('world')}
          className="inline-flex items-center gap-2 text-xs font-medium text-zinc-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to 3D Global World
        </button>

        <div className="mt-5 rounded-xl border border-[#222733] bg-[#12151C] p-7 shadow-2xl">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-[#2B3242] bg-[#0B0D11]">
              <Monitor className="h-5 w-5 text-blue-400" />
            </div>
            <div>
              <h1 className="font-display text-lg font-semibold text-white">Tier 1 Device Sign In</h1>
              <p className="font-mono text-xs text-blue-400" title={device.uid}>
                {shortDeviceUid(device.uid)} · {device.hostname}
              </p>
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-[#222733] bg-[#0B0D11] p-3.5 text-xs text-zinc-300">
            <div>{device.buildingName} · Floor 0{device.floorNumber}</div>
            <div className="mt-1 font-mono text-[11px] text-zinc-400" title={device.pseudoSourceId}>
              Tenant: {device.tenantId} · {shortPseudoId(device.pseudoSourceId)}
            </div>
            <div className="mt-2 border-t border-[#222733] pt-2 text-[11px] text-zinc-400">
              Device IDs and raw logs stay strictly inside this customer boundary.
            </div>
          </div>

          <form onSubmit={handleSubmit} className="mt-5 space-y-4">
            <div>
              <label htmlFor="dev-user" className="block text-xs font-medium text-zinc-300">
                Operator Username
              </label>
              <input
                id="dev-user"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="operator"
                className="mt-1.5 w-full rounded-md border border-[#2B3242] bg-[#0B0D11] px-3.5 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="dev-pass" className="block text-xs font-medium text-zinc-300">
                Password
              </label>
              <input
                id="dev-pass"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter device password"
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
              {submitting ? 'Verifying Credentials...' : 'Sign In to Device Desktop'}
            </button>
          </form>

          <div className="mt-5 rounded-lg border border-[#222733] bg-[#0B0D11] p-3.5 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-zinc-300">Demo Credentials</span>
              <button
                type="button"
                onClick={() => {
                  setUsername('operator');
                  setPassword('NexauraDevice!24');
                }}
                className="inline-flex items-center gap-1 rounded-md border border-[#2B3242] bg-[#1A1E28] px-2.5 py-1 text-[11px] font-medium text-zinc-200 hover:bg-[#232836]"
              >
                <KeyRound className="h-3 w-3" />
                Fill Credentials
              </button>
            </div>
            <div className="mt-1.5 font-mono text-[11px] text-zinc-400">
              User: <span className="text-zinc-200">operator</span> · Pass: <span className="text-zinc-200">NexauraDevice!24</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
