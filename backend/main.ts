import { createWalletGhosts } from './ghosts/wallet';
import { createWalletSignals } from './bots/wallet-signals';
import { createWalletDirectory } from './bots/wallet-directory';
import { createAccountService } from './account';
import { createArkivRpc } from './arkiv-rpc';
import { createWalletSocial } from './social/wallet';
import { SocialStore } from './social/store';
import { ProjectStore } from './bots/store';
import { createApi } from './api';
import { readConfig } from './config';
import { Ledger } from './ledger';
import { createArkivJournal } from './arkiv-journal';
async function main() {
const config = readConfig();
// API has no signing key: commands belong to the serialized worker.
const journal = config.arkiv.writerAddress ? createArkivJournal({ ...config.arkiv, privateKey: undefined }) : null;
const ledger = journal ? await Ledger.open(journal) : null;
const projects = journal ? new ProjectStore(journal, config.botAudience) : null;
const social = journal ? new SocialStore(journal, config.botAudience) : null;
const server = createApi({ config, ledger, projects, social,
  account: config.arkiv.accessKey ? createAccountService(config) : undefined,
  arkivRpc: config.arkiv.accessKey ? createArkivRpc(config.arkiv) : undefined,
  walletGhosts: config.arkiv.accessKey ? createWalletGhosts(config.arkiv) : undefined,
  walletSocial: config.arkiv.accessKey ? createWalletSocial(config.arkiv) : undefined,
  walletSignals: config.arkiv.accessKey ? createWalletSignals(config.arkiv) : undefined,
  walletProfiles: config.arkiv.accessKey ? createWalletDirectory(config.arkiv) : undefined });
server.listen(config.port, '0.0.0.0', () => console.log(JSON.stringify({ service: 'api', port: config.port })));
let closing = false;
const shutdown = () => {
  if (closing) return; closing = true;
  server.close(() => { void ledger?.close().finally(() => process.exit(0)); if (!ledger) process.exit(0); });
  setTimeout(() => process.exit(1), 9000).unref();
};
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

}
void main().catch(() => { console.error("API startup failed; check Arkiv configuration."); process.exitCode = 1; });
