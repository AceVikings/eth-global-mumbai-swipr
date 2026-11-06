# Swipr build contract

Authority: the research project's SPEC.md, current design/VISUAL-GUIDE.md and
this checkout's spec-mockup-demo review. This document resolves the conflicts
accepted on 6 November 2026.

## Stack
React + TypeScript + Tailwind + Vite PWA; separate Node/TypeScript API and worker.
Privy email/embedded EOA, wagmi/viem, Flash Base mainnet, ENSv2/ERC-8004 Sepolia,
Arkiv Rabdi and Swarm remain the intended integrations. Secrets stay server-side.

## Product decisions
- Right swipe starts a free local ghost. Left skips. Star opens pass setup.
- Freeze terms before the seat request. Acceptance/mint precedes a distinct
  wallet permission review and activation. Pending and unavailable are honest states.
- Tap-copy is the default; auto requires an explicit choice and verified signer gate.
- Pass amount $5–50, count 1–20, duration 1/7/30 days. Default $10 × 5, seven days.
- Separate wallet allowance from cumulative per-pass entry budget. Atomically reserve
  pending entries, count partial spend, release only reconciled unfilled remainder.
  Never reset a ledger when approval changes or a personal index is deleted.
- Drawdown peak is the best marked PnL. Fee baseline is prior settled realized net
  profit for the relationship, carried through renewals. Charge 5% (configurable
  0–10%) on incremental realized net profit above that baseline, only on settlement;
  fees below $0.05 are waived. Unrealized gains never incur a settled share.
- Sell only remaining attributed units in the engine, bounded by wallet balance.
  Signer asset rules alone may allow selling all wallet WETH/cbBTC; disclose that
  actual scope rather than promising a pass-scoped onchain restriction.
- A breakup threshold pauses new entries; liquidation needs explicit prior consent.
  It is not a guaranteed loss ceiling. Exit/protection lasts until pass expiry +7d;
  keeping assets beyond that requires renewed protection or manual management.
- Shared exit submission does not guarantee atomic or identical fills. Show actual
  wallet execution, partial failures, delayed exits and manual recovery.
- Cash-out: pause entries, cancel entries, cancel brackets, reconcile attributed
  holdings, sell remainder, reconcile receipts, settle fees, end follow. Never mark
  completed from an optimistic timer or after one successful wallet/order.
- Ghosts store original start, selected open signal, quote/notional/fees and replay
  assumptions; no records means no fabricated return. Unavailable data is not zero.
- Rankings/caps use verified execution facts, not user-editable copy/follow indexes.
- Static social cards show timestamp/expiry. Landing pages calculate remaining time.
- Required offline demo: manually flush/verify archive before switching gateway;
  spectator/replay works offline, signing and workers require their real services.

## Implementation and verification
Build the website first in parallel: discovery, local ghosts and Copy Pass review.
Provider adapters and financial execution follow this milestone. Keep preview fixtures permanently labeled; live mode starts empty until
verified data is configured. Never manufacture fills, identity badges or proofs.
Provider credentials, onchain deployment, real fills, signer policy enforcement,
Bee setup/BMT and archive recovery are separate live acceptance gates. An installed
SDK or a configured environment variable does not pass those gates.

Each commit contains fewer than 1,000 added + removed lines. Host owns integration,
verification and commits. Workers own disjoint files and return verification evidence.
