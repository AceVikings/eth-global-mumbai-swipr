# Authentication

Swipr signs users in with **Privy** (`@privy-io/react-auth` 3.51.3) using **Google only**. Privy creates an
embedded Ethereum wallet for users who don't have one yet. The browser code is in `src/auth/Session.tsx`.

## Configuration

| Variable | Where | Purpose |
| --- | --- | --- |
| `VITE_PRIVY_APP_ID` | web build | Privy app ID. If it is missing, `PrivyProvider` is not created and sign-in is turned off. |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_VERIFICATION_KEY` | API | Used by the server to check access tokens and look up linked wallets (`server/auth.ts`). |

Privy dashboard (the **Swipr** app): turn on Google as a login method, set embedded Ethereum wallets to
create on login, and add every deployed origin (plus `http://127.0.0.1:5173` for development) to the allowed domains.

Client config (`src/auth/Session.tsx`):

```ts
{
  loginMethods: ['google'],
  appearance: { theme: 'light', accentColor: '#6A56A4', walletChainType: 'ethereum-only' },
  embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
  defaultChain: base, supportedChains: [base],
}
```

## Interface

```tsx
import { SessionProvider, SessionPanel, useSession } from './auth/Session';

<SessionProvider><App /></SessionProvider>   // host wraps the app once

type Session = {
  configured: boolean;            // false when VITE_PRIVY_APP_ID is missing
  ready: boolean;                 // Privy has finished loading
  authenticated: boolean;
  address: `0x${string}` | null;  // checksummed linked EVM wallet, or null
  userLabel: string | null;       // Google name or email, for display only
  error: string | null;           // last login/logout/sign error, safe to show
  login(): void;                  // opens Privy's Google login
  logout(): Promise<void>;
  signMessage(message: string): Promise<{ address; signature }>;
  getAccessToken(): Promise<string | null>;
};

<SessionPanel showBalance? />     // Continue with Google / Sign out, wallet address, status, errors
```

`useSession()` throws if it is called outside `SessionProvider`. Privy hooks are only called by an internal
component that renders inside `PrivyProvider`.

## Behaviour

- **No app ID:** `configured: false` and `ready: true`. The user stays signed out, `login()` does nothing,
  `signMessage` rejects and `getAccessToken` returns `null`. There is no fallback or fake session.
- **Wallet selection:** only wallets in `user.linkedAccounts` count (EVM wallets only). This is the same list
  the server checks. The embedded Privy wallet is used first; otherwise the first linked connected wallet is used.
  `address` stays `null` until `useWallets()` is ready.
- **Signing:** calls the selected wallet's EIP-1193 provider with `personal_sign([hex(message), address])`.
  It then recovers the signer with viem and rejects the signature if the signer does not match `address`.
  It also rejects the signature if the account changed or the user signed out before signing finished.
  This means smart-contract (ERC-1271) wallets are not supported. Google sign-in creates an EOA, so this works.
- **Account changes and sign-out:** `address` and `userLabel` are derived from Privy's state on every render,
  so after sign-out or a wallet change they are reset straight away instead of showing a stale value.
- **Access tokens:** `getAccessToken()` asks Privy each time it is called. Privy refreshes tokens when needed.
  Swipr never writes the token to storage or logs it. Send it as `Authorization: Bearer <token>`.
- **Errors:** closing the login modal is not shown as an error. Messages shown to users never contain tokens or PII.

## Wallet balance (optional)

`<SessionPanel showBalance />` calls `GET {VITE_API_URL}/api/wallet?address=<address>` with the bearer token.
It expects `{ address, display }`, for example `{"address":"0x…","display":"0.0123 ETH"}`. The returned address
must match the session address. The backend should check that the wallet is linked to the signed-in user
(`requireWallet`) and read the balance on Base. Until that route exists, the panel shows "Unavailable".

## Security rules

- Private keys are never exposed or saved. Embedded wallet keys stay inside Privy.
- Swipr does not log names, emails, tokens or signatures.
- The server must check the access token and that the wallet is linked to the user. It must never trust a
  wallet address sent by the browser.
