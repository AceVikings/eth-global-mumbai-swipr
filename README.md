# Swipr

Swipr is a wallet-owned social copy-trading prototype. The frontend is a React, TypeScript, Tailwind, Vite PWA. The backend is an Express application and a private worker on Node.js 22. Arkiv Rabdi is the project database; there is no SQL database.

## Repository

- `frontend/`: independent package, lockfile, application, public assets, PWA build and tests.
- `backend/`: independent package, lockfile, Express API, worker, Arkiv adapters, Dockerfile and tests.
- Each package includes the wire contracts it uses. CI checks that the contract copies match, so both directories can build independently.
- `.github/workflows/ci.yml`: verification, backend image smoke tests, GitHub OIDC authentication and Cloud Run deployment.
- `infra/render.yaml` and `infra/docker-compose.yml`: service configuration.

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

After funding, the user approves the actual Arkiv write. Funding does not grant the backend permission to edit the user's records or trade from their wallet. Operational gas receipts remain platform-owned audit records.

The funding signer is the dedicated maintenance wallet and must not also send retention transactions. `ARKIV_FUNDING_START_NONCE` anchors its starting state; CI obtains it from the repository variable. Do not change that variable just to bypass a reconciliation failure.

## Delete account and data

Under **You → Delete account and data**, the user confirms the action, signs deletion of their wallet-owned Swipr records, and signs a short-lived account-deletion message. The backend checks that all linked wallets have removed their Swipr records before deleting the Privy login. Local Swipr browser storage is then cleared and the session signs out.

This removes current Swipr data and login access. It does not erase public blockchain transaction history, platform execution/gas receipts, third-party archives or someone else's records. Export the embedded wallet before deleting the account if it holds funds. A rejected transaction or remaining data prevents login deletion, and a failed login deletion can be retried.

## Deployment and credentials

Frontend: [swipr-web.onrender.com](https://swipr-web.onrender.com). Render tracks `main`, uses `frontend` as its root directory, runs `npm ci && npm run build && npm run check:bundle`, and publishes `dist`. Auto-deploy waits for checks to pass.

Backend: Google Cloud Run, project `REDACTED`, region `us-central1`. The public API serves browser/bot requests; the worker accepts only authenticated Cloud Run callers. Health and readiness are separate. A healthy process does not imply live trade execution is enabled.

GitHub uses workload identity federation, not a stored GCP service-account key. Backend credentials are GitHub Secrets and are synchronized to dedicated Secret Manager secrets after the image is built. Runtime secret access remains service-scoped; the API never receives either system wallet's private key. No credentials enter the image or frontend bundle.

Configured secret names: `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_VERIFICATION_KEY`, `FLASH_KEY_EXEC`, `ARKIV_ACCESS_KEY`, `ARKIV_RELAYER_PK`, `ARKIV_MAINTAINER_PK`, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_DEPLOY_SERVICE_ACCOUNT`. The journal signing key is stored but is not mounted merely to enable user-owned writes.

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
