import { spawn } from 'node:child_process';
const commands = [
  ['api', ['--env-file-if-exists=.env', '--import', 'tsx', 'server/main.ts'], {}],
  ['worker', ['--env-file-if-exists=.env', '--import', 'tsx', 'server/worker.ts'], { PORT: '8788' }],
  ['web', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], {}],
];
let stopping = false;
const children = commands.map(([name, args, env]) => {
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  child.once('error', () => { console.error(`${name} could not start`); stop(1); });
  child.once('exit', code => { if (!stopping) { console.error(`${name} exited`); stop(code || 1); } });
  return child;
});
function stop(code = 0) {
  if (stopping) return; stopping = true; process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => { for (const child of children) child.kill('SIGKILL'); }, 9000).unref();
}
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
