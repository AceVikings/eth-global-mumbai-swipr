# Why Arkiv

Swipr uses Arkiv Rabdi as its application database. The concrete user benefit is ownership of profiles, following lists, ghost settings, invitations and Copy Pass records by the wallets using the app.

## What users would lose with an ordinary server database

1. **Protocol-enforced edit and delete authority.** Native `$owner` controls records. The application checks it rather than trusting an editable `owner` field inside JSON. The wallet signs creates, patches and deletes. A centralized database could reproduce the interface, but authority would depend entirely on the server's access rules.
2. **A social graph another client can read.** Public entities have indexed project/schema attributes and native wallet ownership. Another client can query the same records without receiving a Swipr database export or using our API. See the working [README query](../README.md#arkiv-the-applications-database-with-wallet-ownership).
3. **Wallet continuity across browsers.** A signed-in user restores their following list and ghost configuration from Arkiv. The browser's local storage is not the authority for those records.
4. **Storage lifetimes that are explicit.** Profiles/social lists start at 30 days; passes/invitations at 90 days; operational events at 180 days. Business deadlines are checked separately: an entity's storage lifetime is not automatically the trading authorization's duration.

## Execution accounting also reads Arkiv

The service-owned execution journal restores reservations, submission outcomes and pass accounting. It validates creator, owner, readonly flags, expiration and revision order before accepting history. Unknown submissions retain their reservation rather than releasing budget and risking a duplicate order.

This is an operational integrity mechanism, not a claim of fully trustless execution. The service writer remains an authority, readonly entities can still be deleted by their owner, and incomplete history blocks operation. The shipped application does not have an independent permanent trade archive.

## What stays elsewhere, and why

| Data | Location | Reason |
| --- | --- | --- |
| Private keys, access keys and session credentials | Wallet/Privy and private backend configuration | Arkiv entities are public |
| Signer policies | Privy | Enforce the delegated signing boundary |
| Fresh quotes and submitted orders | Definitive Flash | Execution and order lifecycle belong to the execution provider |
| Confirmed token movements | Base | Chain receipts establish fills independently of profile claims |
| Profile image bytes | Swarm | Content-addressed files referenced by Arkiv profiles |
| Current identity/profile/statistics snapshot | ENSv2 Sepolia | Other applications can resolve the same identity and records |

**Source:** [schemas](../backend/contracts/wallet-profile.ts), [wallet writes](../frontend/src/lib/arkiv.ts), [ghosts](../frontend/src/lib/wallet-ghosts.ts), [journal](../backend/arkiv-journal.ts), [account deletion](../backend/account.ts).
