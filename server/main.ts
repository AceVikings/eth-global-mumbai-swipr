import { createApi } from './api';
import { readConfig } from './config';
import { Ledger } from './ledger';
const config = readConfig();
const ledger = config.databaseUrl ? await Ledger.open(config.databaseUrl) : null;
const server = createApi({ config, ledger });
server.listen(config.port, '0.0.0.0', () => console.log(JSON.stringify({ service: 'api', port: config.port })));
let closing = false;
const shutdown = () => {
  if (closing) return; closing = true;
  server.close(() => { void ledger?.close().finally(() => process.exit(0)); if (!ledger) process.exit(0); });
  setTimeout(() => process.exit(1), 9000).unref();
};
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
