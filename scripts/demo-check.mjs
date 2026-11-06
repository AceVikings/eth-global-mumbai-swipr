// Read-only live preflight. No signing, order submission, writes, or secret values.
import { spawnSync } from 'node:child_process';
import { checkBundle } from './check-bundle.mjs';
if (process.getBuiltinModule('node:fs').existsSync('.env')) process.loadEnvFile('.env');
let blocked = 0;
function gate(label, passed, detail) {
  console.log(`${passed ? 'PASS' : 'BLOCKED'}: ${label}${detail ? ` — ${detail}` : ''}`);
  if (!passed) blocked++;
}
const doctor = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/doctor.ts', '--role', 'stack'], {
  env: { ...process.env, APP_MODE: 'live' }, stdio: 'inherit',
});
gate('live configuration', doctor.status === 0);
try {
  const errors = await checkBundle();
  gate('website artifact has no known preview fixtures', errors.length === 0);
} catch { gate('website artifact', false, 'run npm run build'); }

let origin;
try {
  const value = process.env.PUBLIC_API_URL || process.env.VITE_API_URL || 'http://127.0.0.1:8787';
  const url = new URL(value);
  if (url.origin !== value.replace(/\/$/, '') || (url.protocol !== 'https:'
    && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) throw new Error();
  origin = url.origin;
} catch { gate('API origin', false, 'use a bare HTTPS origin, or HTTP localhost'); }

if (origin) {
  const probes = [
    ['/health', 'API process', v => v.ok === true],
    ['/ready', 'confirmed Arkiv journal', v => v.ok === true],
    ['/api/runtime', 'execution and verified integrations', v => v.mode === 'live' && v.tradingEnabled === true
      && Array.isArray(v.integrations) && v.integrations.length > 0 && v.integrations.every(i => i.configured === true && i.verified === true)],
    ['/api/bots', 'real bot onboarding', v => v.state === 'ready' && Array.isArray(v.profiles) && v.profiles.some(p => p.status === 'active')],
    ['/api/traders', 'verified trader directory', v => v.state === 'ready' && Array.isArray(v.traders) && v.traders.length > 0 && v.asOfBlock != null],
    ...['trader', 'copier'].map(role => [
      `/api/leaderboards?role=${role}`, `${role} verified rankings`,
      v => v.state === 'ready' && Array.isArray(v.rows) && v.rows.length > 0 && typeof v.asOf === 'string' && Number.isFinite(Date.parse(v.asOf)),
    ]),
  ];
  // Fetch independently but print in a stable order. Never echo arbitrary provider bodies.
  const results = await Promise.all(probes.map(async ([path, label, accept]) => {
    try {
      const response = await fetch(`${origin}${path}`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      const value = await response.json();
      return [label, response.ok && accept(value), response.ok ? '' : `HTTP ${response.status}`];
    } catch { return [label, false, 'unreachable or invalid response']; }
  }));
  for (const [label, passed, detail] of results) gate(label, passed, detail);
}
console.log('\nFull acceptance still requires every on-camera and off-camera beat in docs/DEMO-CHECKLIST.md, including real transaction proofs and five rehearsals.');
console.log(blocked ? `NOT DEMO READY: ${blocked} preflight gates blocked.` : 'PREFLIGHT PASSED. Full demo acceptance is not established by this command.');
process.exitCode = blocked ? 1 : 0;
