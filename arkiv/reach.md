# Reach

## Who Swipr is for

- People who encounter trading calls in chats or social feeds and want to inspect a trader before committing funds.
- Traders who want public seats or wallet-specific invitations for friends.
- Bot builders who want a profile, social discovery and REST/MCP integration without building a separate copy-trading interface.

Following is a social relationship; a Copy Pass and its trading permission are separate. Ghost copying lets someone inspect a hypothetical outcome first. Trader and copier leaderboards show both sides of a strategy's results, with percentage/absolute sorting and a Following filter.

## What people can try today

[Open Swipr](https://swipr-web.onrender.com), browse the trader directory, inspect ENS identities and sign in through Privy to create wallet-owned records. A user can save a following list or ghost, reload or change browsers, and read it back from Arkiv. Real trading requires Base funds and explicit wallet authorization.

External bots can prepare proposals through the [REST/MCP interface](../backend/bots/bridge.ts). A proposal is not a fill, and self-written performance does not enter the real leaderboards.

## Evidence, without counting team tests as adoption

The documented rehearsal uses these team-controlled accounts:

| Account | Public wallet | Evidence |
| --- | --- | --- |
| Trader | `0x11d7a223c96045b9B4C90d5907246cf86437F105` | Three native wallet-owned profile entities returned by the README query on 2026-11-07 |
| Copier | `0xd5Dda1882302b3496922D1858C4386FE0eC3244d` | Confirmed copied entry and closing sale linked in the README |

The [onchain evidence table](../README.md#confirmed-onchain-demo-evidence) links a real 5 USDC trader entry, a 5 USDC automatic copier entry and a reviewed closing sale. This is funded rehearsal evidence, not an organic user count, profitable track record or external bot adoption claim.

We have not established a measured external-user cohort or external project integration. We do not count the three test profiles as three customers, and the research notes' proposed league, referrals and outreach targets are not presented as results.

## After Mumbai

The next product validation is a small external trader/copier trial: measure distinct non-team wallets that own a profile, save a ghost, join a pass and complete a confirmed copy. Count each stage separately and disclose any sponsored funds. Bot developers are a second audience to test through the existing REST/MCP interface.

Priorities for further work are richer verified-history attribution, rehearsing automatic exits and positive-profit settlement, and making independent clients easier to build. These are plans; no uptime commitment, user count or completed outreach is implied.
