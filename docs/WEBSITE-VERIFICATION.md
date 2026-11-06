# Website verification — 6 November 2026

Website-first scope: React/TypeScript/Tailwind/Vite PWA. No provider credentials,
transactions, live identities or real financial results are claimed here.

## Local checks

- Clean `npm ci`: succeeds; npm reports zero vulnerabilities.
- `npm test`: 35 tests covering original ghost parameters, corrupt/blocked storage,
  expiry, clock rollback, concurrent stores, deletion, session-only recovery,
  rendered portfolio disclosures and generated service-worker boundaries.
- `npm run build`: TypeScript and production Vite build pass.
- No lint command is configured.

## Browser checks

Chromium, exercised using local browser automation against dev and production:

- 390×844 portrait/name and fixed decisions visible; 320px has no horizontal overflow.
- 1440×1000 desktop nav, single-card deck, profile rail and decisions visible.
- Pass advances; Undo restores; horizontal swipe starts a ghost; vertical scroll
  reads the profile. Reload preserves the original ghost parameters.
- Proof dialog opens; Escape dismisses and focus returns to its opener.
- $60 pass amount rejected; $25 ×5 yields $125; local draft saves; terms freeze
  for review; acknowledgement leads to an explicit unconnected wallet state.
- Two tabs preserve Alice and Dan, refresh their ghost count, and do not resurrect
  a ghost explicitly removed elsewhere. Browser Web Locks serialize changes.
- Production offline reload restores shell, portraits, fonts, local ghost data
  and an offline status message. No APIs or wallet requests are cached.
- Final browser pass reports no JavaScript errors.

Saved browser reports, screenshots and review receipts are in gitignored `.context/`.
Tests are not proof of external provider integration, signing policy enforcement,
mainnet fills, archive integrity or a production deployment.

## Limits

Profiles are labeled design fixtures. Ghosts currently save simulation parameters;
PnL awaits verified trades and fresh quotes. Auth, funding, seats, ENS minting,
copy orders, settlement and provider proofs are deliberately unavailable.

Where Web Locks are unavailable, each ghost change still reads storage immediately
before writing, but simultaneous cross-tab writes cannot be fully serialized.
The installed PWA and a browser tab share storage only on the same origin.
