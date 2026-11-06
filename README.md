# Swipr

React + TypeScript + Tailwind + Vite PWA. This is the website-first milestone;
Node services and live provider integrations follow separately. The resolved
product decisions are in [docs/BUILD-CONTRACT.md](docs/BUILD-CONTRACT.md).

## Run locally

Node 22.18+ is required. Run `npm ci`, then `npm run dev` (localhost:5173).
Run `npm test`, `npm run typecheck` and `npm run build` to verify.
For the production PWA, run `npm exec vite preview -- --port 4173` after building.
Service-worker caching is enabled in production builds only.

## Implemented website

- Responsive portrait deck: pass, undo, ghost, horizontal swipe and vertical profile.
- Persistent free local ghosts, original start/size/expiry, removal and empty states.
- Trading-style and ghost-size preferences, Matches and account navigation.
- Copy Pass editing, local drafts, frozen review and permission acknowledgement.
- Clear unavailable wallet/quote/proof states; no invented activation or fills.
- Install manifest, local fonts/images, offline shell and offline status.

The permanently labeled design profiles are illustrative, not actual traders.
Ghost parameters are saved in this browser; performance replay awaits recorded
trades and quotes. Live trading, funding, login, matching, actual positions,
settlement and provider proofs are not connected in this milestone.

No funds move. Clearing site data removes local ghosts and drafts. Never put
secrets in VITE_ variables. `.env.example` lists future integration settings.
Portrait provenance and font licenses are in [docs/ASSETS.md](docs/ASSETS.md).
