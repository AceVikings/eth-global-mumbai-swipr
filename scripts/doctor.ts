// Offline readiness check. Prints only "configured"/"missing"/"invalid", never values.
// Usage: tsx scripts/doctor.ts [--role web|api|worker|stack] (comma-separated allowed)
import { existsSync, readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';

type Role = 'web' | 'api' | 'worker';
type Level = 'ok' | 'warn' | 'fail';

const results: { level: Level; label: string; detail: string }[] = [];
const report = (level: Level, label: string, detail: string) => results.push({ level, label, detail });

if (existsSync('.env')) process.loadEnvFile('.env');
const env = (name: string) => (process.env[name] ?? '').trim();
const has = (name: string) => env(name) !== '';
// Accept the same server-side aliases as readConfig; never print their values.
process.env.FLASH_KEY_EXEC ||= env('FLASH_API_KEY');
process.env.BASE_RPC ||= env('BASE_RPC_URL');

const arg = process.argv.find(value => value.startsWith('--role='))?.slice(7)
  ?? (process.argv.includes('--role') ? process.argv[process.argv.indexOf('--role') + 1] : undefined);
const requested = (arg && !arg.startsWith('--') ? arg : 'stack').split(',');
const roles = new Set<Role>(requested.flatMap(role => role === 'stack' ? ['web', 'api', 'worker'] as Role[] : [role as Role]));
for (const role of roles) {
  if (!['web', 'api', 'worker'].includes(role)) {
    console.error(`Unknown role "${role}". Use web, api, worker or stack.`);
    process.exit(2);
  }
}

// Provider secrets: required on the server only when APP_MODE=live.
// Arkiv variables are checked separately below.
const LIVE_SHARED = ['BASE_RPC', 'SEPOLIA_RPC', 'FLASH_KEY_EXEC', 'PRIVY_APP_ID', 'PRIVY_APP_SECRET', 'PRIVY_VERIFICATION_KEY'];
const LIVE_WORKER = ['PRIVY_KEY_QUORUM_ID', 'PRIVY_AUTHORIZATION_PRIVATE_KEY',
  'BEE_URL', 'SWARM_BATCH_ID', 'BEE_GATEWAY_URL', 'BEE_GATEWAY_2_URL'];

const major = Number(process.versions.node.split('.')[0]);
report(major === 22 ? 'ok' : 'warn', 'Node', major === 22 ? '22.x' : `${major}.x (CI and images use 22)`);

const scripts: Record<string, string> = JSON.parse(readFileSync('package.json', 'utf8')).scripts ?? {};
for (const name of ['api', 'worker', 'doctor', 'dev:stack']) {
  report(scripts[name] ? 'ok' : 'warn', `npm script ${name}`, scripts[name] ? 'present' : 'missing (host pending)');
}

const mode = env('APP_MODE') || 'live';
const serverRole = roles.has('api') || roles.has('worker');
if (serverRole) {
  report(['preview', 'live'].includes(mode) ? 'ok' : 'fail', 'APP_MODE', ['preview', 'live'].includes(mode) ? mode : 'invalid (preview|live)');

  // Arkiv is the only store. The API reads the canonical writer's entities; only the worker writes.
  if (has('DATABASE_URL')) report('warn', 'DATABASE_URL', 'set but unused (no SQL store)');
  const rpcOk = ['https:'].includes(URL.parse(env('ARKIV_RPC_URL'))?.protocol ?? '');
  report(!has('ARKIV_RPC_URL') || rpcOk ? 'ok' : 'fail', 'ARKIV_RPC_URL',
    !has('ARKIV_RPC_URL') ? 'SDK default (Rabdi)' : rpcOk ? 'configured' : 'invalid (https URL)');
  report(has('ARKIV_ACCESS_KEY') ? 'ok' : 'warn', 'ARKIV_ACCESS_KEY', has('ARKIV_ACCESS_KEY') ? 'configured' : 'missing (public RPC is rate limited)');
  const writer = env('ARKIV_WRITER_ADDRESS');
  const validWriter = /^0x[0-9a-fA-F]{40}$/.test(writer);
  report(validWriter ? 'ok' : roles.has('api') || mode === 'live' ? 'fail' : 'warn', 'ARKIV_WRITER_ADDRESS',
    validWriter ? 'configured' : writer ? 'invalid (0x address)' : roles.has('api') ? 'missing (API reads this writer)' : 'missing (worker probes only)');
  report(env('ARKIV_ENGINE_STREAM') && !/^[a-z0-9-]+$/.test(env('ARKIV_ENGINE_STREAM')) ? 'fail' : 'ok', 'ARKIV_ENGINE_STREAM',
    env('ARKIV_ENGINE_STREAM') || 'swipr-engine-v1 (default)');
  const confirmations = env('ARKIV_CONFIRMATIONS') || '2';
  const validConfirmations = /^\d+$/.test(confirmations) && Number(confirmations) >= 1 && Number(confirmations) <= 20;
  report(validConfirmations ? 'ok' : 'fail', 'ARKIV_CONFIRMATIONS', validConfirmations ? confirmations : 'invalid (integer 1-20)');
  if (roles.has('worker')) {
    if (!has('ARKIV_RELAYER_PK')) report(mode === 'live' ? 'fail' : 'warn', 'ARKIV_RELAYER_PK', 'missing (worker cannot write; reads still work)');
    else {
      let derived = '';
      try { derived = privateKeyToAccount(env('ARKIV_RELAYER_PK') as `0x${string}`).address; } catch { /* reported below */ }
      const matches = derived !== '' && derived.toLowerCase() === writer.toLowerCase();
      report(matches ? 'ok' : 'fail', 'ARKIV_RELAYER_PK', !derived ? 'invalid key' : matches ? 'configured, matches writer' : 'does not match ARKIV_WRITER_ADDRESS');
    }
  } else if (has('ARKIV_RELAYER_PK')) report('warn', 'ARKIV_RELAYER_PK', 'set for the API role; worker-only secret');

  if (roles.has('worker') && has('ARKIV_MAINTAINER_PK')) {
    let maintainer = '';
    try { maintainer = privateKeyToAccount(env('ARKIV_MAINTAINER_PK') as `0x${string}`).address; } catch { /* reported below */ }
    const separate = maintainer !== '' && maintainer.toLowerCase() !== writer.toLowerCase();
    report(separate ? 'ok' : 'fail', 'ARKIV_MAINTAINER_PK', !maintainer ? 'invalid key' : separate ? 'configured, separate account' : 'must differ from engine writer');
  } else if (has('ARKIV_MAINTAINER_PK')) report('warn', 'ARKIV_MAINTAINER_PK', 'set for API role; worker-only secret');
  else if (roles.has('worker')) report('warn', 'ARKIV_MAINTAINER_PK', 'missing (automatic journal renewal disabled)');

  const port = env('PORT') || '8787';
  const validPort = /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;
  report(validPort ? 'ok' : 'fail', 'PORT', validPort ? 'valid' : 'invalid');

  const origins = (env('ALLOWED_ORIGINS') || (env('NODE_ENV') === 'production' ? '' : 'http://127.0.0.1:5173')).split(',').map(origin => origin.trim()).filter(Boolean);
  const production = env('NODE_ENV') === 'production';
  const badOrigin = origins.some(origin => {
    try { const url = new URL(origin); return url.origin !== origin || (production && url.protocol !== 'https:'); }
    catch { return true; }
  });
  report(badOrigin ? 'fail' : 'ok', 'ALLOWED_ORIGINS', badOrigin ? 'invalid (bare origins; https when NODE_ENV=production)'
    : has('ALLOWED_ORIGINS') ? 'configured' : 'default local origins');

  const live = [...LIVE_SHARED, ...(roles.has('worker') ? LIVE_WORKER : [])];
  const missing = live.filter(name => !has(name));
  for (const name of live) {
    report(has(name) ? 'ok' : mode === 'live' ? 'fail' : 'warn', name, has(name) ? 'configured' : 'missing');
  }
  if (mode === 'preview' && missing.length < live.length) {
    report('warn', 'Live config', 'partially configured while APP_MODE=preview; nothing is live until the gates pass');
  }
}

if (roles.has('web')) {
  if (!has('VITE_API_URL')) report('warn', 'VITE_API_URL', 'missing (required for the Render build)');
  else {
    let url: URL | undefined;
    try { url = new URL(env('VITE_API_URL')); } catch { /* reported below */ }
    const local = url && ['localhost', '127.0.0.1'].includes(url.hostname);
    report(url && (url.protocol === 'https:' || local) ? 'ok' : 'fail', 'VITE_API_URL',
      url ? (url.protocol === 'https:' || local ? 'configured' : 'must be https outside localhost') : 'invalid URL');
  }
  report(has('VITE_PRIVY_APP_ID') ? 'ok' : 'warn', 'VITE_PRIVY_APP_ID', has('VITE_PRIVY_APP_ID') ? 'configured' : 'missing');
  report(existsSync('dist/index.html') ? 'ok' : 'warn', 'dist/index.html', existsSync('dist/index.html') ? 'built' : 'not built');
}

// Topology: secrets must never reach the browser bundle.
const leaked = Object.keys(process.env).filter(name =>
  name.startsWith('VITE_') && /SECRET|PRIVATE|_PK$|PASSWORD|DATABASE|QUORUM|FLASH_KEY|ACCESS_KEY|RPC/.test(name));
report(leaked.length ? 'fail' : 'ok', 'Browser-exposed secrets', leaked.length ? `forbidden: ${leaked.join(', ')}` : 'none');

const icon: Record<Level, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };
console.log(`Swipr doctor · roles: ${[...roles].join(', ')} · mode: ${mode}`);
for (const { level, label, detail } of results) console.log(`  [${icon[level]}] ${label}: ${detail}`);
const failures = results.filter(result => result.level === 'fail').length;
console.log(failures ? `${failures} blocking problem(s).` : 'No blocking problems. This is a config check, not proof that any service is live.');
process.exit(failures ? 1 : 0);
