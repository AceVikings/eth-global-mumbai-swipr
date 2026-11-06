# Swipr demo and submission checklist

Source: research `DEMO.md`, `SPEC.md`, `arkiv/schema.md`, `arkiv/swarm.md`, and
[BUILD-CONTRACT.md](BUILD-CONTRACT.md). Status as of 6 November 2026.

**Status key**
- **WEB ✓** — website behaviour verified locally with labeled preview fixtures
  ([WEBSITE-VERIFICATION.md](WEBSITE-VERIFICATION.md)). Not a live result.
- **LOCAL ✓** — implemented and verified locally; evidence in [INFRASTRUCTURE.md](INFRASTRUCTURE.md).
- **PENDING** — implementation or remote verification still required.
- **BLOCKED** — also needs provider credentials and/or funds (Base USDC/ETH,
  Sepolia ETH, tGLM, sBZZ, Privy, Flash, Arkiv, Bee). Check each gate below; configured adapters alone do not pass live acceptance.

A row turns ✓ only with its evidence linked from the README proofs. An installed
SDK, a configured variable or a passing unit test is not evidence. Nothing on
camera is mocked, hard-coded or pre-recorded; ⏩ marks cut waits with real time.

## 0. Infrastructure gates (before any live row)

| Item | Evidence | Status |
|---|---|---|
| CI green on Node 22 (install, typecheck, in-memory Arkiv adapter tests, build, doctor, image build) | Actions run URL | PENDING (workflow written, never run) |
| Arkiv is the sole store; no SQL instance | No PostgreSQL/Cloud SQL in infra, CI or compose | ✓ config; no SQL resource was ever created |
| Arkiv journal, nonce fence, single-flight writer | Host tests (in-memory adapter) | LOCAL ✓ unit/contract tests with doubles; funded chain acceptance pending |
| Arkiv confirmed read | Configured writer query, anchor confirmation, stable nonce/hash and contiguous history checks | PENDING |
| Arkiv confirmed write | Worker tx hash, then that entity in a confirmed read | BLOCKED (project writer key/address/funding not configured or verified) |
| Arkiv renewal, expired-history recovery | Separate maintenance account; verified extension tx; archive restore drill | Renewal LOCAL ✓ with doubles; funded renewal and recovery BLOCKED |
| Execution time and receipt gates | Fresh pass/lease checks before signing; terminal receipt verification before hold release | BLOCKED; financial routes remain 503 |
| Local stack: API `/ready` + worker `/health` (8787/8788) | Responses | Unconfigured API verified: /health 200, /ready 503; funded runtime and Docker pending |
| Cloud Run API + worker deployed to the confirmed project | Revision ids, `/health` + `/ready` responses | PENDING; ethonline-476311, us-central1; separate swipr-api/swipr-worker SAs planned |
| Render static site serving the deck with `VITE_API_URL` | Public URL, commit sha | PENDING |
| `npm run doctor -- --role stack` clean in `live` mode | Doctor output (configured/missing only) | BLOCKED; cloud probes use /health and /ready |
| Auth and wallet ownership boundary | Signed ES256 JWT expiry/audience/signature tests; private routes fail closed | LOCAL ✓; actual Privy login not verified |
| Flash quote and transport | Live quote id 289d8fb0-264b-4405-85c3-4104a9fbb82c, 2026-11-06T06:53:03Z; no signature/order | Read-only quote LIVE ✓; fills BLOCKED |
| Base receipt/notary decoder; Bee archive transport | Adapter boundary tests | LOCAL ✓; sealed notary/BMT/gateways BLOCKED |

## 1. Pre-demo state (all real, linked)

| Item | Evidence | Status |
|---|---|---|
| `swipr.eth`, R_root/P_root; traders + agents onboarded (Sepolia) | Tx hashes, addresses | BLOCKED |
| R_root emancipated at H12; `ops.unregister(alice)` mined status 0 | Tx + revert reason | BLOCKED |
| ~22 h sealed trading by disclosed team/invited traders; ≥ 10–12 traders | `swipr.trade.v1` keys, Basescan | BLOCKED |
| 5–8 team copier wallets with passes; Carol on auto-copy | `swipr.follow.v1`, ENS pass names | BLOCKED |
| Real stop-trigger fill from H12 | Flash order id, Basescan | BLOCKED |
| Carol's earlier pass cashed out +$1.20, real $0.06 USDC to Alice | Transfer tx, `swipr.settle.v1` | BLOCKED |
| Outside-Swipr drill: WETH moved out → watch exited every copy | `swipr.exit.v1 {mode: outside-watch}` | BLOCKED |
| Teammate ghost on Alice since 14:02 | `swipr.ghost.v1` | BLOCKED (local ghost: WEB ✓) |
| Dave's pass revoked by a real `unregister` | Sepolia tx | BLOCKED |
| League `swipr.league.v1` since H8, expiring H30 | Entity key + expiry | BLOCKED |
| Open notary opt-in (other team or labeled teammate); hourly statsnaps | `swipr.optin.v1`, `swipr.statsnap.v1` | BLOCKED |
| Bob: Privy wallet, $50 USDC + gas drip, disclosed "pre-funded" | Basescan balance, on-screen label | BLOCKED |
| Fan-out p50/p95 in and out; 5 rehearsals ≤ 2:45 | Timing JSON | BLOCKED |

## 2. On camera (2:45 target)

| Time | Beat | Evidence | Status |
|---|---|---|---|
| 0:00 | Hook: Tinder card stack, card flies right | Screen | WEB ✓ (fixture deck) |
| 0:05 | Alice Buy now limit + bracket; auto-copies in one fan-out; `@swipr_trades` post | Flash ids, X post | BLOCKED |
| 0:12 | X card → profile (ENS ✓, copier stats, seats); swipe right → ghost; teammate ghost PnL | Arkiv query, sealed trades | UI WEB ✓ (fixtures, no PnL); live BLOCKED |
| 0:21 | ⭐ seat request → match key accepts → "It's a match 🔥" → Copy Pass confirm ($50 allowance + exit-only key) | `register` tx from match key, Base approve, Arkiv follow | Pass setup/review WEB ✓; mint/approve BLOCKED |
| 0:32 | Tap-copy push → re-quote, sign, fill at Alice's price; ⏩ timer | Bob's Basescan fill, bracket ids | BLOCKED |
| 0:43 | Cut: earlier stop-trigger fill | Trigger fill ids | BLOCKED |
| 0:48 | Price rail: all fills ≤ P; unfilled at $0; Dave skipped via ENS; fee counter | Flash ids, `swipr.signal.v1`, skip reason | BLOCKED |
| 1:04 | Alice Close → shared exit fan-out, no tap; unmatch 💔 with waived fee; outside-watch cut | Sell ids, `swipr.exit.v1` | BLOCKED |
| 1:18 | `bob.alice.swipr.eth` on ENS app; Forever ✓ revert | Sepolia name + tx | BLOCKED |
| 1:33 | Agent Charter: scripted injection → mandate write mined status 0; momo fills; halted copies skipped | Halt tx, revert, fill, skip row | BLOCKED |
| 1:56 | Open notary: external bot card; Bob copies $10 | Opt-in, sealed trade, fill | BLOCKED |
| 2:05 | Servers off: app from our Swarm gateway, BMT ✓, deck + ghost from Arkiv, statsnaps, archive, `verify-stats --from-swarm` | App ref, archive ref, ENS record | Offline shell WEB ✓; Swarm/Arkiv BLOCKED |
| 2:31 | League + `reach-count.mjs` off Arkiv; close line | Raw Arkiv reads | BLOCKED |

Fallbacks (said aloud, never faked): no Privy signer → taps + "close yours?"
push; slow fill → WebSocket rail ⏩; slow Sepolia → match sent on Super Like;
price runs → Bob is the unfilled row; no external team → labeled teammate swap.
Cut order: stop-trigger cut-in, teammate ghost, reach-count, notary copy.

## 3. Verified off camera (linked from README proofs)

| Item | Status |
|---|---|
| First run: email login, card/QR funding, ~$0.03 gas drip | BLOCKED |
| Hour-1 Privy gate: entry ALLOW, exit sell ALLOW, buy DENY, 3 DENY cases, USDC allowlist, late-deadline exit | BLOCKED |
| Auto-copy upgrade; breakup stop; cash-out with market sell + settlement | BLOCKED |
| Partial close pro rata; exit re-send "after Alice"; cancel cascade | BLOCKED |
| DCA as one limit; stop-buy breakout; safety net replacing a missing stop | BLOCKED |
| Ghost migration localStorage → `swipr.ghost.v1` at login | Local ghosts WEB ✓; migration BLOCKED |
| Followers-only thesis unlock; `check-no-encrypted-refs.mjs` | BLOCKED |
| Referrals by channel; reach + League snapshots; sponsored-wallet list | BLOCKED |
| 10-copy fan-out p50/p95 | BLOCKED |
| Scorekeeper EAC revert; emancipation rehearsal; ERC-8004 per agent; momo match policy | BLOCKED |
| Independent auditors (`verify-stats --publish`); `trader-ticker.mjs` | BLOCKED |
| Swarm artifacts via both gateways, BMT verified; user-signed unfollow/renew | BLOCKED |
| Website: deck, undo, swipe/scroll, proof dialog, pass limits, terms freeze, two-tab ghosts, offline reload | WEB ✓ |

## 4. Submission

| Item | Evidence | Status |
|---|---|---|
| Video ≤ 3:00 on X tagging @DefinitiveFi + Definitive Discord | Post URLs | BLOCKED (depends on §2) |
| ETHGlobal showcase: live URL, Swarm app URL, public MIT repo | Showcase page | PENDING (no live URL yet) |
| Arkiv + Swarm bonus selected | Showcase form | PENDING |
| `pnpm proofs` (npm equivalent) fills README, `swarm.md`, `reach.md` with raw JSON | Committed JSON | PENDING |
| Arkiv MCP `check_submission`; `check-no-encrypted-refs.mjs` | Output | BLOCKED |
| Swarm postage batch TTL ≥ 4 weeks; both gateways up ≥ 4 weeks | Batch id, uptime URL | BLOCKED |
| Docs truthful: preview fixtures labeled, unavailable ≠ zero, no claimed live setup | Review | WEB ✓ for website; re-check at submission |

## 5. Social app and bot integration additions

| Item | Evidence | Status |
|---|---|---|
| Trader and copier leaderboard, Everyone / Following, percentage / dollar sort | Ranking unit tests and HTTP contract tests | LOCAL ✓; live fill reader PENDING |
| Profit definition: closed net proceeds minus entry cost, fees and profit share; weighted by entry cost | Bigint ranking tests | LOCAL ✓; ghosts and proposals excluded |
| Social follow/unfollow independent of paid Copy Pass | Signed EIP-191 real-wallet test fixtures, Arkiv journal double | LOCAL ✓; funded Arkiv write BLOCKED |
| Simpler leaderboard visual direction | LEADERBOARD-DESIGN.md; user selection | PENDING: image-first redesign requested |
| Trader-owned bot profile, operator proposals, REST + MCP | Bot domain, gateway and HTTP contract tests | LOCAL ✓; funded registry write BLOCKED |
| Google login app and EVM wallet configuration | Swipr Privy development app, local origins configured | Configured; real app login PENDING |
| Clean install, TypeScript, tests, production build | Local logs under .context; 153 tests / 18 files | LOCAL ✓ (6 November 2026) |
| Public-repo secret scan and small commits | Gitleaks current branch history; local commit size audit | LOCAL ✓; all new commits <= 1,000 changed lines |

Dependency audit still reports 28 transitive advisories (12 moderate, 16 high).
The SDK dependency graph needs a compatible remediation pass before production;
passing builds do not clear those advisories. An independent manual review found
write-quota fairness and transport-rate-limit hardening still needed before live rollout.
Code review: skipped (ce-code-review unavailable) — native review dispatch was unavailable;
a separate Claude CLI context completed a manual integration review instead.
