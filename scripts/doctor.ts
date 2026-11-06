// Offline readiness check. Prints only "configured"/"missing"/"invalid", never values.
// Usage: tsx scripts/doctor.ts [--role web|api|worker|stack] (comma-separated allowed)
import { existsSync, readFileSync } from 'node:fs';

type Role = 'web' | 'api' | 'worker';
type Level = 'ok' | 'warn' | 'fail';

const results: { level: Level; label: string; detail: string }[] = [];
const report = (level: Level, label: string, detail: string) => results.push({ level, label, detail });

if (existsSync('.env')) process.loadEnvFile('.env');
const env = (name: string) => (process.env[name] ?? '').trim();
const has = (name: string) => env(name) !== '';

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
const LIVE_SHARED = ['BASE_RPC', 'SEPOLIA_RPC', 'FLASH_KEY_EXEC', 'PRIVY_APP_ID', 'PRIVY_APP_SECRET', 'PRIVY_VERIFICATION_KEY',
  'ARKIV_ACCESS_KEY'];
const LIVE_WORKER = ['PRIVY_KEY_QUORUM_ID', 'PRIVY_AUTHORIZATION_PRIVATE_KEY', 'ARKIV_RELAYER_PK',
  'BEE_URL', 'SWARM_BATCH_ID', 'BEE_GATEWAY_URL', 'BEE_GATEWAY_2_URL'];

const major = Number(process.versions.node.split('.')[0]);
report(major === 22 ? 'ok' : 'warn', 'Node', major === 22 ? '22.x' : `${major}.x (CI and images use 22)`);

const scripts: Record<string, string> = JSON.parse(readFileSync('package.json', 'utf8')).scripts ?? {};
for (const name of ['api', 'worker', 'doctor', 'dev:stack']) {
  report(scripts[name] ? 'ok' : 'warn', `npm script ${name}`, scripts[name] ? 'present' : 'missing (host pending)');
}

const mode = env('APP_MODE') || 'preview';
const serverRole = roles.has('api') || roles.has('worker');
if (serverRole) {
  report(['preview', 'live'].includes(mode) ? 'ok' : 'fail', 'APP_MODE', ['preview', 'live'].includes(mode) ? mode : 'invalid (preview|live)');

  if (!has('DATABASE_URL')) report('fail', 'DATABASE_URL', 'missing');
  else {
    let protocol = '';
    try { protocol = new URL(env('DATABASE_URL')).protocol; } catch { /* reported below */ }
    report(['postgres:', 'postgresql:'].includes(protocol) ? 'ok' : 'fail', 'DATABASE_URL',
      protocol ? `configured (${protocol.replace(':', '')})` : 'invalid URL');
  }

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
