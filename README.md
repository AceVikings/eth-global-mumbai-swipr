# Swipr

Swipr is a wallet-owned social copy-trading prototype. The frontend is a React, TypeScript, Tailwind, Vite PWA. The backend is an Express application and a private worker on Node.js 22. Arkiv Rabdi is the project database; there is no SQL database.

## Repository

- `frontend/`: independent package, lockfile, application, public assets, PWA build and tests.
- `backend/`: independent package, lockfile, Express API, worker, Arkiv adapters, Dockerfile and tests.
- Each package includes the wire contracts it uses. CI checks that the contract copies match, so both directories can build independently.
- `.github/workflows/ci.yml`: automated verification and backend image smoke tests.

Research docs, design studies, local helper scripts, screenshots, credentials and generated builds stay local and are ignored by Git. CI rejects tracked local-only files. The README is the public setup and demo guide.

## Run locally

Use Node.js 22. Install each package separately:

```sh
npm ci --prefix frontend
npm ci --prefix backend
```

Configure `frontend/.env` with the public `VITE_PRIVY_APP_ID` and optional `VITE_API_URL`. Configure backend credentials in `backend/.env`; the backend also supports an existing root `.env`. Never put private credentials in a `VITE_*` variable.

Run in separate terminals:

```sh
npm run dev --prefix frontend
npm run api --prefix backend
PORT=8788 npm run worker --prefix backend
```

The website runs at `http://127.0.0.1:5173`. Without `VITE_API_URL`, Vite proxies API requests to port 8787. Set `WORKER_URL=http://127.0.0.1:8788` for local command forwarding.

## Data ownership and write gas

Signing in opens Privy's full login dialog. Profiles and following lists are written directly to Arkiv by the user's connected wallet. The native Arkiv `$owner` controls edits and deletion; an `owner` field in JSON is not treated as authority. The backend's read proxy keeps the service RPC access key out of the browser.

Immediately before a profile, follow or data-deletion transaction, the frontend requests gas for the authenticated user's linked wallet. Login alone never requests funding. Funding is limited to Rabdi testnet tGLM:

- Below 0.001 tGLM, top the wallet up to 0.005 tGLM.
- At most one grant per wallet and Privy account per UTC day.
- At most 0.1 tGLM in reserved grants per UTC day across the service.
- The private worker signs funding transfers using a separate nonce stream from the product journal.
- Each grant reserves its exact signed transfer on Arkiv before broadcasting. A retry replays those same bytes. Unexplained signer nonces pause funding for reconciliation.

Embedded wallets save ordinary profile and follow changes without an extra wallet popup. External wallets retain their own signing flow, and deletion still requires confirmation. Funding does not grant the backend permission to edit the user's records or trade from their wallet.

## Connect a trading bot

Bot Studio supplies the API address and MCP configuration automatically. `POST /api/bots/wallet-transaction` and the MCP tool `swipr_prepare_wallet_action` accept a public wallet, an action (`profile.upsert`, `profile.halt`, or `signal.publish`) and its data, and return an unsigned Rabdi transaction. The owner wallet signs profile changes; the registered operator signs signal transactions. Neither interface receives a private key or broadcasts for the caller.

Signals are read from native wallet-owned Arkiv records after two confirmations. The directory checks the current profile, operator and allowed asset. A copied schema, unrelated sender, halted profile or user-supplied performance claim cannot become a valid signal. Signals remain proposals and do not contribute to profit leaderboards.

## Delete account and data

Under **You → Delete account and data**, the user confirms the action, signs deletion of their wallet-owned Swipr records, and signs a short-lived account-deletion message. The backend checks that all linked wallets have removed their Swipr records before deleting the Privy login. Local Swipr browser storage is then cleared and the session signs out.

This removes current Swipr data and login access. It does not erase public blockchain transaction history, platform execution/gas receipts, third-party archives or someone else's records. Export the embedded wallet before deleting the account if it holds funds. A rejected transaction or remaining data prevents login deletion, and a failed login deletion can be retried.

## Demo rehearsal checklist

Use actual signed-in accounts and real testnet records. Do not seed invented performance or display proposed signals as fills.

- [ ] Open the website on desktop and mobile; verify the PWA shell and empty states.
- [ ] Open the full Privy login dialog and sign in.
- [ ] Start a profile write from a wallet below the gas threshold; verify a real, bounded tGLM grant.
- [ ] Decline a wallet transaction; verify that no profile/follow change appears.
- [ ] Approve a profile creation; verify its native Arkiv `$owner` is the user wallet.
- [ ] Edit and halt the profile using that wallet; confirm another wallet cannot mutate it.
- [ ] Follow and unfollow a public wallet; reload and verify the native wallet-owned list.
- [ ] Verify trader/copier leaderboard filters and percentage/absolute sorting. Empty verified history must stay empty.
- [ ] Delete account and data; confirm the wallet's records disappear before the Privy login is removed.
- [ ] Sign in again and verify the deleted profile/following list does not return.
- [ ] Check transaction history: deletion does not pretend to erase historical chain activity.

These are acceptance steps requiring real user wallet approvals; passing unit tests is not a substitute for rehearsal.

## Verification and remaining execution work

```sh
npm run typecheck --prefix frontend
npm test --prefix frontend
npm run build --prefix frontend
npm run check:bundle --prefix frontend
npm run typecheck --prefix backend
npm test --prefix backend
```

The app does not fabricate fills or leaderboard results. Automatic copy execution, scoped trade delegation, verified Flash settlements, ENS contracts and Swarm archival acceptance remain separate execution milestones. A successful login or Arkiv write does not enable automatic trading.
