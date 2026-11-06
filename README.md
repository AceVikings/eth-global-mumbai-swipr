# Swipr 🔥: Tinder for copy trading

**Design:** [Visual guide & 12 screen concepts](design/visual-guide.html) · [Implementation handoff](design/VISUAL-GUIDE.md)

**Swipe right to ghost-copy a trader for free. Super Like to copy for real: at the trader's price or not at all, and out when they're out.**

| Tinder | Swipr |
|---|---|
| Profile | **Trader card**: ENS avatar, bio, tags, "Copiers kept +3.1% after all fees", "🔒 14 sealed fills · 0 exits outside Swipr", "3 of 20 seats left" |
| ✓ Verified badge | **ENS name + sealed Arkiv history**: current truth in ENS, complete history in Arkiv |
| Swipe left | Pass |
| Swipe right | **👻 Ghost copy**: free, instant, no wallet. From the swipe on, every real trade the trader makes is mirrored into a labelled ghost portfolio from their sealed fills and real Flash quotes: *"If you'd copied Alice since 14:02: +$0.62 on $10/trade · 3 trades"* (ghost · not executed) |
| ⭐ Super Like | **Make it real**: a seat request to the trader |
| It's a match 🔥 | The trader's match policy accepts (limited seats); the match screen is your **Copy Pass** |
| Notifications | "Alice just bought ETH · Copy $10 at her price? · 14:52 left" → one tap (**tap-copy**, default; **⚡ auto-copy** is a toggle) |
| Unmatch | **💔 Break up & cash out** |

**Why it's safe to match:**
- **Same price or no trade.** When a trader buys, their order and every copy go to **Definitive Flash** together as **limit orders at one shared price**. A copy fills at the trader's price or better, or doesn't fill and **pays nothing**.
- **Copiers exit with the trader, at the same price, by construction.** A Swipr sell is a fan-out too: the trader's sell and every open copy's sell go to Flash as limits at **one shared exit price**; the ticket can't sell her position without the copies. TP/SL brackets are identical on every copy and held by Flash keepers. Every pass grants a one-time **exit-only key** (a Privy signer that can only sell the copied asset into USDC in your own wallet, never buy), so exits need no tap. If the asset leaves her wallet any other way, a **balance watch** sells every open copy at once and seals "exited outside Swipr" on her card.

> **Where the data lives:** **ENSv2** holds each trader's *current* state (profile, mandate, profit share, position, latest stats snapshot), verifiable by any wallet resolving `alice.swipr.eth`. **Arkiv** holds the *full history*: every trade, exit, copy, ghost, settlement and hourly stats snapshot (sealed), archived to Swarm.

**Fast path, live in the demo:** Alice's call unfurls on X as *"Alice bought ETH at $3,412.50 · Copy $10 at her price · 14:58 left"* → tap → her card → swipe right (👻) → **⭐ Make it real** → match → **"Copied at $3,412.50 · 🛡 stop held by Flash"**, inside her 15-minute window (Bob's login and funding happen before the take, disclosed). Miss it, or the price runs: nothing fills, nothing is charged.

**The Copy Pass:** *$10 per trade · up to 5 trades ($50 max) · ends in 7 days · breaks up if you're down $10 from your best*. Every copy carries a **safety-net stop held by Flash's keepers**, so it works while you're offline. Copies land in **your own wallet** as real Flash orders on Base; Swipr never holds funds.

> **First run:** open `<DEMO_URL>`, a **trade link** or the **QR** at our table, **no wallet**: swipe and ghost (local until login) → email login (Privy) → **add $10** (card or USDC on Base; **⛽ gas on us**) → match → tap-copy. Costs shown before you tap ("~$0.07 per $10 copy, in and out · Alice takes 5% of profit, only when you're up").
>
> **Live demo:** `<DEMO_URL>` · **Swarm build (no Swipr servers):** `<BEE_GATEWAY_URL>/bzz/<APP_REF>/` · **Video:** `<VIDEO_URL>` (on X tagging @DefinitiveFi, and the Definitive Discord) · **Repo:** public, [MIT](LICENSE) · [DEMO.md](DEMO.md) (2:45) · [SPEC.md](SPEC.md) · [/arkiv](arkiv/)

## Problem → Swipr

| Copy trading today | Swipr |
|---|---|
| Followers pay worse prices (one study: 97% of leaders green, 43.6% of follower outcomes) | **Same price or no trade:** one shared limit price; a late tap fills at it or not at all. |
| Leaders dump on followers | **Copiers exit with the trader, by construction:** shared exit fan-out, identical brackets, a no-buy exit key, a balance watch. |
| You risk money to find out if a trader is any good | **👻 Ghost copy** on swipe right: what copying would have done, from real sealed fills, free and labelled "not executed". |
| "How do I get out?" | **💔 Unmatch**: one tap cancels, sells into USDC, settles, ends the pass; the **breakup stop** does it at −$10 from your best. |
| Hidden fees, fake records | Live `/quote` cost line; profit share only above a high-water mark; stats from real fills, sealed hourly; ranked by what **copiers kept after fees** (ghosts never count). |
| Calls on X are screenshots | **Every trade is a link** (`/t/<tradeKey>`) that unfurls with a live countdown and opens the trader's card. |
| Agents are black boxes | **Agent Charter on ENS:** owner-only mandate, guardian-only halt; a prompt-injected agent raising its own limit gets an **onchain revert**. |

## How it works

```
Bob:    X post / link / QR → /t/<tradeKey> (no wallet, live countdown) → Alice's card
          → swipe right → 👻 swipr.ghost.v1 (local until login; then Bob-owned, 7 d)
          → ⭐ Make it real → email login → add $10 (⛽ gas on us) → seat request (swipr.swipe dir=2)
          → Alice's match key checks swipr.matchPolicy + seats → registers bob.alice.swipr.eth (Sepolia)
          → "It's a match 🔥 · seat 18/20" → Copy Pass: USDC approve = $50 · Arkiv swipr.follow (7 d)
             + one-time exit-only Privy signer (sells WETH/cbBTC → USDC to Bob only; auto-copy adds entries)
Alice:  ticket (or her agent via Swipr's Flash proxy/MCP) → BUY ETH ≤ shared price P (quote + 0.1%), TP/SL
          ├─ one fan-out: Alice's limit + every auto-copy limit at P, identical brackets, sent together
          ├─ tap-copy passes: push "Copy $10 at P? 14:52 left" → one tap signs a limit at P
          ├─ unfilled at window end (15 min) → "No trade · $0"
          ├─ Arkiv: sealed swipr.trade (notary), swipr.signal (copy window), swipr.copy (follower-owned)
          └─ share link /t/<tradeKey> → X via @swipr_trades + the trader's own post; Swarm receipts
Exit:   Alice's Close → one fan-out: her sell + every open copy's sell at one exit price E (exit-only keys)
        brackets → fire for everyone at the same triggers (Flash keepers)
        asset leaves Alice's wallet outside Swipr → balance watch → exits for every open copy
        → sealed swipr.exit.v1 {mode: fanout | bracket | outside-watch}
Bob:    💔 break up & cash out (or breakup stop) → cancels + sell + one settlement + pass ends
Scorekeeper (hourly) → sealed swipr.statsnap (Arkiv) → ENS swipr.stats (current snapshot)
```

**Matching** ([SPEC §3](SPEC.md#3-matching-algorithm)): one indexed Arkiv query; `score = 0.40·fit + 0.30·quality + 0.15·trust + 0.15·fresh`, quality = copier PnL **net of all fees** (real copies only), shrunk by trade count; exits outside Swipr cut trust. Runs in the browser on public data (⌘ Query drawer).

## Sponsor integrations

### Definitive Flash: same price in, same price out (Base mainnet ⚠️ no testnet, so trades are $10–25)

**One trader order + N copies at one limit price, in and out**, each signed for its follower's own wallet (`funderAddress`). Rules: [SPEC §4](SPEC.md#4-mirror-engine-flash-base-mainnet).

| Trader does | Copiers get |
|---|---|
| Buy now (a limit at quote + 0.1%) + `attachedBracket` | A limit at the **same price**, identical TP/SL; auto-copy in the same fan-out, tap-copy within the 15-min window |
| Resting `limit` | The identical limit |
| DCA (`twap`) | One limit at the trader's **final average fill** once the TWAP completes |
| Cancel | **Cancel cascade** to every mirrored resting entry |
| Close | **Exit fan-out**: limit sells at **one exit price** for her and every open copy, signed by each copier's exit-only key; a copy left unfilled after hers fills is re-sent as a market sell |
| Sells outside Swipr | **Balance watch** → exits for every open copy within seconds; "exited outside Swipr" sealed |

- **Safety net** (every copy): the trader's stop, or the follower's −5% if hers is absent or wider (a copy can leave earlier, never later); `maxPriceImpact` 5% (Flash default 50%).
- **Unfilled costs nothing** (Flash docs): out-of-bounds orders revert with no funds moved; unfilled limits expire; fees come from output. Quote sessions expire (~120 s; REST TTL unpublished), so every tap **re-quotes before signing**.
- **💔 Unmatch:** cancel entries + bracket ids (cancelling an entry never cancels its pair) + sell the pass's holdings + one profit-share transfer.
- **Profit share** 0–10% (default 5%, trader-only ENS `swipr.profitShare`), on profit above a high-water mark, in USDC on Base, nothing on losses. Settled once per pass (break-up, cash-out or pass end); under $0.05 is waived.
- **Swipr's cut:** `flashIntegratorFeeBps: "25"` on every copy order; a live counter sums real `integratorFeeNotional`.
- **Open notary: "seal any Base fill"** ([SPEC §4.8](SPEC.md#48-open-notary-seal-any-base-fill)): after a signed `swipr.optin.v1`, **every** qualifying swap of that wallet is sealed (no cherry-picking); REST or MCP **`swipr_seal_fill`**. Badges "⚡ Flash-native" / "🔌 external"; copies are ordinary Flash orders, and their exits follow the watch. Pitched to the other Flash teams ([reach.md](arkiv/reach.md)).
- **Agents** trade via **Swipr's Flash proxy** (REST or MCP with `@definitive-fi/flash-mcp`'s tools); a halted agent's order fills, **every copy is skipped** with the ENS reason; agent wallets are balance-watched.

### ENSv2: matched passes, forever traders, chartered agents (Sepolia; [SPEC §6](SPEC.md#6-ensv2-design-sepolia))

- **Own registry and resolver per trader and agent** (EAC grants are per resolver); agents are sub-names: `momo.alice.swipr.eth`.
- **Copy Pass = name, minted by the match.** `bob.alice.swipr.eth` is registered in Alice's registry by **Alice's match key** (REGISTRAR + RENEW on R_alice, applying her owner-only `swipr.matchPolicy` and `swipr.seats`; she can revoke the key or match by hand). Bob owns it, **Alice holds `ROLE_UNREGISTER`**, it is **non-transferable** and **expires with the pass**; the engine checks `getState`/`getExpiry` before every entry.
- **The verified badge.** A trader card's ✓ is the ENS name resolving to the wallet whose sealed Arkiv history the card shows.
- **Forever trader names.** At H12 `swipr.eth`'s registry is **emancipated** (ops keeps only REGISTRAR + RENEW). **"Forever ✓"** = three live reads, incl. `VerifiableFactory.verifyContract` = UserRegistryImpl `0x9bd8…366a`; a mined `ops.unregister(alice)` reverts `EACUnauthorizedAccountRoles(…, ROLE_UNREGISTER, ops)`.
- **Agent Charter:** the owner alone writes `swipr.mandate`, `swipr.matchPolicy`, `swipr.profitShare`; the agent key only `agent-context` and `swipr.thesis`; `guardian.momo.alice.swipr.eth` only `swipr.halt`. The engine applies **mandate ∧ ¬halt** before every fan-out; a prompt-injected momo's mandate write is **mined with status 0**.
- **ERC-8004 + ENSIP-25:** each agent registered on Sepolia IdentityRegistry `0x8004A818…BD9e` by its owner; badge verified both ways. ENSIP-25/26 are drafts.
- **ENS drives execution:** `alice.swipr.eth`'s Base address (coinType `0x80000000|8453`) is her Flash funder, the balance-watched wallet and the profit-share recipient.
- **Verified:** 113/113 checks on a fresh Sepolia fork (core 65 + charter 22 + forever 19 + ERC-8004/ENSIP-25 7; `scripts/ens-fork-verify/run.sh`).

### Arkiv: sealed records, exits, ghosts, passes (rabdi; [/arkiv](arkiv/))

- **19 schemas, one `project = 'swipr-mumbai26'` tag**, published as `packages/swipr-schema` ([schema.md](arkiv/schema.md)).
- **Sealed trades and exits:** `readonly`, notary-owned, so traders can't delete losers ("🔒 42 sealed · 0 deleted · 0 exits outside Swipr"). Each `swipr.exit.v1` lists every copy's exit fill, so anyone can check that copiers left with the trader.
- **Sealed hourly stats snapshots** (`swipr.statsnap.v1`): ENS `swipr.stats` points at the newest; the trader page charts all.
- **👻 Ghosts are user-owned:** `swipr.ghost.v1` (7 d) holds only `{trader, since, perTrade}`; the ghost PnL is recomputed by anyone from sealed trades and exits. Every logged-in visitor becomes a wallet-owned Arkiv writer.
- **Expiry as a deadline:** copy windows, ghosts, passes, the **Mumbai Trader League** (closing bell).
- **Users own their data:** passes, copies, ghosts, breakups, swipes, opt-ins and referrals are created by the relayer then `changeOwnership`'d; a 0.05 tGLM drip lets users sign their own deletes and renewals.
- **Don't trust our scorekeeper:** `verify-stats.mjs --publish` recomputes PnL and writes `swipr.audit.v1` from your wallet.

**Run this query** (rabdi JSON-RPC, no key; syntax checked against the live RPC 2026-11-05): verified traders with risk ≤ 3.
```bash
curl -s https://rpc.rabdi.db-chain.testnet.arkiv.network -H 'content-type: application/json' -d '{
 "jsonrpc":"2.0","id":1,"method":"arkiv_query",
 "params":["arkiv.schema = str('"'"'swipr.trader.v1'"'"') AND project = str('"'"'swipr-mumbai26'"'"') AND riskScore <= i32(3) AND $creator = addr(<SCOREKEEPER_ADDRESS>)"]}'
```
Judge proxy: `<DEMO_URL>/api/public/query?q=…`. Writers (filled by `pnpm proofs`): relayer `<RELAYER_ADDRESS>`, reserve `<RESERVE_ADDRESS>`, notary `<NOTARY_ADDRESS>`, scorekeeper `<SCOREKEEPER_ADDRESS>`. Costs and repros: [friction.md](arkiv/friction.md).

### Swarm: the permanent archive and a front end Swipr can't take down (Sepolia testnet; [swarm.md](arkiv/swarm.md))

- **Permanent archive.** Hourly trades, exits, copies and stats snapshots + a `MANIFEST.json` (root = `proofRoot`), pointed to by a readonly `swipr.archive.v1` that links the previous one: a hash chain. `verify-stats.mjs --from-swarm` needs no Arkiv and no Swipr.
- **The spectator app is on Swarm** (`swipr.eth` contenthash): deck, ghosts, trader pages, archive and pass management read Arkiv and ENS from the browser; copying there is bring-your-own Flash key. It opens from **our two testnet gateways**, **BMT-verified in the browser**: a gateway can be offline, never lie.
- **Also:** receipts, followers-only theses (per-pass envelopes; no encrypted ref on Arkiv), per-trader feeds read by `@swipr_trades` and `trader-ticker.mjs`.

## Deployments & proofs (written by `pnpm proofs` at H6, re-run at H12, H24, H30)

| What | Value |
|---|---|
| `swipr.eth` R_root / P_root; H12 emancipation + rehearsal; mined `ops.unregister(alice)` revert | Sepolia txs (revert: status 0) |
| Alice P/R; match-key grant; `bob.alice.swipr.eth` register tx (from Alice's match key); momo P/R | `0x…`; sepolia.app.ens.domains |
| ENS fork checks | 113/113 + H0 match-key check |
| momo charter: mandate, mined mandate revert, guardian halt, skipped copies | Sepolia txs + Basescan fill |
| ERC-8004 registrations | Sepolia txs + erc-8004.quicknode.com |
| Hour-1 Privy → Flash gate | PASS/FAIL: ALLOW entry fill, ALLOW exit-only sell, DENY exit-only buy + 3 DENY cases, USDC allowlist |
| Shared-price trade: Alice's fill + copies at the same price; an unfilled copy (cost $0) | Flash ids + Basescan |
| Exit fan-out (Alice + copies at one exit price); bracket fill; outside-Swipr watch drill | Flash ids + Basescan + `swipr.exit.v1` |
| Safety-net trigger fill; breakup & cash-out (cancel, bracket cancel, sell, settlement) | Flash ids + Basescan |
| Open notary: opt-ins, external sealed trades, a filled copy of one | Arkiv entities + Basescan |
| Hourly `swipr.statsnap.v1` count; ENS `swipr.stats` → newest snapshot key | query + Sepolia record |
| Fan-out p50/p95 (N = 2, 10), entries and exits; Flash fill latency; watch → exit latency | measured |
| Sealed trades / notary deletions / exits outside Swipr / ghosts | count / 0 / count / count, with the query |
| Swarm batch, app ref, latest archive ref, 2 gateway links each | [swarm.md](arkiv/swarm.md) |
| Reach by channel + external projects + Mumbai League (H12/H24/H30) | [reach.md](arkiv/reach.md); _targets until filled_ |

## Networks (testnet everywhere except Flash)

| Piece | Network | Note |
|---|---|---|
| Flash orders | Base mainnet | ⚠️ Flash has no testnet |
| ENSv2, ERC-8004 | Sepolia | Agents' EOAs also trade on Base |
| Arkiv | rabdi testnet | As the prize requires |
| Swarm | Sepolia testnet (own Bee node + sBZZ batch) | Public gateways can't serve testnet content → our two gateways + in-browser BMT check |

**Stack:** Next.js PWA (+ static Swarm build), viem/wagmi · Privy (embedded EOA, signers/policies; gas sponsorship off: Flash rejects EIP-7702) · `@arkiv-network/sdk@1.0.1` · `@ethersphere/bee-js`, `@noble/*` · ENSv2 `contracts-v2` · ERC-8004 · Flash REST + WebSocket, `@definitive-fi/flash-mcp` · OG images (`@vercel/og`)

## Run it

```bash
cp .env.example .env && pnpm i && pnpm dev           # web :3000
pnpm worker                                          # engine + exit watch + scorekeeper + notary + matcher + agent proxy
pnpm agent momo                                      # owner-run agent template
node scripts/flash-verify/verify.mjs                 # live quotes: market, limit, TWAP, SL, TP, bracket
node scripts/trader-ticker.mjs                       # third-party Arkiv + ENS + Swarm-feed reader
node scripts/verify-stats.mjs <trader> [--publish | --from-swarm]
node scripts/seal-fill.mjs <baseTxHash>               # open notary: opt in + seal (or MCP swipr_seal_fill)
node scripts/verify-swarm-ref.mjs <ref>              # re-hash any Swarm artifact from any Bee node
node scripts/reach-count.mjs                         # external wallets (team excluded)
pnpm swarm:demo && pnpm swarm:app                    # one upload/read; build + upload the static app
bash scripts/ens-fork-verify/run.sh                  # ENSv2 + ERC-8004 fork checks
```
Today the repo holds the specs, `scripts/flash-verify` and `scripts/ens-fork-verify` ([FINDINGS](scripts/ens-fork-verify/FINDINGS.md)); everything else is built during the event ([SPEC §10](SPEC.md#10-build-plan-36-h-34-people)). `<…>` placeholders are filled by `pnpm proofs` or at submission.

## What's real (honesty labels)

- **No mocks.** Every card, stat, copy, pass, fee and exit is real Flash, Arkiv, ENS or Swarm data.
- **"Same price" means the shared limit price or better.** A copy never fills worse than P; an unfilled copy is shown as "No trade · $0", never hidden. **Exits:** at the shared exit price or better; a copy still unfilled once the trader's sell fills is market-sold right after (labelled "after Alice"). Outside-Swipr exits are seconds behind the trader, at the market.
- **👻 Ghosts are estimates, not promises:** computed from the trader's real sealed fills and real Flash quotes, assuming the copy would have filled at the shared price; always labelled "ghost · not executed"; never in rankings or copier stats.
- **Track records are real trading from H6** by team members and invited hackers (labelled); "since inception · Xh".
- **Labelled drills:** the guardian's on-camera halt and the "exited outside Swipr" record come from manual drills (real txs); the prompt-injection prompt is scripted, with the tool-call trace shown.
- **Default size:** $10 per copy ($5 minimum). At 5%, a fee clears the $0.05 floor at ≥ $1.00 net profit (Carol's +$1.20 → $0.06). Flash's minimum notional is **unpublished**; live quotes: $5 ≈ 2% all-in, $10 ≈ 0.25% before Swipr's fee; booth confirms in H0.
- **External traders:** decoded from Base, badged "🔌 external", counted from the opt-in block; if no team opts in by H30, a teammate's non-Flash swap, labelled.
- **Notary and scorekeeper are team keys:** "sealed" = nobody edits; notary deletions are counted and detectable against the Swarm hash chain; `verify-stats.mjs` recomputes everything.
- **Funding:** card on-ramp checked in H0; QR USDC-on-Base always works. "Gas on us" is a ~$0.03 ETH transfer per new wallet, not sponsorship.
- **Sponsored and prize usage is disclosed:** ≤ 15 funded $5 starter copies and League prizes are listed separately; team wallets are excluded from every reach number.
- **Privy fallback:** if the hour-1 gate fails, auto-copy doesn't ship; brackets still exit everyone together and closes fall back to a "close yours?" push ([SPEC §4.3](SPEC.md#43-copiers-exit-with-the-trader)).
- **Off camera:** [DEMO.md](DEMO.md#verified-off-camera).

## AI usage (per ETHGlobal rules)

Claude Code and opencode helped with research, the spec and scaffolding; AI judges scored these docs; the team reviewed all contract interactions and decisions. Alice's `momo` uses an LLM she chose; other agents and guardians are rule-based. Swipr runs no agents.

## Team

`<TEAM>`
