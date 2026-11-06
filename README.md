# Swipr

React + TypeScript + Tailwind + Vite PWA, with a separate Node API/worker.
The implementation contract is in [docs/BUILD-CONTRACT.md](docs/BUILD-CONTRACT.md).

Node 22.18+ is required. Install with `npm ci`.
Run `npm run dev` to start the website.
Run `npm test`, `npm run typecheck` and `npm run build` to verify.

This initial checkout uses a permanently labeled design preview. Local ghost
preferences are persisted on this browser; no wallet or funds are required.
Live execution remains disabled until real infrastructure acceptance gates pass.
No secrets belong in VITE_ variables. Copy `.env.example` to `.env` for local setup.
